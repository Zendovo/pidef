use crate::{
    dependencies::{detect_dependencies, detect_dependencies_with_roots},
    downsample_dct_images,
    page_ranges::qpdf_range,
    parse_page_ranges, CompressionProfile, DependencySet, JobRequest, JobResult, Operation,
    OrganizePage, PdfToolError, ProtectPermissions,
};

#[cfg(feature = "render")]
use crate::{PdfPreview, PdfPreviewPage, PdfPreviewRequest};
#[cfg(feature = "render")]
use base64::{engine::general_purpose, Engine as _};
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

#[cfg(feature = "render")]
use std::{fs::File, io::BufWriter};

#[cfg(feature = "render")]
use image::codecs::jpeg::JpegEncoder;
#[cfg(feature = "render")]
use pdfium_render::prelude::*;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub fn run_job(request: JobRequest) -> Result<JobResult, PdfToolError> {
    run_job_with_dependency_roots(request, &[])
}

#[cfg(feature = "render")]
pub fn render_pdf_preview(
    request: PdfPreviewRequest,
    dependency_roots: &[PathBuf],
) -> Result<PdfPreview, PdfToolError> {
    ensure_file(&request.input)?;
    let dependencies = if dependency_roots.is_empty() {
        detect_dependencies()
    } else {
        detect_dependencies_with_roots(dependency_roots)
    };
    require(&dependencies.pdf_renderer)?;

    let pdfium = bind_pdfium(&dependencies)?;
    let document = pdfium
        .load_pdf_from_file(&request.input, None)
        .map_err(|error| PdfToolError::ConversionFailed(error.to_string()))?;
    let page_count = document.pages().len() as u32;
    let max_pages = request
        .max_pages
        .map(usize::from)
        .unwrap_or(page_count as usize)
        .max(1);
    let target_width = request.width.unwrap_or(180).max(48);
    let quality = request.quality.unwrap_or(72).clamp(1, 100);

    let mut pages = Vec::new();
    for (index, page) in document.pages().iter().enumerate() {
        if let Some(selected) = &request.pages {
            if !selected.contains(&(index as u32 + 1)) {
                continue;
            }
        } else if index >= max_pages {
            break;
        }

        let ratio = page.height().value / page.width().value.max(1.0);
        let target_height = ((target_width as f32 * ratio).round() as i32).max(48);
        let image = page
            .render_with_config(
                &PdfRenderConfig::new()
                    .set_target_width(target_width)
                    .set_maximum_height(target_height),
            )
            .map_err(|error| PdfToolError::ConversionFailed(error.to_string()))?
            .as_image()
            .map_err(|error| PdfToolError::ConversionFailed(error.to_string()))?
            .into_rgb8();

        let mut bytes = Vec::new();
        JpegEncoder::new_with_quality(&mut bytes, quality)
            .encode_image(&image)
            .map_err(|error| PdfToolError::ConversionFailed(error.to_string()))?;

        pages.push(PdfPreviewPage {
            page_number: index as u32 + 1,
            width: image.width(),
            height: image.height(),
            data_url: format!(
                "data:image/jpeg;base64,{}",
                general_purpose::STANDARD.encode(bytes)
            ),
        });
    }

    Ok(PdfPreview { page_count, pages })
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
        #[cfg(feature = "render")]
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
        #[cfg(not(feature = "render"))]
        Operation::PdfToJpg { .. } => Err(PdfToolError::InvalidRequest(
            "PDF rendering is not available in this build".to_string(),
        )),
        Operation::JpgToPdf {
            inputs,
            page_size,
            fit_mode,
            margin_mm,
        } => run_jpg_to_pdf(&request, inputs, page_size, fit_mode, *margin_mm),
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

    let base = env::temp_dir().join("pidef").join(request.id.to_string());
    fs::create_dir_all(&base)?;

    let output = match &request.operation {
        Operation::SplitPdf { .. } | Operation::PdfToJpg { .. } => base.join("outputs"),
        Operation::MergePdf { .. } => base.join("merged.pdf"),
        Operation::OrganizePdf { .. } => base.join("organized.pdf"),
        Operation::CompressPdf { .. } => base.join("compressed.pdf"),
        Operation::JpgToPdf { .. } => base.join("images.pdf"),
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

pub fn page_spec(page: u32, rotate_degrees: i16) -> String {
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
    require(&deps.qpdf)?;
    let output = output_path(request)?;
    let stage_dir = env::temp_dir().join("pidef").join(request.id.to_string());
    fs::create_dir_all(&stage_dir)?;

    let mut warnings: Vec<String> = Vec::new();
    let input_bytes = fs::metadata(input).ok().map(|metadata| metadata.len());

    // Attempt 1: the full preset pass (image optimization when applicable,
    // plus stream recompression).
    let full_candidate = stage_dir.join("candidate-preset.pdf");
    let full_pass = match profile.image_settings() {
        None => qpdf_pass(
            &deps.qpdf.command,
            &compress_arguments(profile),
            input,
            &full_candidate,
        )
        .map_err(map_password_error),
        Some(settings) => optimize_and_compress(
            request,
            &deps.qpdf.command,
            input,
            &full_candidate,
            profile,
            settings,
        ),
    };
    let full_warnings = match full_pass {
        Ok(pass_warnings) => pass_warnings,
        Err(error) => {
            if profile.image_settings().is_some() {
                warnings.push(format!("Image optimization skipped: {error}"));
            }
            qpdf_pass(
                &deps.qpdf.command,
                &compress_arguments(profile),
                input,
                &full_candidate,
            )
            .map_err(map_password_error)?
        }
    };
    warnings.extend(full_warnings);

    // Never ship a file larger than the input: fall back to a conservative
    // structural pass that leaves original streams untouched, then to the
    // original file itself.
    let conservative_candidate = stage_dir.join("candidate-conservative.pdf");
    let mut best: &Path = &full_candidate;
    if !is_smaller(best, input_bytes) {
        match qpdf_pass(
            &deps.qpdf.command,
            &compress_arguments(CompressionProfile::Safe),
            input,
            &conservative_candidate,
        )
        .map_err(map_password_error)
        {
            Ok(conservative_warnings) if is_smaller(&conservative_candidate, input_bytes) => {
                warnings.extend(conservative_warnings);
                best = &conservative_candidate;
            }
            Ok(_) => {}
            Err(error) => {
                // The conservative pass is a bonus attempt; keep the full
                // candidate even if it grew, and note the failure.
                if !error.to_string().to_lowercase().contains("password") {
                    warnings.push(format!("Structural fallback skipped: {error}"));
                }
            }
        }
    }

    if is_smaller(best, input_bytes) {
        fs::rename(best, &output).or_else(|_| fs::copy(best, &output).map(|_| ()))?;
    } else {
        warnings.push(
            "This PDF is already well optimized; the original was kept unchanged.".to_string(),
        );
        fs::copy(input, output)?;
    }
    let _ = fs::remove_file(&full_candidate);
    let _ = fs::remove_file(&conservative_candidate);

    let mut result = result_for(request, &[output.clone()], &[input.to_path_buf()])?;
    result.warnings = warnings;
    Ok(result)
}

fn is_smaller(candidate: &Path, input_bytes: Option<u64>) -> bool {
    let Some(input_bytes) = input_bytes else {
        return false;
    };
    fs::metadata(candidate)
        .ok()
        .map(|metadata| metadata.len() < input_bytes)
        .unwrap_or(false)
}

fn qpdf_pass(
    qpdf: &str,
    arguments: &[&str],
    input: &Path,
    output: &Path,
) -> Result<Vec<String>, PdfToolError> {
    let mut command = hidden_command(qpdf);
    for argument in arguments {
        command.arg(argument);
    }
    command.arg("--").arg(input).arg(output);
    run_command_with_warnings(command)
}

fn map_password_error(error: PdfToolError) -> PdfToolError {
    match error {
        PdfToolError::ConversionFailed(message) if message.to_lowercase().contains("password") => {
            PdfToolError::InvalidPassword
        }
        other => other,
    }
}

/// Stages the PDF through qdf (uncompressed, predictable layout), downsamples
/// oversized JPEG images, then runs the regular qpdf compression pass.
fn optimize_and_compress(
    request: &JobRequest,
    qpdf: &str,
    input: &Path,
    output: &Path,
    profile: CompressionProfile,
    settings: crate::ImageOptimizeSettings,
) -> Result<Vec<String>, PdfToolError> {
    let stage_dir = env::temp_dir().join("pidef").join(request.id.to_string());
    fs::create_dir_all(&stage_dir)?;
    let staged = stage_dir.join("optimize-source.pdf");

    let mut stage_command = hidden_command(qpdf);
    stage_command
        .arg("--qdf")
        .arg("--object-streams=disable")
        .arg("--decode-level=generalized")
        .arg("--")
        .arg(input)
        .arg(&staged);
    run_command(stage_command)?;

    let downsample_result = downsample_dct_images(&staged, &settings);

    let mut final_command = hidden_command(qpdf);
    for argument in compress_arguments(profile) {
        final_command.arg(argument);
    }
    final_command.arg("--").arg(&staged).arg(output);
    let mut warnings = run_command_with_warnings(final_command)?;
    let _ = fs::remove_file(&staged);

    match downsample_result {
        Ok(0) => {}
        Ok(count) => warnings.push(format!(
            "Downsampled {count} image{} to about {} DPI",
            if count == 1 { "" } else { "s" },
            settings.target_dpi as u32
        )),
        Err(error) => warnings.push(format!("Image optimization skipped: {error}")),
    }
    Ok(warnings)
}

pub fn compress_arguments(profile: CompressionProfile) -> Vec<&'static str> {
    match profile {
        // Purely structural: original streams are kept byte-for-byte, so the
        // result can never render differently.
        CompressionProfile::Safe => vec!["--object-streams=generate"],
        CompressionProfile::Balanced | CompressionProfile::Small => {
            let mut arguments = vec![
                "--decode-level=generalized",
                "--object-streams=generate",
                "--recompress-flate",
                "--compression-level=9",
            ];
            match profile {
                CompressionProfile::Balanced => {
                    arguments.push("--optimize-images");
                    arguments.push("--jpeg-quality=85");
                    arguments.push("--oi-min-width=128");
                    arguments.push("--oi-min-height=128");
                }
                CompressionProfile::Small => {
                    arguments.push("--optimize-images");
                    arguments.push("--jpeg-quality=65");
                    arguments.push("--oi-min-width=64");
                    arguments.push("--oi-min-height=64");
                }
                CompressionProfile::Safe => unreachable!(),
            }
            arguments
        }
    }
}

#[cfg(feature = "render")]
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

    let pdfium = bind_pdfium(deps)?;
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

/// Encryption arguments for `qpdf` protect, shared with the web engine so the
/// CLI semantics stay defined in one place.
pub fn protect_arguments(
    user_password: &str,
    owner_password: &str,
    permissions: &ProtectPermissions,
) -> Vec<String> {
    let mut arguments = vec![
        "--encrypt".to_string(),
        user_password.to_string(),
        owner_password.to_string(),
        "256".to_string(),
    ];

    if !permissions.allow_printing {
        arguments.push("--print=none".to_string());
    }
    if !permissions.allow_copying {
        arguments.push("--extract=n".to_string());
    }
    if !permissions.allow_modification {
        arguments.push("--modify=none".to_string());
    }

    arguments
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
    for argument in protect_arguments(user_password, owner_password, permissions) {
        command.arg(argument);
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

#[cfg(feature = "render")]
fn bind_pdfium(deps: &DependencySet) -> Result<Pdfium, PdfToolError> {
    let pdfium_path = deps
        .pdf_renderer
        .path
        .as_ref()
        .ok_or_else(|| PdfToolError::MissingDependency("PDFium".to_string()))?;

    match Pdfium::bind_to_library(pdfium_path) {
        Ok(bindings) => Ok(Pdfium::new(bindings)),
        Err(PdfiumError::PdfiumLibraryBindingsAlreadyInitialized) => Ok(Pdfium::default()),
        Err(error) => Err(PdfToolError::ConversionFailed(error.to_string())),
    }
}

fn run_command(command: Command) -> Result<(), PdfToolError> {
    run_command_with_warnings(command).map(|_| ())
}

/// Runs a command and tolerates qpdf's "warnings" exit code (3), collecting
/// the warning lines instead of failing the job.
fn run_command_with_warnings(mut command: Command) -> Result<Vec<String>, PdfToolError> {
    let output = command.output()?;
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let details = if stderr.is_empty() { stdout } else { stderr };

    match output.status.code() {
        Some(0) => Ok(Vec::new()),
        Some(3) => Ok(details
            .lines()
            .map(str::to_string)
            .filter(|line| !line.trim().is_empty())
            .collect()),
        _ => Err(PdfToolError::ConversionFailed(details)),
    }
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

#[cfg(feature = "render")]
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

pub fn build_jpg_pdf(
    inputs: &[PathBuf],
    page_size: &str,
    fit_mode: &str,
    margin_mm: f32,
) -> Result<Vec<u8>, PdfToolError> {
    let mut images = Vec::new();
    for input in inputs {
        images.push(fs::read(input)?);
    }
    build_jpg_pdf_from_bytes(&images, page_size, fit_mode, margin_mm)
}

pub fn build_jpg_pdf_from_bytes(
    images: &[Vec<u8>],
    page_size: &str,
    fit_mode: &str,
    margin_mm: f32,
) -> Result<Vec<u8>, PdfToolError> {
    let total = images.len();
    let mut parsed = Vec::new();
    for (index, bytes) in images.iter().enumerate() {
        let info = parse_jpeg_info(bytes).ok_or_else(|| {
            PdfToolError::UnsupportedFile(format!(
                "not a supported JPEG: image {} of {}",
                index + 1,
                total
            ))
        })?;
        parsed.push((bytes, info));
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

    for (index, (bytes, info)) in parsed.iter().enumerate() {
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
    fn safe_profile_keeps_original_streams_intact() {
        let arguments = compress_arguments(CompressionProfile::Safe);
        assert_eq!(arguments, vec!["--object-streams=generate"]);
        assert!(!arguments.contains(&"--recompress-flate"));
        assert!(!arguments.contains(&"--optimize-images"));
    }

    #[test]
    fn balanced_and_small_profiles_enable_image_optimization() {
        let balanced = compress_arguments(CompressionProfile::Balanced);
        assert!(balanced.contains(&"--optimize-images"));
        assert!(balanced.contains(&"--jpeg-quality=85"));

        let small = compress_arguments(CompressionProfile::Small);
        assert!(small.contains(&"--optimize-images"));
        assert!(small.contains(&"--jpeg-quality=65"));
        assert!(small.contains(&"--oi-min-width=64"));
    }

    #[test]
    fn serializes_compression_profiles_as_camel_case() {
        for (profile, name) in [
            (CompressionProfile::Safe, "safe"),
            (CompressionProfile::Balanced, "balanced"),
            (CompressionProfile::Small, "small"),
        ] {
            assert_eq!(serde_json::to_string(&profile).unwrap(), format!("\"{name}\""));
            assert_eq!(
                serde_json::from_str::<CompressionProfile>(&format!("\"{name}\""))
                    .unwrap(),
                profile
            );
        }
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
