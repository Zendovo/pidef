use pdf_tool_core::{
    detect_dependencies_with_roots, render_pdf_preview, run_job_with_dependency_roots,
    DependencySet, JobRequest, JobResult, OperationOptions, PdfPreview, PdfPreviewRequest, ToolId,
};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, Theme};

mod macos_native_shell;

#[tauri::command]
fn get_dependencies(app: AppHandle) -> DependencySet {
    detect_dependencies_with_roots(&bundled_engine_roots(&app))
}

#[tauri::command]
fn get_operation_options(app: AppHandle) -> Vec<OperationOptions> {
    let deps = detect_dependencies_with_roots(&bundled_engine_roots(&app));
    vec![
        option(ToolId::MergePdf, &["qpdf"], deps.has_qpdf()),
        option(ToolId::SplitPdf, &["qpdf"], deps.has_qpdf()),
        option(ToolId::OrganizePdf, &["qpdf"], deps.has_qpdf()),
        unavailable_option(
            ToolId::CompressPdf,
            &["compression TODO"],
            "Compression is a planned in-house feature and is intentionally disabled for now",
        ),
        option(ToolId::PdfToJpg, &["PDFium"], deps.has_pdf_renderer()),
        option(ToolId::JpgToPdf, &[], true),
        option(ToolId::PptToPdf, &["LibreOffice"], deps.has_libreoffice()),
        option(ToolId::WordToPdf, &["LibreOffice"], deps.has_libreoffice()),
        option(ToolId::UnlockPdf, &["qpdf"], deps.has_qpdf()),
        option(ToolId::ProtectPdf, &["qpdf"], deps.has_qpdf()),
    ]
}

#[tauri::command]
fn execute_job(app: AppHandle, request: JobRequest) -> Result<JobResult, String> {
    run_job_with_dependency_roots(request, &bundled_engine_roots(&app))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_pdf_preview(app: AppHandle, request: PdfPreviewRequest) -> Result<PdfPreview, String> {
    render_pdf_preview(request, &bundled_engine_roots(&app)).map_err(|error| error.to_string())
}

#[tauri::command]
fn save_output(source: PathBuf, destination: PathBuf) -> Result<(), String> {
    if source.is_dir() {
        copy_dir_all(&source, &destination).map_err(|error| error.to_string())
    } else {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::copy(&source, &destination)
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}

#[tauri::command]
fn archive_outputs(app: AppHandle, sources: Vec<PathBuf>) -> Result<Vec<PathBuf>, String> {
    if sources.is_empty() {
        return Ok(Vec::new());
    }

    let documents = app
        .path()
        .document_dir()
        .map_err(|error| error.to_string())?;
    let archive_dir = documents
        .join("Pidef")
        .join("Outputs")
        .join(timestamp_folder());
    fs::create_dir_all(&archive_dir).map_err(|error| error.to_string())?;

    let mut archived = Vec::new();
    for source in sources {
        let destination = archive_dir.join(
            source
                .file_name()
                .unwrap_or_else(|| std::ffi::OsStr::new("output")),
        );
        copy_path(&source, &destination).map_err(|error| error.to_string())?;
        archived.push(destination);
    }

    Ok(archived)
}

#[tauri::command]
fn set_appearance(app: AppHandle, appearance: String) -> Result<(), String> {
    let theme = match appearance.as_str() {
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        "system" => None,
        _ => return Err(format!("Unknown appearance mode: {appearance}")),
    };

    app.set_theme(theme);
    Ok(())
}

fn copy_path(source: &Path, destination: &Path) -> std::io::Result<()> {
    if source.is_dir() {
        copy_dir_all(source, destination)
    } else {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(source, destination).map(|_| ())
    }
}

fn copy_dir_all(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if source_path.is_dir() {
            copy_dir_all(&source_path, &destination_path)?;
        } else {
            fs::copy(source_path, destination_path)?;
        }
    }
    Ok(())
}

fn timestamp_folder() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    seconds.to_string()
}

fn option(tool: ToolId, requires: &[&str], available: bool) -> OperationOptions {
    OperationOptions {
        tool,
        requires: requires.iter().map(|value| (*value).to_string()).collect(),
        unavailable_reason: (!available)
            .then(|| format!("Missing required dependency: {}", requires.join(", "))),
    }
}

fn unavailable_option(tool: ToolId, requires: &[&str], reason: &str) -> OperationOptions {
    OperationOptions {
        tool,
        requires: requires.iter().map(|value| (*value).to_string()).collect(),
        unavailable_reason: Some(reason.to_string()),
    }
}

fn bundled_engine_roots(app: &AppHandle) -> Vec<PathBuf> {
    let mut roots = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        roots.push(
            resource_dir
                .join("resources")
                .join("bin")
                .join(platform_key()),
        );
        roots.push(resource_dir.join("resources").join("bin"));
        roots.push(resource_dir.join("bin").join(platform_key()));
        roots.push(resource_dir.join("bin"));
    }

    roots
}

fn platform_key() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "macos-aarch64"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "macos-x86_64"
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "windows-x86_64"
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "linux-x86_64"
    }
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64")
    )))]
    {
        "unknown"
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            macos_native_shell::install(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_dependencies,
            get_operation_options,
            execute_job,
            get_pdf_preview,
            save_output,
            archive_outputs,
            set_appearance
        ])
        .run(tauri::generate_context!())
        .expect("error while running Pidef");
}
