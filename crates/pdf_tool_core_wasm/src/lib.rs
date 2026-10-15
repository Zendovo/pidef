//! WebAssembly bindings for the parts of `pdf_tool_core` that run in the
//! browser: the JPG-to-PDF builder, the QDF image optimizer, and the qpdf
//! argument/spec builders so CLI semantics stay defined in one place.
//!
//! PDF rendering and qpdf execution are handled by the web layer
//! (PDFium wasm and qpdf wasm respectively).

use pdf_tool_core::{
    build_jpg_pdf_from_bytes, compress_arguments, downsample_dct_images_bytes, page_spec,
    parse_page_ranges, protect_arguments, qpdf_range, CompressionProfile, ImageOptimizeSettings,
    ProtectPermissions,
};
use wasm_bindgen::prelude::*;

fn js_error(error: pdf_tool_core::PdfToolError) -> JsError {
    JsError::new(&error.to_string())
}

fn parse_profile(profile: &str) -> Result<CompressionProfile, JsError> {
    match profile {
        "safe" => Ok(CompressionProfile::Safe),
        "balanced" => Ok(CompressionProfile::Balanced),
        "small" => Ok(CompressionProfile::Small),
        other => Err(JsError::new(&format!("unknown compression profile: {other}"))),
    }
}

/// qpdf page-range strings ("1", "3-5") for a ranges text input.
#[wasm_bindgen]
pub fn qpdf_ranges(ranges: &str) -> Result<Vec<String>, JsError> {
    let selections = parse_page_ranges(ranges).map_err(js_error)?;
    Ok(selections.iter().map(qpdf_range).collect())
}

/// qpdf page specs for organize ("3", "3:rotate=+90"), with rotations in
/// degrees matching `pages` element-wise.
#[wasm_bindgen]
pub fn organize_page_specs(pages: &[u32], rotations: &[i16]) -> Result<Vec<String>, JsError> {
    if pages.len() != rotations.len() {
        return Err(JsError::new("pages and rotations must have the same length"));
    }
    Ok(pages
        .iter()
        .zip(rotations.iter())
        .map(|(page, rotation)| page_spec(*page, *rotation))
        .collect())
}

/// qpdf arguments for a compression preset.
#[wasm_bindgen]
pub fn compress_arguments_for(profile: &str) -> Result<Vec<String>, JsError> {
    Ok(compress_arguments(parse_profile(profile)?)
        .into_iter()
        .map(str::to_string)
        .collect())
}

/// qpdf `--encrypt` arguments for protect.
#[wasm_bindgen]
pub fn protect_arguments_for(
    user_password: &str,
    owner_password: &str,
    allow_printing: bool,
    allow_copying: bool,
    allow_modification: bool,
) -> Vec<String> {
    protect_arguments(
        user_password,
        owner_password,
        &ProtectPermissions {
            allow_printing,
            allow_copying,
            allow_modification,
        },
    )
}

#[wasm_bindgen]
pub struct ProfileImageSettings {
    target_dpi: f64,
    trigger_dpi: f64,
    jpeg_quality: u8,
}

#[wasm_bindgen]
impl ProfileImageSettings {
    #[wasm_bindgen(getter)]
    pub fn target_dpi(&self) -> f64 {
        self.target_dpi
    }

    #[wasm_bindgen(getter)]
    pub fn trigger_dpi(&self) -> f64 {
        self.trigger_dpi
    }

    #[wasm_bindgen(getter)]
    pub fn jpeg_quality(&self) -> u8 {
        self.jpeg_quality
    }
}

/// Image resampling settings for a preset, or undefined for lossless `safe`.
#[wasm_bindgen]
pub fn profile_image_settings(profile: &str) -> Result<Option<ProfileImageSettings>, JsError> {
    Ok(parse_profile(profile)?
        .image_settings()
        .map(|settings| ProfileImageSettings {
            target_dpi: settings.target_dpi,
            trigger_dpi: settings.trigger_dpi,
            jpeg_quality: settings.jpeg_quality,
        }))
}

#[wasm_bindgen]
pub struct OptimizeResult {
    bytes: Vec<u8>,
    changed: u32,
}

#[wasm_bindgen]
impl OptimizeResult {
    #[wasm_bindgen(getter)]
    pub fn bytes(&self) -> Vec<u8> {
        self.bytes.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn changed(&self) -> u32 {
        self.changed
    }
}

/// Downsamples oversized JPEG images inside a qdf-staged PDF.
#[wasm_bindgen]
pub fn optimize_qdf(
    data: Vec<u8>,
    target_dpi: f64,
    trigger_dpi: f64,
    jpeg_quality: u8,
) -> Result<OptimizeResult, JsError> {
    let settings = ImageOptimizeSettings {
        target_dpi,
        trigger_dpi,
        jpeg_quality,
    };
    let (bytes, changed) = downsample_dct_images_bytes(data, &settings).map_err(js_error)?;
    Ok(OptimizeResult {
        bytes,
        changed: changed as u32,
    })
}

/// Builds a PDF from an array of JPEG image byte arrays.
#[wasm_bindgen]
pub fn jpg_to_pdf(
    files: js_sys::Array,
    page_size: &str,
    fit_mode: &str,
    margin_mm: f32,
) -> Result<Vec<u8>, JsError> {
    let mut images = Vec::with_capacity(files.length() as usize);
    for value in files.iter() {
        let array: js_sys::Uint8Array = value
            .dyn_into()
            .map_err(|_| JsError::new("expected an array of Uint8Arrays"))?;
        images.push(array.to_vec());
    }
    build_jpg_pdf_from_bytes(&images, page_size, fit_mode, margin_mm).map_err(js_error)
}
