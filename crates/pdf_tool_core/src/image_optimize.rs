//! Custom image optimization used by the lossy compression presets.
//!
//! The input is a qpdf QDF staging file (`--qdf --object-streams=disable
//! --decode-level=generalized`), where every stream is stored uncompressed
//! with a direct `/Length`. That makes the file safe to rewrite in place:
//!
//! 1. Walk all objects and remember dict/stream byte ranges.
//! 2. Find JPEG (`/DCTDecode`) image XObjects that are safe to touch:
//!    8-bit `/DeviceRGB` or `/DeviceGray`, no masks, no decode parameters.
//! 3. Scan page and form content streams to recover the CTM in effect when
//!    each image is drawn, giving the image's *effective DPI* per placement.
//!    An image's deciding DPI is the maximum across all placements.
//! 4. Images whose effective DPI exceeds the preset trigger are decoded,
//!    resampled with Lanczos to the target DPI, re-encoded as JPEG, and
//!    spliced back with updated `/Length`, `/Width`, and `/Height`.
//!
//! Everything else (JPX, JBIG2, CCITT, flate images, masks, soft masks) is
//! left untouched on purpose; the subsequent qpdf pass handles structural
//! optimization and flate-to-JPEG conversion.

use crate::PdfToolError;
use image::imageops::FilterType;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::ops::Range;
use std::path::Path;

#[derive(Debug, Clone, Copy)]
pub struct ImageOptimizeSettings {
    /// Images are resampled so their effective resolution lands on this DPI.
    pub target_dpi: f64,
    /// Only resample when the effective resolution exceeds this DPI.
    pub trigger_dpi: f64,
    /// JPEG quality used when re-encoding resampled images.
    pub jpeg_quality: u8,
}

const IDENTITY_CTM: [f64; 6] = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
const MAX_FORM_DEPTH: usize = 8;

pub fn downsample_dct_images(
    qdf_path: &Path,
    settings: &ImageOptimizeSettings,
) -> Result<usize, PdfToolError> {
    let mut document = QdfDocument::load(qdf_path)?;
    let images = document.find_dct_image_objects();
    if images.is_empty() {
        return Ok(0);
    }

    let mut effective: HashMap<u32, f64> = HashMap::new();
    for page in document.page_numbers() {
        let Some(resources) = document.resolve_resources(page) else {
            continue;
        };
        let Some(contents) = document.page_contents(page) else {
            continue;
        };
        if contents.is_empty() {
            continue;
        }
        Scanner {
            document: &document,
            images: &images,
            effective: &mut effective,
            visited: HashSet::new(),
        }
        .scan(&contents, IDENTITY_CTM, Some(resources), 0);
    }

    let mut edits: Vec<Edit> = Vec::new();
    let mut changed = 0usize;
    for (number, effective_dpi) in &effective {
        if *effective_dpi < settings.trigger_dpi {
            continue;
        }
        let Some(&(dict_width, _dict_height)) = images.get(number) else {
            continue;
        };
        let Some(entry) = document.objects.get(number) else {
            continue;
        };
        let Some(stream_range) = entry.stream.clone() else {
            continue;
        };
        let dict_range = entry.dict.clone();
        let Some(decoded) = image::load_from_memory(&document.data[stream_range.clone()])
            .ok()
            .filter(|decoded| decoded.width() == dict_width)
        else {
            continue;
        };

        let factor = (settings.target_dpi / *effective_dpi).min(1.0);
        let new_width = downsampled_dimension(decoded.width(), factor);
        let new_height = downsampled_dimension(decoded.height(), factor);
        if new_width >= decoded.width() && new_height >= decoded.height() {
            continue;
        }

        let resized = decoded.resize_exact(new_width, new_height, FilterType::Lanczos3);
        let mut encoded = Vec::new();
        let mut encoder =
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded, settings.jpeg_quality);
        if encoder.encode_image(&resized).is_err() {
            continue;
        }
        if encoded.len() >= stream_range.len() {
            continue;
        }

        let encoded_length = encoded.len() as i64;
        let dict = &document.data[dict_range.clone()];
        // QDF streams carry indirect lengths: patch the number object that
        // holds the length instead of the image dict.
        let indirect_length_edit = match dict_value(dict, b"/Length") {
            Some(DictValue::Ref(number)) => document.objects.get(&number).map(|length_entry| Edit {
                range: length_entry.dict.clone(),
                replacement: format!("{encoded_length}\n").into_bytes(),
            }),
            _ => None,
        };
        edits.push(Edit {
            range: stream_range,
            replacement: encoded,
        });
        edits.push(int_edit(dict, dict_range.start, b"/Width", new_width as i64));
        edits.push(int_edit(
            dict,
            dict_range.start,
            b"/Height",
            new_height as i64,
        ));
        edits.push(indirect_length_edit.unwrap_or_else(|| {
            int_edit(dict, dict_range.start, b"/Length", encoded_length)
        }));
        changed += 1;
    }

    if changed > 0 {
        document.apply(edits);
        fs::write(qdf_path, document.data)?;
    }
    Ok(changed)
}

fn downsampled_dimension(current: u32, factor: f64) -> u32 {
    let next = (current as f64 * factor).round() as i64;
    next.clamp(32, i64::from(current)) as u32
}

struct Edit {
    range: Range<usize>,
    replacement: Vec<u8>,
}

fn int_edit(dict: &[u8], dict_offset: usize, key: &[u8], value: i64) -> Edit {
    let key_at = find_key(dict, key).expect("verified key must exist in dict");
    let mut cursor = key_at + key.len();
    while cursor < dict.len() && is_ws(dict[cursor]) {
        cursor += 1;
    }
    let start = cursor;
    if matches!(dict.get(cursor), Some(b'+') | Some(b'-')) {
        cursor += 1;
    }
    while matches!(dict.get(cursor), Some(b) if b.is_ascii_digit()) {
        cursor += 1;
    }
    Edit {
        range: dict_offset + start..dict_offset + cursor,
        replacement: value.to_string().into_bytes(),
    }
}

// ---------------------------------------------------------------------------
// QDF document model
// ---------------------------------------------------------------------------

struct QdfDocument {
    data: Vec<u8>,
    objects: BTreeMap<u32, ObjectEntry>,
}

struct ObjectEntry {
    dict: Range<usize>,
    stream: Option<Range<usize>>,
    /// Start of stream data (for resolving indirect lengths in a second pass).
    data_start: Option<usize>,
    /// Object number holding the stream length when `/Length N 0 R`.
    length_ref: Option<u32>,
}

impl QdfDocument {
    fn load(path: &Path) -> Result<Self, PdfToolError> {
        let data = fs::read(path)?;
        Ok(Self::load_from_bytes(data))
    }

    fn load_from_bytes(data: Vec<u8>) -> Self {
        let mut objects = BTreeMap::new();
        let mut search_from = 0usize;

        while let Some((number, _header_start, dict_start)) = next_object_header(&data, search_from)
        {
            let Some(parsed) = parse_object(&data, dict_start) else {
                // Unrecoverable layout (e.g. unreadable /Length): stop parsing
                // rather than mis-aligning on binary stream data.
                break;
            };
            objects.insert(
                number,
                ObjectEntry {
                    dict: dict_start..parsed.dict_end,
                    stream: parsed.stream,
                    data_start: parsed.data_start,
                    length_ref: parsed.length_ref,
                },
            );
            search_from = parsed.object_end;
        }

        // QDF files store stream lengths as indirect references to number
        // objects (qpdf repairs them on the next run). Resolve them now that
        // every object is indexed.
        let mut fixes = Vec::new();
        for (number, entry) in &objects {
            let Some(length_ref) = entry.length_ref else {
                continue;
            };
            let Some(length_entry) = objects.get(&length_ref) else {
                continue;
            };
            let Some(value) = first_int(&data[length_entry.dict.clone()]) else {
                continue;
            };
            if value >= 0 {
                fixes.push((*number, value as usize));
            }
        }
        for (number, length) in fixes {
            let Some(entry) = objects.get_mut(&number) else {
                continue;
            };
            let Some(data_start) = entry.data_start else {
                continue;
            };
            let end = data_start + length;
            let endstream_at = if data.len() >= end + 9 && &data[end..end + 9] == b"endstream" {
                Some(end)
            } else if data.get(end) == Some(&b'\n')
                && data.len() >= end + 10
                && &data[end + 1..end + 10] == b"endstream"
            {
                Some(end + 1)
            } else {
                None
            };
            entry.stream = endstream_at.map(|_| data_start..end);
        }

        Self { data, objects }
    }

    fn dict_of(&self, number: u32) -> Option<&[u8]> {
        self.objects
            .get(&number)
            .map(|entry| &self.data[entry.dict.clone()])
    }

    fn stream_of(&self, number: u32) -> Option<Vec<u8>> {
        self.objects
            .get(&number)
            .and_then(|entry| entry.stream.clone())
            .map(|range| self.data[range].to_vec())
    }

    /// Resolves a key to an absolute file region: inline dicts are rebased to
    /// file offsets, indirect refs are followed to the object's dict region.
    fn value_region(&self, object_number: u32, key: &[u8]) -> Option<Range<usize>> {
        let entry = self.objects.get(&object_number)?;
        let dict = &self.data[entry.dict.clone()];
        match dict_value(dict, key)? {
            DictValue::Dict(range) => {
                Some(entry.dict.start + range.start..entry.dict.start + range.end)
            }
            DictValue::Ref(number) => self.objects.get(&number).map(|e| e.dict.clone()),
            _ => None,
        }
    }

    fn find_dct_image_objects(&self) -> HashMap<u32, (u32, u32)> {
        let mut images = HashMap::new();
        for (number, entry) in &self.objects {
            let dict = &self.data[entry.dict.clone()];
            if !is_dct_image_dict(dict) {
                continue;
            }
            let (Some(width), Some(height)) = (dict_int(dict, b"/Width"), dict_int(dict, b"/Height"))
            else {
                continue;
            };
            if width <= 0 || height <= 0 {
                continue;
            }
            images.insert(*number, (width as u32, height as u32));
        }
        images
    }

    fn page_numbers(&self) -> Vec<u32> {
        self.objects
            .iter()
            .filter(|(_, entry)| {
                dict_name(&self.data[entry.dict.clone()], b"/Type")
                    .map_or(false, |name| name == b"Page")
            })
            .map(|(number, _)| *number)
            .collect()
    }

    /// Resolves a page's resource region, walking /Parent chains for
    /// inherited resources.
    fn resolve_resources(&self, page_number: u32) -> Option<Range<usize>> {
        let mut current = page_number;
        for _ in 0..16 {
            match self.value_region(current, b"/Resources") {
                Some(region) => return Some(region),
                None => {
                    let dict = self.dict_of(current)?;
                    match dict_value(dict, b"/Parent")? {
                        DictValue::Ref(parent) => current = parent,
                        _ => return None,
                    }
                }
            }
        }
        None
    }

    /// Concatenated content stream bytes for a page.
    fn page_contents(&self, page_number: u32) -> Option<Vec<u8>> {
        let entry = self.objects.get(&page_number)?;
        let dict = &self.data[entry.dict.clone()];
        let mut contents = Vec::new();
        match dict_value(dict, b"/Contents")? {
            DictValue::Ref(number) => contents.extend(self.stream_of(number)?),
            DictValue::Array(range) => {
                for number in refs_in_range(&dict[range]) {
                    contents.extend(self.stream_of(number)?);
                }
            }
            _ => return None,
        }
        Some(contents)
    }

    /// Parses `/XObject << /Name N 0 R ... >>` out of a resources region.
    fn parse_xobject_refs(&self, resources: &Range<usize>) -> Vec<(Vec<u8>, u32)> {
        let region = &self.data[resources.clone()];
        let value = match dict_value(region, b"/XObject") {
            Some(value) => value,
            None => return Vec::new(),
        };
        let sub_dict: &[u8] = match value {
            DictValue::Dict(range) => &region[range],
            DictValue::Ref(number) => match self.dict_of(number) {
                Some(dict) => dict,
                None => return Vec::new(),
            },
            _ => return Vec::new(),
        };
        name_ref_pairs(sub_dict)
    }

    fn apply(&mut self, mut edits: Vec<Edit>) {
        edits.sort_by_key(|edit| std::cmp::Reverse(edit.range.start));
        let mut last_start = usize::MAX;
        for edit in edits {
            if edit.range.end > last_start {
                continue;
            }
            self.data
                .splice(edit.range.start..edit.range.end, edit.replacement);
            last_start = edit.range.start;
        }
    }
}

struct ParsedObject {
    dict_end: usize,
    stream: Option<Range<usize>>,
    data_start: Option<usize>,
    length_ref: Option<u32>,
    object_end: usize,
}

fn parse_object(data: &[u8], dict_start: usize) -> Option<ParsedObject> {
    let stream_at = find_delimited_keyword(data, dict_start, b"stream");
    let endobj_at = find_keyword(data, dict_start, b"endobj");

    match (stream_at, endobj_at) {
        (Some(stream), Some(endobj)) if endobj < stream => Some(ParsedObject {
            dict_end: endobj,
            stream: None,
            data_start: None,
            length_ref: None,
            object_end: endobj + b"endobj".len(),
        }),
        (Some(stream), _) => {
            let dict_end = stream;
            let dict = &data[dict_start..dict_end];
            // Skip "stream" plus the line break before the data.
            let mut data_start = stream + b"stream".len();
            while data_start < data.len() && is_ws(data[data_start]) {
                data_start += 1;
            }

            match dict_value(dict, b"/Length") {
                Some(DictValue::Number(length)) if length >= 0 => {
                    let data_end = data_start + length as usize;
                    if data_end > data.len() {
                        return None;
                    }
                    let endstream = find_keyword(data, data_end, b"endstream")?;
                    let endobj = find_keyword(data, endstream, b"endobj")?;
                    Some(ParsedObject {
                        dict_end,
                        stream: Some(data_start..data_end),
                        data_start: Some(data_start),
                        length_ref: None,
                        object_end: endobj + b"endobj".len(),
                    })
                }
                Some(DictValue::Ref(number)) => {
                    // QDF files: /Length points at a number object written
                    // after the stream. Use the first endstream as a
                    // provisional end and fix the range after the full parse.
                    let endstream = find_keyword(data, data_start, b"endstream")?;
                    let endobj = find_keyword(data, endstream, b"endobj")?;
                    Some(ParsedObject {
                        dict_end,
                        stream: Some(data_start..endstream),
                        data_start: Some(data_start),
                        length_ref: Some(number),
                        object_end: endobj + b"endobj".len(),
                    })
                }
                _ => None,
            }
        }
        (None, Some(endobj)) => Some(ParsedObject {
            dict_end: endobj,
            stream: None,
            data_start: None,
            length_ref: None,
            object_end: endobj + b"endobj".len(),
        }),
        (None, None) => None,
    }
}

fn first_int(bytes: &[u8]) -> Option<i64> {
    let mut cursor = 0usize;
    while cursor < bytes.len() && !bytes[cursor].is_ascii_digit() && bytes[cursor] != b'-' {
        cursor += 1;
    }
    let start = cursor;
    if cursor < bytes.len() && bytes[cursor] == b'-' {
        cursor += 1;
    }
    while cursor < bytes.len() && bytes[cursor].is_ascii_digit() {
        cursor += 1;
    }
    if cursor == start {
        return None;
    }
    std::str::from_utf8(&bytes[start..cursor]).ok()?.parse().ok()
}

/// Finds the next `N 0 obj` header and returns (number, header digit start,
/// dict start just past the "obj" keyword).
fn next_object_header(data: &[u8], from: usize) -> Option<(u32, usize, usize)> {
    let mut search_from = from;
    loop {
        let relative = find_sub(&data[search_from..], b" obj")?;
        let keyword = search_from + relative;

        let mut cursor = keyword;
        // Generation digits (backwards).
        let gen_end = cursor;
        while cursor > 0 && data[cursor - 1].is_ascii_digit() {
            cursor -= 1;
        }
        let gen_start = cursor;
        if gen_end == gen_start || cursor == 0 || !is_ws(data[cursor - 1]) {
            search_from = keyword + 4;
            continue;
        }
        cursor -= 1;
        // Object number digits (backwards).
        let number_end = cursor;
        while cursor > 0 && data[cursor - 1].is_ascii_digit() {
            cursor -= 1;
        }
        let number_start = cursor;
        if number_end == number_start || (cursor > 0 && !is_ws(data[cursor - 1])) {
            search_from = keyword + 4;
            continue;
        }

        let Ok(number) = std::str::from_utf8(&data[number_start..number_end])
            .ok()?
            .parse::<u32>()
        else {
            search_from = keyword + 4;
            continue;
        };
        let Ok(generation) = std::str::from_utf8(&data[gen_start..gen_end]) else {
            search_from = keyword + 4;
            continue;
        };
        if generation != "0" {
            search_from = keyword + 4;
            continue;
        }

        let mut dict_start = keyword + 4;
        while dict_start < data.len() && is_ws(data[dict_start]) {
            dict_start += 1;
        }
        return Some((number, number_start, dict_start));
    }
}

fn find_delimited_keyword(data: &[u8], from: usize, keyword: &[u8]) -> Option<usize> {
    let mut search_from = from;
    loop {
        let relative = find_sub(&data[search_from..], keyword)?;
        let at = search_from + relative;
        let before_ok = at > 0 && is_ws(data[at - 1]);
        let after_ok = data
            .get(at + keyword.len())
            .map_or(true, |b| is_ws(*b));
        if before_ok && after_ok {
            return Some(at);
        }
        search_from = at + 1;
    }
}

fn find_keyword(data: &[u8], from: usize, keyword: &[u8]) -> Option<usize> {
    let relative = find_sub(&data[from..], keyword)?;
    Some(from + relative)
}

fn find_sub(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn is_ws(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\r' | b'\n' | 0x0b | 0x0c | 0x00)
}

fn is_delimiter(byte: u8) -> bool {
    is_ws(byte)
        || matches!(
            byte,
            b'/' | b'<' | b'>' | b'[' | b']' | b'(' | b')' | b'{' | b'}' | b'%'
        )
}

// ---------------------------------------------------------------------------
// Dictionary parsing
// ---------------------------------------------------------------------------

enum DictValue {
    Ref(u32),
    Name(Range<usize>),
    Number(i64),
    Dict(Range<usize>),
    Array(Range<usize>),
}

fn find_key(dict: &[u8], key: &[u8]) -> Option<usize> {
    let mut search_from = 0usize;
    loop {
        let relative = find_sub(&dict[search_from..], key)?;
        let at = search_from + relative;
        let before_ok = at == 0 || is_ws(dict[at - 1]);
        let after_ok = dict
            .get(at + key.len())
            .map_or(false, |b| is_ws(*b) || *b == b'<');
        if before_ok && after_ok {
            return Some(at);
        }
        search_from = at + 1;
    }
}

fn dict_value(dict: &[u8], key: &[u8]) -> Option<DictValue> {
    let key_at = find_key(dict, key)?;
    let mut cursor = key_at + key.len();
    while cursor < dict.len() && is_ws(dict[cursor]) {
        cursor += 1;
    }
    match dict.get(cursor) {
        Some(b'<') if dict.get(cursor + 1) == Some(&b'<') => {
            let end = matching_dict_end(dict, cursor)?;
            Some(DictValue::Dict(cursor..end))
        }
        Some(b'[') => {
            let end = find_sub(&dict[cursor..], b"]")? + cursor;
            Some(DictValue::Array(cursor..end + 1))
        }
        Some(b'/') => {
            let start = cursor;
            cursor += 1;
            while cursor < dict.len() && !is_delimiter(dict[cursor]) {
                cursor += 1;
            }
            // Exclude the leading '/' so names compare without it.
            Some(DictValue::Name(start + 1..cursor))
        }
        Some(b) if b.is_ascii_digit() || *b == b'-' || *b == b'+' => {
            let start = cursor;
            while matches!(dict.get(cursor), Some(b) if b.is_ascii_digit()) {
                cursor += 1;
            }
            let number: i64 = std::str::from_utf8(&dict[start..cursor]).ok()?.parse().ok()?;
            // A reference looks like "N 0 R".
            let mut probe = cursor;
            while matches!(dict.get(probe), Some(b) if is_ws(*b)) {
                probe += 1;
            }
            if dict.get(probe) == Some(&b'0') {
                probe += 1;
                while matches!(dict.get(probe), Some(b) if is_ws(*b)) {
                    probe += 1;
                }
                if dict.get(probe) == Some(&b'R') {
                    if number >= 0 {
                        return Some(DictValue::Ref(number as u32));
                    }
                }
            }
            Some(DictValue::Number(number))
        }
        _ => None,
    }
}

fn matching_dict_end(dict: &[u8], open: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut cursor = open;
    while cursor + 1 < dict.len() {
        if dict[cursor] == b'<' && dict[cursor + 1] == b'<' {
            depth += 1;
            cursor += 2;
        } else if dict[cursor] == b'>' && dict[cursor + 1] == b'>' {
            depth -= 1;
            cursor += 2;
            if depth == 0 {
                return Some(cursor);
            }
        } else {
            cursor += 1;
        }
    }
    None
}

fn dict_int(dict: &[u8], key: &[u8]) -> Option<i64> {
    match dict_value(dict, key)? {
        DictValue::Number(value) => Some(value),
        DictValue::Name(range) => std::str::from_utf8(&dict[range])
            .ok()?
            .parse()
            .ok(),
        _ => None,
    }
}

fn dict_name<'a>(dict: &'a [u8], key: &[u8]) -> Option<&'a [u8]> {
    match dict_value(dict, key)? {
        DictValue::Name(range) => Some(&dict[range]),
        _ => None,
    }
}

fn name_ref_pairs(dict: &[u8]) -> Vec<(Vec<u8>, u32)> {
    let mut pairs = Vec::new();
    let mut cursor = 0usize;
    while let Some(relative) = find_sub(&dict[cursor..], b"/") {
        let key_start = cursor + relative;
        let mut name_end = key_start + 1;
        while name_end < dict.len() && !is_delimiter(dict[name_end]) {
            name_end += 1;
        }
        if name_end == key_start + 1 {
            cursor = key_start + 1;
            continue;
        }

        let mut probe = name_end;
        while matches!(dict.get(probe), Some(b) if is_ws(*b)) {
            probe += 1;
        }
        let number_start = probe;
        while matches!(dict.get(probe), Some(b) if b.is_ascii_digit()) {
            probe += 1;
        }
        let number = if probe > number_start {
            std::str::from_utf8(&dict[number_start..probe])
                .ok()
                .and_then(|text| text.parse().ok())
        } else {
            None
        };

        // Confirm the " 0 R" tail.
        let mut confirmed = false;
        if number.is_some() {
            while matches!(dict.get(probe), Some(b) if is_ws(*b)) {
                probe += 1;
            }
            if dict.get(probe) == Some(&b'0') {
                probe += 1;
                while matches!(dict.get(probe), Some(b) if is_ws(*b)) {
                    probe += 1;
                }
                if dict.get(probe) == Some(&b'R') {
                    confirmed = true;
                }
            }
        }

        if let (Some(number), true) = (number, confirmed) {
            // Store names without the leading '/' to match content-stream
            // tokens.
            pairs.push((dict[key_start + 1..name_end].to_vec(), number));
        }
        cursor = name_end;
    }
    pairs
}

fn refs_in_range(bytes: &[u8]) -> Vec<u32> {
    let mut refs = Vec::new();
    let mut numbers: Vec<f64> = Vec::new();
    let mut cursor = 0usize;
    while let Some(token) = next_token(bytes, &mut cursor) {
        match token {
            Token::Number(value) => {
                numbers.push(value);
                if numbers.len() > 8 {
                    numbers.clear();
                }
            }
            Token::Operator(operator) => {
                if operator == b"R" && numbers.len() >= 2 {
                    let generation = numbers[numbers.len() - 1];
                    let number = numbers[numbers.len() - 2];
                    if generation == 0.0 && number.fract() == 0.0 && number > 0.0 {
                        refs.push(number as u32);
                    }
                }
                numbers.clear();
            }
            _ => numbers.clear(),
        }
    }
    refs
}

fn is_dct_image_dict(dict: &[u8]) -> bool {
    let is_image = dict_name(dict, b"/Subtype").map_or(false, |name| name == b"Image");
    if !is_image {
        return false;
    }

    let filter_is_dct = match dict_value(dict, b"/Filter") {
        Some(DictValue::Name(range)) => &dict[range] == b"DCTDecode",
        Some(DictValue::Array(range)) => {
            let array = &dict[range];
            let first_name = find_sub(array, b"/").map(|at| {
                let mut end = at + 1;
                while end < array.len() && !is_delimiter(array[end]) {
                    end += 1;
                }
                &array[at..end]
            });
            first_name.map_or(false, |name| name == b"/DCTDecode")
        }
        _ => false,
    };
    if !filter_is_dct {
        return false;
    }
    if dict_int(dict, b"/BitsPerComponent") != Some(8) {
        return false;
    }
    let colorspace_ok = dict_name(dict, b"/ColorSpace")
        .map_or(false, |name| name == b"DeviceRGB" || name == b"DeviceGray");
    if !colorspace_ok {
        return false;
    }
    if find_key(dict, b"/SMask").is_some()
        || find_key(dict, b"/Mask").is_some()
        || find_key(dict, b"/DecodeParms").is_some()
    {
        return false;
    }
    if dict_name(dict, b"/ImageMask").map_or(false, |name| name == b"true") {
        return false;
    }
    true
}

fn dict_six_numbers(dict: &[u8], key: &[u8]) -> Option<[f64; 6]> {
    let key_at = find_key(dict, key)?;
    let mut cursor = key_at + key.len();
    let mut values = [0.0f64; 6];
    for value in &mut values {
        loop {
            match next_token(dict, &mut cursor)? {
                Token::Number(number) => {
                    *value = number;
                    break;
                }
                Token::Skip => continue,
                _ => return None,
            }
        }
    }
    Some(values)
}

// ---------------------------------------------------------------------------
// Content stream scanning
// ---------------------------------------------------------------------------

enum Token<'a> {
    Number(f64),
    Name(&'a [u8]),
    Operator(&'a [u8]),
    Skip,
}

fn next_token<'a>(data: &'a [u8], cursor: &mut usize) -> Option<Token<'a>> {
    skip_whitespace(data, cursor);
    if *cursor >= data.len() {
        return None;
    }
    match data[*cursor] {
        b'0'..=b'9' | b'+' | b'-' | b'.' => {
            let start = *cursor;
            *cursor += 1;
            while *cursor < data.len() {
                let byte = data[*cursor];
                if byte.is_ascii_digit() || byte == b'.' {
                    *cursor += 1;
                } else if (byte == b'e' || byte == b'E')
                    && matches!(
                        data.get(*cursor + 1),
                        Some(b'0'..=b'9') | Some(b'+') | Some(b'-')
                    )
                {
                    *cursor += 2;
                } else {
                    break;
                }
            }
            let text = std::str::from_utf8(&data[start..*cursor]).ok()?;
            text.parse::<f64>().ok().map(Token::Number)
        }
        b'/' => {
            *cursor += 1;
            let start = *cursor;
            while *cursor < data.len() && !is_delimiter(data[*cursor]) {
                *cursor += 1;
            }
            Some(Token::Name(&data[start..*cursor]))
        }
        b'(' => {
            *cursor += 1;
            let mut depth = 1usize;
            while *cursor < data.len() && depth > 0 {
                match data[*cursor] {
                    b'\\' => *cursor += 1,
                    b'(' => depth += 1,
                    b')' => depth -= 1,
                    _ => {}
                }
                *cursor += 1;
            }
            Some(Token::Skip)
        }
        b'<' => {
            if data.get(*cursor + 1) == Some(&b'<') {
                *cursor += 2;
                let mut depth = 1usize;
                while *cursor < data.len() && depth > 0 {
                    if data[*cursor] == b'<' && data.get(*cursor + 1) == Some(&b'<') {
                        depth += 1;
                        *cursor += 2;
                    } else if data[*cursor] == b'>' && data.get(*cursor + 1) == Some(&b'>') {
                        depth -= 1;
                        *cursor += 2;
                    } else {
                        *cursor += 1;
                    }
                }
            } else {
                while *cursor < data.len() && data[*cursor] != b'>' {
                    *cursor += 1;
                }
                *cursor += 1;
            }
            Some(Token::Skip)
        }
        b'>' | b'[' | b']' | b'{' | b'}' => {
            *cursor += 1;
            Some(Token::Skip)
        }
        _ => {
            let start = *cursor;
            while *cursor < data.len() && !is_delimiter(data[*cursor]) {
                *cursor += 1;
            }
            Some(Token::Operator(&data[start..*cursor]))
        }
    }
}

fn skip_whitespace(data: &[u8], cursor: &mut usize) {
    loop {
        while *cursor < data.len() && is_ws(data[*cursor]) {
            *cursor += 1;
        }
        if *cursor < data.len() && data[*cursor] == b'%' {
            while *cursor < data.len() && !matches!(data[*cursor], b'\r' | b'\n') {
                *cursor += 1;
            }
            continue;
        }
        return;
    }
}

fn mat_multiplication(matrix: [f64; 6], ctm: [f64; 6]) -> [f64; 6] {
    [
        matrix[0] * ctm[0] + matrix[1] * ctm[2],
        matrix[0] * ctm[1] + matrix[1] * ctm[3],
        matrix[2] * ctm[0] + matrix[3] * ctm[2],
        matrix[2] * ctm[1] + matrix[3] * ctm[3],
        matrix[4] * ctm[0] + matrix[5] * ctm[2] + ctm[4],
        matrix[4] * ctm[1] + matrix[5] * ctm[3] + ctm[5],
    ]
}

struct Scanner<'a> {
    document: &'a QdfDocument,
    images: &'a HashMap<u32, (u32, u32)>,
    effective: &'a mut HashMap<u32, f64>,
    visited: HashSet<u32>,
}

impl<'a> Scanner<'a> {
    fn scan(
        &mut self,
        content: &[u8],
        initial_ctm: [f64; 6],
        resources: Option<Range<usize>>,
        depth: usize,
    ) {
        if depth > MAX_FORM_DEPTH {
            return;
        }

        let xobjects = resources
            .as_ref()
            .map(|region| self.document.parse_xobject_refs(region))
            .unwrap_or_default();

        let mut ctm = initial_ctm;
        let mut stack: Vec<[f64; 6]> = Vec::new();
        let mut numbers: Vec<f64> = Vec::new();
        let mut pending_name: Option<&[u8]> = None;
        let mut cursor = 0usize;

        while let Some(token) = next_token(content, &mut cursor) {
            match token {
                Token::Number(value) => {
                    numbers.push(value);
                    if numbers.len() > 48 {
                        numbers.clear();
                    }
                }
                Token::Name(name) => {
                    numbers.clear();
                    pending_name = Some(name);
                }
                Token::Skip => {
                    numbers.clear();
                    pending_name = None;
                }
                Token::Operator(operator) => {
                    match operator {
                        b"q" => stack.push(ctm),
                        b"Q" => ctm = stack.pop().unwrap_or(IDENTITY_CTM),
                        b"cm" if numbers.len() >= 6 => {
                            let matrix = [
                                numbers[numbers.len() - 6],
                                numbers[numbers.len() - 5],
                                numbers[numbers.len() - 4],
                                numbers[numbers.len() - 3],
                                numbers[numbers.len() - 2],
                                numbers[numbers.len() - 1],
                            ];
                            ctm = mat_multiplication(matrix, ctm);
                        }
                        b"Do" => {
                            if let Some(name) = pending_name.take() {
                                if let Some((_, number)) =
                                    xobjects.iter().find(|(candidate, _)| candidate == name)
                                {
                                    self.handle_xobject(*number, ctm, resources.clone(), depth);
                                }
                            }
                        }
                        b"BI" => cursor = skip_inline_image(content, cursor),
                        _ => {}
                    }
                    numbers.clear();
                    pending_name = None;
                }
            }
        }
    }

    fn handle_xobject(
        &mut self,
        number: u32,
        ctm: [f64; 6],
        parent_resources: Option<Range<usize>>,
        depth: usize,
    ) {
        let document = self.document;
        if let Some(&(width, height)) = self.images.get(&number) {
            let sx = (ctm[0] * ctm[0] + ctm[1] * ctm[1]).sqrt();
            let sy = (ctm[2] * ctm[2] + ctm[3] * ctm[3]).sqrt();
            if sx > 1e-6 && sy > 1e-6 {
                let effective_dpi =
                    (f64::from(width) * 72.0 / sx).max(f64::from(height) * 72.0 / sy);
                let slot = self.effective.entry(number).or_insert(0.0);
                if effective_dpi > *slot {
                    *slot = effective_dpi;
                }
            }
            return;
        }

        let Some(dict) = document.dict_of(number) else {
            return;
        };
        if !dict_name(dict, b"/Subtype").map_or(false, |name| name == b"Form") {
            return;
        }
        let matrix = dict_six_numbers(dict, b"/Matrix").unwrap_or(IDENTITY_CTM);
        let own_resources = document.value_region(number, b"/Resources");
        let Some(content) = document.stream_of(number) else {
            return;
        };
        if !self.visited.insert(number) {
            return;
        }
        self.scan(
            &content,
            mat_multiplication(matrix, ctm),
            own_resources.or(parent_resources),
            depth + 1,
        );
        self.visited.remove(&number);
    }
}

/// Skips an inline image (BI ... ID <binary> EI), returning the position
/// after EI.
fn skip_inline_image(data: &[u8], mut cursor: usize) -> usize {
    let Some(id_at) = find_delimited_keyword(data, cursor, b"ID") else {
        return cursor;
    };
    cursor = id_at + b"ID".len();
    // A single whitespace byte separates ID from the binary data.
    if cursor < data.len() {
        cursor += 1;
    }
    while let Some(relative) = find_sub(&data[cursor..], b"EI") {
        let at = cursor + relative;
        let before_ok = at > 0 && is_ws(data[at - 1]);
        let after_ok = data.get(at + 2).map_or(true, |b| is_ws(*b) || is_delimiter(*b));
        if before_ok && after_ok {
            return at + 2;
        }
        cursor = at + 1;
    }
    data.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_jpeg(width: u32, height: u32) -> Vec<u8> {
        let image = image::RgbImage::from_fn(width, height, |x, y| {
            image::Rgb([
                (x * 7 % 256) as u8,
                (y * 11 % 256) as u8,
                (x * y % 256) as u8,
            ])
        });
        let mut bytes = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 90)
            .encode_image(&image::DynamicImage::ImageRgb8(image))
            .unwrap();
        bytes
    }

    fn qdf_with_image(content: &str, jpeg: &[u8], width: u32, height: u32) -> Vec<u8> {
        let mut data = Vec::new();
        data.extend_from_slice(b"%PDF-1.7\n");
        data.extend_from_slice(b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
        data.extend_from_slice(b"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
        data.extend_from_slice(
            b"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
        );
        data.extend_from_slice(
            format!(
                "4 0 obj\n<< /Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length {} >>\nstream\n",
                jpeg.len()
            )
            .as_bytes(),
        );
        data.extend_from_slice(jpeg);
        data.extend_from_slice(b"\nendstream\nendobj\n");
        data.extend_from_slice(
            format!(
                "5 0 obj\n<< /Length {} >>\nstream\n{}\nendstream\nendobj\n",
                content.len(),
                content
            )
            .as_bytes(),
        );
        data
    }

    fn write_temp_qdf(bytes: &[u8]) -> tempfile::NamedTempFile {
        let file = tempfile::Builder::new().suffix(".pdf").tempfile().unwrap();
        fs::write(file.path(), bytes).unwrap();
        file
    }

    #[test]
    fn measures_effective_dpi_and_downsamples() {
        // 800x400 image drawn at 192x96 points: effective DPI is 300.
        let jpeg = test_jpeg(800, 400);
        let qdf = qdf_with_image("q 192 0 0 96 0 0 cm /Im0 Do Q\n", &jpeg, 800, 400);
        let file = write_temp_qdf(&qdf);

        let changed = downsample_dct_images(
            file.path(),
            &ImageOptimizeSettings {
                target_dpi: 150.0,
                trigger_dpi: 225.0,
                jpeg_quality: 85,
            },
        )
        .unwrap();
        assert_eq!(changed, 1);

        let rewritten = fs::read(file.path()).unwrap();
        let text = String::from_utf8_lossy(&rewritten);
        assert!(text.contains("/Width 400"), "{text}");
        assert!(text.contains("/Height 200"), "{text}");
        assert!(rewritten.len() < qdf.len());
    }

    #[test]
    fn downsamples_images_above_trigger_dpi() {
        // Drawn at 200x100 points from an 800x400 image: 288 DPI effective.
        let jpeg = test_jpeg(800, 400);
        let qdf = qdf_with_image("q 200 0 0 100 0 0 cm /Im0 Do Q\n", &jpeg, 800, 400);
        let file = write_temp_qdf(&qdf);

        let changed = downsample_dct_images(
            file.path(),
            &ImageOptimizeSettings {
                target_dpi: 150.0,
                trigger_dpi: 225.0,
                jpeg_quality: 85,
            },
        )
        .unwrap();
        assert_eq!(changed, 1);
        let rewritten = fs::read(file.path()).unwrap();
        let text = String::from_utf8_lossy(&rewritten);
        // 800px * (150/288) = 417, 400px * (150/288) = 208.
        assert!(text.contains("/Width 417"), "{text}");
        assert!(text.contains("/Height 208"), "{text}");
    }

    #[test]
    fn skips_images_at_low_effective_dpi() {
        let jpeg = test_jpeg(800, 400);
        // Drawn at 800x400 points: 72 DPI, well below the trigger.
        let qdf = qdf_with_image("q 800 0 0 400 0 0 cm /Im0 Do Q\n", &jpeg, 800, 400);
        let file = write_temp_qdf(&qdf);

        let changed = downsample_dct_images(
            file.path(),
            &ImageOptimizeSettings {
                target_dpi: 150.0,
                trigger_dpi: 225.0,
                jpeg_quality: 85,
            },
        )
        .unwrap();
        assert_eq!(changed, 0);
    }

    #[test]
    fn ignores_images_with_masks_or_wrong_colorspace() {
        let jpeg = test_jpeg(800, 400);
        let mut dict_qdf = qdf_with_image("q 192 0 0 96 0 0 cm /Im0 Do Q\n", &jpeg, 800, 400);
        // Inject /SMask into the image dict.
        let pattern = b"/Subtype /Image";
        let at = find_sub(&dict_qdf, pattern).unwrap();
        let mut patched = Vec::new();
        patched.extend_from_slice(&dict_qdf[..at]);
        patched.extend_from_slice(b"/Subtype /Image /SMask 9 0 R");
        patched.extend_from_slice(&dict_qdf[at + pattern.len()..]);
        dict_qdf = patched;
        let file = write_temp_qdf(&dict_qdf);

        let changed = downsample_dct_images(
            file.path(),
            &ImageOptimizeSettings {
                target_dpi: 150.0,
                trigger_dpi: 225.0,
                jpeg_quality: 85,
            },
        )
        .unwrap();
        assert_eq!(changed, 0);
    }

    #[test]
    fn parses_object_headers_and_streams() {
        let jpeg = test_jpeg(4, 4);
        let qdf = qdf_with_image("q Q\n", &jpeg, 4, 4);
        let document = QdfDocument::load_from_bytes(qdf);
        assert_eq!(document.objects.len(), 5);
        let image_entry = document.objects.get(&4).unwrap();
        let stream = image_entry.stream.clone().unwrap();
        assert_eq!(&document.data[stream], &jpeg[..]);
        assert_eq!(
            dict_int(
                &document.data[image_entry.dict.clone()],
                b"/Length"
            ),
            Some(jpeg.len() as i64)
        );
    }
}
