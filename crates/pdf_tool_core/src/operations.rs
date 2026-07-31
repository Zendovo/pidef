use crate::{
    dependencies::{detect_dependencies, detect_dependencies_with_roots},
    page_ranges::qpdf_range,
    parse_page_ranges, CompressionProfile, DependencySet, JobRequest, JobResult, Operation,
    OrganizePage, PdfToolError, ProtectPermissions,
};
use image::codecs::jpeg::JpegEncoder;
use pdfium_render::prelude::*;
use std::{
    env, fs,
    fs::File,
    io::BufWriter,
    path::{Path, PathBuf},
    process::Command,
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub fn run_job(request: JobRequest) -> Result<JobResult, PdfToolError> {
    run_job_with_dependency_roots(request, &[])
}

pub fn run_job_with_dependency_roots(
    mut request: JobRequest,
    dependency_roots: &[PathBuf],
) -> Result<JobResult, PdfToolError> {
    request.output = Some(resolve_output_path(&request)?);
    let dependencies = if dependency_roots.is_empty() {
        detect_dependencies()
    } else {
        detect_dependencies_with_roots(dependency_roots)
    };
    validate_request(&request)?;

    match &request.operation {
        Operation::MergePdf { inputs } => run_merge(&request, &dependencies, inputs),
        Operation::SplitPdf {
            input,
            ranges,
            output_pattern,
        } => run_split(&request, &dependencies, input, ranges, output_pattern),
        Operation::OrganizePdf { input, pages } => {
            run_organize(&request, &dependencies, input, pages)
        }
        Operation::CompressPdf { input, profile } => {
            run_compress(&request, &dependencies, input, *profile)
        }
        Operation::PdfToJpg {
            input,
            dpi,
            first_page,
            last_page,
            quality,
        } => run_pdf_to_jpg(
            &request,
            &dependencies,
            input,
            *dpi,
            *first_page,
            *last_page,
            *quality,
        ),
        Operation::JpgToPdf {
            inputs,
            page_size,
            fit_mode,
            margin_mm,
        } => run_jpg_to_pdf(&request, inputs, page_size, fit_mode, *margin_mm),
        Operation::PptToPdf { input } | Operation::WordToPdf { input } => {
            run_office_to_pdf(&request, &dependencies, input)
        }
        Operation::UnlockPdf { input, password } => {
            run_unlock(&request, &dependencies, input, password)
        }
        Operation::ProtectPdf {
            input,
            user_password,
            owner_password,
            permissions,
        } => run_protect(
            &request,
            &dependencies,
            input,
            user_password,
            owner_password,
            permissions,
        ),
    }
}

fn validate_request(request: &JobRequest) -> Result<(), PdfToolError> {
    match &request.operation {
        Operation::MergePdf { inputs } | Operation::JpgToPdf { inputs, .. } => {
            if inputs.is_empty() {
                return Err(PdfToolError::InvalidRequest(
                    "at least one input file is required".to_string(),
                ));
            }
            for input in inputs {
                ensure_file(input)?;
            }
        }
        Operation::SplitPdf { input, ranges, .. } => {
            ensure_file(input)?;
            parse_page_ranges(ranges)?;
        }
        Operation::OrganizePdf { input, pages } => {
            ensure_file(input)?;
            if pages.is_empty() {
                return Err(PdfToolError::InvalidRequest(
                    "at least one page is required".to_string(),
                ));
            }
            for page in pages {
                if page.source_page == 0 {
                    return Err(PdfToolError::InvalidRequest(
                        "page numbers start at 1".to_string(),
                    ));
                }
                if !matches!(page.rotate_degrees, 0 | 90 | 180 | 270 | -90 | -180 | -270) {
                    return Err(PdfToolError::InvalidRequest(format!(
                        "unsupported rotation: {}",
                        page.rotate_degrees
                    )));
                }
            }
        }
        Operation::CompressPdf { input, .. }
        | Operation::PdfToJpg { input, .. }
        | Operation::PptToPdf { input }
        | Operation::WordToPdf { input }
        | Operation::UnlockPdf { input, .. }
        | Operation::ProtectPdf { input, .. } => ensure_file(input)?,
    }

    let output = request
        .output
        .as_ref()
        .ok_or_else(|| PdfToolError::InvalidRequest("output path is required".to_string()))?;

    if output.exists() {
        return Err(PdfToolError::OutputConflict(output.display().to_string()));
    }

    Ok(())
}

fn output_path(request: &JobRequest) -> Result<&PathBuf, PdfToolError> {
    request
        .output
        .as_ref()
        .ok_or_else(|| PdfToolError::InvalidRequest("output path is required".to_string()))
}

fn resolve_output_path(request: &JobRequest) -> Result<PathBuf, PdfToolError> {
    if let Some(output) = &request.output {
        return Ok(output.clone());
    }

    let base = env::temp_dir()
        .join("local-pdf-tool")
        .join(request.id.to_string());
    fs::create_dir_all(&base)?;

    let output = match &request.operation {
        Operation::SplitPdf { .. } | Operation::PdfToJpg { .. } => base.join("outputs"),
        Operation::MergePdf { .. } => base.join("merged.pdf"),
        Operation::OrganizePdf { .. } => base.join("organized.pdf"),
        Operation::CompressPdf { .. } => base.join("compressed.pdf"),
        Operation::JpgToPdf { .. } => base.join("images.pdf"),
        Operation::PptToPdf { .. } => base.join("presentation.pdf"),
        Operation::WordToPdf { .. } => base.join("document.pdf"),
        Operation::UnlockPdf { .. } => base.join("unlocked.pdf"),
        Operation::ProtectPdf { .. } => base.join("protected.pdf"),
    };

    Ok(output)
}

fn ensure_file(path: &Path) -> Result<(), PdfToolError> {
    if path.is_file() {
        Ok(())
    } else {
        Err(PdfToolError::UnsupportedFile(path.display().to_string()))
    }
}

fn run_merge(
    request: &JobRequest,
    deps: &DependencySet,
    inputs: &[PathBuf],
) -> Result<JobResult, PdfToolError> {
    require(&deps.qpdf)?;
    let output = output_path(request)?;
    let mut command = hidden_command(&deps.qpdf.command);
    command.arg("--empty").arg("--pages");
    for input in inputs {
        command.arg(input).arg("1-z");
    }
    command.arg("--").arg(output);
    run_command(command)?;
    result_for(request, &[output.clone()], inputs)
}

fn run_split(
    request: &JobRequest,
    deps: &DependencySet,
    input: &Path,
    ranges: &str,
    output_pattern: &str,
) -> Result<JobResult, PdfToolError> {
    require(&deps.qpdf)?;
    let selections = parse_page_ranges(ranges)?;
    let output_dir = output_path(request)?;
    fs::create_dir_all(output_dir)?;

    let mut outputs = Vec::new();
    for (index, selection) in selections.iter().enumerate() {
        let range = qpdf_range(selection);
        let file_name = output_pattern
            .replace("{n}", &(index + 1).to_string())
            .replace("{range}", &range);
        let output = output_dir.join(file_name);
        if output.exists() {
            return Err(PdfToolError::OutputConflict(output.display().to_string()));
        }

        let mut command = hidden_command(&deps.qpdf.command);
        command
            .arg("--empty")
            .arg("--pages")
            .arg(input)
            .arg(&range)
            .arg("--")
            .arg(&output);
        run_command(command)?;
        outputs.push(output);
    }

    result_for(request, &outputs, &[input.to_path_buf()])
}

fn run_organize(
    request: &JobRequest,
    deps: &DependencySet,
    input: &Path,
    pages: &[OrganizePage],
) -> Result<JobResult, PdfToolError> {
    require(&deps.qpdf)?;
    let output = output_path(request)?;
    let mut command = hidden_command(&deps.qpdf.command);
    command.arg("--empty").arg("--pages");
    for page in pages {
        command
            .arg(input)
            .arg(page_spec(page.source_page, page.rotate_degrees));
    }
    command.arg("--").arg(output);
    run_command(command)?;
    result_for(request, &[output.clone()], &[input.to_path_buf()])
}

fn page_spec(page: u32, rotate_degrees: i16) -> String {
    match rotate_degrees {
        0 => page.to_string(),
        90 => format!("{page}:rotate=+90"),
        180 => format!("{page}:rotate=+180"),
        270 | -90 => format!("{page}:rotate=-90"),
        -180 => format!("{page}:rotate=+180"),
        -270 => format!("{page}:rotate=+90"),
        _ => page.to_string(),
    }
}

fn run_compress(
    request: &JobRequest,
    deps: &DependencySet,
    input: &Path,
    profile: CompressionProfile,
) -> Result<JobResult, PdfToolError> {
    require(&deps.ghostscript)?;
    let output = output_path(request)?;
    let mut command = hidden_command(&deps.ghostscript.command);
    command
        .arg("-sDEVICE=pdfwrite")
        .arg("-dCompatibilityLevel=1.4")
        .arg(format!("-dPDFSETTINGS={}", profile.ghostscript_value()))
        .arg("-dNOPAUSE")
        .arg("-dQUIET")
        .arg("-dBATCH")
        .arg(format!("-sOutputFile={}", output.display()))
        .arg(input);
    run_command(command)?;
    result_for(request, &[output.clone()], &[input.to_path_buf()])
}

fn run_pdf_to_jpg(
    request: &JobRequest,
    deps: &DependencySet,
    input: &Path,
    dpi: u16,
    first_page: Option<u32>,
    last_page: Option<u32>,
    quality: u8,
) -> Result<JobResult, PdfToolError> {
    require(&deps.pdf_renderer)?;
    let output_dir = output_path(request)?;
    fs::create_dir_all(output_dir)?;

    let pdfium_path = deps
        .pdf_renderer
        .path
        .as_ref()
        .ok_or_else(|| PdfToolError::MissingDependency("PDFium".to_string()))?;
    let pdfium = Pdfium::new(
        Pdfium::bind_to_library(pdfium_path)
            .map_err(|error| PdfToolError::ConversionFailed(error.to_string()))?,
    );
    let document = pdfium
        .load_pdf_from_file(input, None)
        .map_err(|error| PdfToolError::ConversionFailed(error.to_string()))?;

    let first_index = first_page.unwrap_or(1).saturating_sub(1) as usize;
    let last_index = last_page
        .map(|page| page.saturating_sub(1) as usize)
        .unwrap_or_else(|| document.pages().len().saturating_sub(1) as usize);
    if first_index > last_index || first_index >= document.pages().len() as usize {
        return Err(PdfToolError::InvalidRequest(
            "invalid PDF page range".to_string(),
        ));
    }

    let quality = quality.clamp(1, 100);
    let mut outputs = Vec::new();
    for (index, page) in document.pages().iter().enumerate() {
        if index < first_index || index > last_index {
            continue;
        }

        let target_width = points_to_pixels(page.width().value, dpi);
        let target_height = points_to_pixels(page.height().value, dpi);
        let render_config = PdfRenderConfig::new()
            .set_target_width(target_width)
            .set_maximum_height(target_height);
        let image = page
            .render_with_config(&render_config)
            .map_err(|error| PdfToolError::ConversionFailed(error.to_string()))?
            .as_image()
            .map_err(|error| PdfToolError::ConversionFailed(error.to_string()))?
            .into_rgb8();

        let output = output_dir.join(format!("page-{:04}.jpg", index + 1));
        let writer = BufWriter::new(File::create(&output)?);
        JpegEncoder::new_with_quality(writer, quality)
            .encode_image(&image)
            .map_err(|error| PdfToolError::ConversionFailed(error.to_string()))?;
        outputs.push(output);
    }

    result_for(request, &outputs, &[input.to_path_buf()])
}

fn run_jpg_to_pdf(
    request: &JobRequest,
    inputs: &[PathBuf],
    page_size: &str,
    fit_mode: &str,
    margin_mm: f32,
) -> Result<JobResult, PdfToolError> {
    let output = output_path(request)?;
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)?;
    }

    let pdf = build_jpg_pdf(inputs, page_size, fit_mode, margin_mm)?;
    fs::write(output, pdf)?;
    result_for(request, &[output.clone()], inputs)
}

fn run_office_to_pdf(
    request: &JobRequest,
    deps: &DependencySet,
    input: &Path,
) -> Result<JobResult, PdfToolError> {
    require(&deps.libreoffice)?;
    let output = output_path(request)?;
    let output_dir = output
        .parent()
        .ok_or_else(|| PdfToolError::InvalidRequest("output path has no parent".to_string()))?;
    fs::create_dir_all(output_dir)?;

    let mut command = hidden_command(&deps.libreoffice.command);
    command
        .arg("--headless")
        .arg("--convert-to")
        .arg("pdf")
        .arg("--outdir")
        .arg(output_dir)
        .arg(input);
    run_command(command)?;

    let generated = output_dir.join(format!(
        "{}.pdf",
        input
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("converted")
    ));

    if generated != *output && generated.exists() {
        fs::rename(&generated, output)?;
    }

    result_for(request, &[output.clone()], &[input.to_path_buf()])
}

fn run_unlock(
    request: &JobRequest,
    deps: &DependencySet,
    input: &Path,
    password: &str,
) -> Result<JobResult, PdfToolError> {
    require(&deps.qpdf)?;
    let output = output_path(request)?;
    let mut command = hidden_command(&deps.qpdf.command);
    command
        .arg(format!("--password={password}"))
        .arg("--decrypt")
        .arg(input)
        .arg(output);
    run_command(command).map_err(|error| match error {
        PdfToolError::ConversionFailed(message) if message.to_lowercase().contains("password") => {
            PdfToolError::InvalidPassword
        }
        other => other,
    })?;
    result_for(request, &[output.clone()], &[input.to_path_buf()])
}

fn run_protect(
    request: &JobRequest,
    deps: &DependencySet,
    input: &Path,
    user_password: &str,
    owner_password: &str,
    permissions: &ProtectPermissions,
) -> Result<JobResult, PdfToolError> {
    require(&deps.qpdf)?;
    let output = output_path(request)?;
    let mut command = hidden_command(&deps.qpdf.command);
    command
        .arg("--encrypt")
        .arg(user_password)
        .arg(owner_password)
        .arg("256");

    if !permissions.allow_printing {
        command.arg("--print=none");
    }
    if !permissions.allow_copying {
        command.arg("--extract=n");
    }
    if !permissions.allow_modification {
        command.arg("--modify=none");
    }

    command.arg("--").arg(input).arg(output);
    run_command(command)?;
    result_for(request, &[output.clone()], &[input.to_path_buf()])
}

fn require(dependency: &crate::DependencyInfo) -> Result<(), PdfToolError> {
    if dependency.available {
        Ok(())
    } else {
        Err(PdfToolError::MissingDependency(dependency.command.clone()))
    }
}

fn run_command(mut command: Command) -> Result<(), PdfToolError> {
    let output = command.output()?;
    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let details = if stderr.trim().is_empty() {
        stdout.trim().to_string()
    } else {
        stderr.trim().to_string()
    };

    Err(PdfToolError::ConversionFailed(details))
}

fn hidden_command(program: &str) -> Command {
    #[cfg(windows)]
    {
        let mut command = Command::new(program);
        command.creation_flags(CREATE_NO_WINDOW);
        command
    }

    #[cfg(not(windows))]
    {
        Command::new(program)
    }
}

fn points_to_pixels(points: f32, dpi: u16) -> i32 {
    ((points * dpi as f32 / 72.0).round() as i32).max(1)
}

fn result_for(
    request: &JobRequest,
    outputs: &[PathBuf],
    inputs: &[PathBuf],
) -> Result<JobResult, PdfToolError> {
    Ok(JobResult {
        id: request.id,
        outputs: outputs.to_vec(),
        warnings: Vec::new(),
        input_bytes: sum_bytes(inputs),
        output_bytes: sum_bytes(outputs),
    })
}

fn sum_bytes(paths: &[PathBuf]) -> Option<u64> {
    let mut total = 0;
    for path in paths {
        total += fs::metadata(path).ok()?.len();
    }
    Some(total)
}

#[derive(Debug, Clone, Copy)]
struct JpegInfo {
    width: u32,
    height: u32,
    components: u8,
}

fn build_jpg_pdf(
    inputs: &[PathBuf],
    page_size: &str,
    fit_mode: &str,
    margin_mm: f32,
) -> Result<Vec<u8>, PdfToolError> {
    let mut images = Vec::new();
    for input in inputs {
        let bytes = fs::read(input)?;
        let info = parse_jpeg_info(&bytes).ok_or_else(|| {
            PdfToolError::UnsupportedFile(format!("not a supported JPEG: {}", input.display()))
        })?;
        images.push((bytes, info));
    }

    let page_count = images.len();
    let mut objects = Vec::<Vec<u8>>::new();
    objects.push(b"<< /Type /Catalog /Pages 2 0 R >>".to_vec());

    let page_ids: Vec<usize> = (0..page_count).map(|index| 3 + index * 3).collect();
    let kids = page_ids
        .iter()
        .map(|id| format!("{id} 0 R"))
        .collect::<Vec<_>>()
        .join(" ");
    objects.push(format!("<< /Type /Pages /Kids [{kids}] /Count {page_count} >>").into_bytes());

    for (index, (bytes, info)) in images.iter().enumerate() {
        let page_obj = 3 + index * 3;
        let content_obj = page_obj + 1;
        let image_obj = page_obj + 2;
        let (page_w, page_h) = resolve_page_size(page_size, *info);
        let margin = mm_to_points(margin_mm);
        let (draw_w, draw_h, draw_x, draw_y) =
            image_placement(*info, page_w, page_h, margin, fit_mode);
        let image_name = format!("Im{}", index + 1);
        let content = format!(
            "q {draw_w:.2} 0 0 {draw_h:.2} {draw_x:.2} {draw_y:.2} cm /{image_name} Do Q\n"
        );
        let image_stream = image_object(bytes, *info)?;

        objects.push(format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {page_w:.2} {page_h:.2}] /Resources << /XObject << /{image_name} {image_obj} 0 R >> >> /Contents {content_obj} 0 R >>"
        ).into_bytes());
        objects.push(stream_object(content.as_bytes(), None));
        objects.push(image_stream);
    }

    Ok(write_pdf(objects))
}

fn parse_jpeg_info(bytes: &[u8]) -> Option<JpegInfo> {
    if bytes.len() < 4 || bytes[0] != 0xff || bytes[1] != 0xd8 {
        return None;
    }

    let mut index = 2;
    while index + 9 < bytes.len() {
        while index < bytes.len() && bytes[index] == 0xff {
            index += 1;
        }
        if index >= bytes.len() {
            return None;
        }

        let marker = bytes[index];
        index += 1;
        if matches!(marker, 0xd8 | 0xd9 | 0x01) {
            continue;
        }
        if index + 2 > bytes.len() {
            return None;
        }
        let length = u16::from_be_bytes([bytes[index], bytes[index + 1]]) as usize;
        if length < 2 || index + length > bytes.len() {
            return None;
        }

        if matches!(
            marker,
            0xc0 | 0xc1
                | 0xc2
                | 0xc3
                | 0xc5
                | 0xc6
                | 0xc7
                | 0xc9
                | 0xca
                | 0xcb
                | 0xcd
                | 0xce
                | 0xcf
        ) {
            let precision = bytes[index + 2];
            if precision != 8 {
                return None;
            }
            let height = u16::from_be_bytes([bytes[index + 3], bytes[index + 4]]) as u32;
            let width = u16::from_be_bytes([bytes[index + 5], bytes[index + 6]]) as u32;
            let components = bytes[index + 7];
            return Some(JpegInfo {
                width,
                height,
                components,
            });
        }

        index += length;
    }

    None
}

fn resolve_page_size(page_size: &str, image: JpegInfo) -> (f32, f32) {
    match page_size {
        "a4" => (595.28, 841.89),
        "letter" => (612.0, 792.0),
        _ => (image.width as f32, image.height as f32),
    }
}

fn mm_to_points(mm: f32) -> f32 {
    mm.max(0.0) * 72.0 / 25.4
}

fn image_placement(
    image: JpegInfo,
    page_w: f32,
    page_h: f32,
    margin: f32,
    fit_mode: &str,
) -> (f32, f32, f32, f32) {
    let available_w = (page_w - margin * 2.0).max(1.0);
    let available_h = (page_h - margin * 2.0).max(1.0);
    let scale_x = available_w / image.width as f32;
    let scale_y = available_h / image.height as f32;
    let scale = if fit_mode == "fill" {
        scale_x.max(scale_y)
    } else {
        scale_x.min(scale_y)
    };
    let draw_w = image.width as f32 * scale;
    let draw_h = image.height as f32 * scale;
    let draw_x = (page_w - draw_w) / 2.0;
    let draw_y = (page_h - draw_h) / 2.0;
    (draw_w, draw_h, draw_x, draw_y)
}

fn image_object(bytes: &[u8], info: JpegInfo) -> Result<Vec<u8>, PdfToolError> {
    let color_space = match info.components {
        1 => "/DeviceGray",
        3 => "/DeviceRGB",
        4 => "/DeviceCMYK",
        other => {
            return Err(PdfToolError::UnsupportedFile(format!(
                "unsupported JPEG component count: {other}"
            )))
        }
    };

    let dictionary = format!(
        "/Type /XObject /Subtype /Image /Width {} /Height {} /ColorSpace {} /BitsPerComponent 8 /Filter /DCTDecode",
        info.width, info.height, color_space
    );
    Ok(stream_object(bytes, Some(&dictionary)))
}

fn stream_object(bytes: &[u8], extra_dictionary: Option<&str>) -> Vec<u8> {
    let mut object = Vec::new();
    let dictionary = match extra_dictionary {
        Some(extra) => format!("<< {extra} /Length {} >>\nstream\n", bytes.len()),
        None => format!("<< /Length {} >>\nstream\n", bytes.len()),
    };
    object.extend_from_slice(dictionary.as_bytes());
    object.extend_from_slice(bytes);
    object.extend_from_slice(b"\nendstream");
    object
}

fn write_pdf(objects: Vec<Vec<u8>>) -> Vec<u8> {
    let mut pdf = b"%PDF-1.7\n%\xE2\xE3\xCF\xD3\n".to_vec();
    let mut offsets = vec![0usize];

    for (index, object) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.extend_from_slice(format!("{} 0 obj\n", index + 1).as_bytes());
        pdf.extend_from_slice(object);
        pdf.extend_from_slice(b"\nendobj\n");
    }

    let xref_offset = pdf.len();
    pdf.extend_from_slice(format!("xref\n0 {}\n", objects.len() + 1).as_bytes());
    pdf.extend_from_slice(b"0000000000 65535 f \n");
    for offset in offsets.iter().skip(1) {
        pdf.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    pdf.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n",
            objects.len() + 1
        )
        .as_bytes(),
    );
    pdf
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn rejects_empty_merge_inputs() {
        let request = JobRequest {
            id: Uuid::new_v4(),
            operation: Operation::MergePdf { inputs: Vec::new() },
            output: Some(PathBuf::from("out.pdf")),
        };

        assert!(validate_request(&request).is_err());
    }

    #[test]
    fn maps_compression_profiles_to_ghostscript_values() {
        assert_eq!(CompressionProfile::Screen.ghostscript_value(), "/screen");
        assert_eq!(CompressionProfile::Ebook.ghostscript_value(), "/ebook");
        assert_eq!(CompressionProfile::Printer.ghostscript_value(), "/printer");
        assert_eq!(
            CompressionProfile::Prepress.ghostscript_value(),
            "/prepress"
        );
    }

    #[test]
    fn parses_jpeg_dimensions() {
        let jpeg = [
            0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00,
            0x10, 0x00, 0x20, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff,
            0xd9,
        ];
        let info = parse_jpeg_info(&jpeg).unwrap();
        assert_eq!(info.width, 32);
        assert_eq!(info.height, 16);
        assert_eq!(info.components, 3);
    }
}
