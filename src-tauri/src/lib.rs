use pdf_tool_core::{
    detect_dependencies_with_roots, render_pdf_preview, run_job_with_dependency_roots,
    DependencySet, JobRequest, JobResult, OperationOptions, PdfPreview, PdfPreviewRequest, ToolId,
};
use std::{
    fs,
    path::{Path, PathBuf},
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
        option(ToolId::CompressPdf, &["qpdf"], deps.has_qpdf()),
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

#[tauri::command]
fn set_native_sidebar_collapsed(app: AppHandle, collapsed: bool) -> Result<(), String> {
    macos_native_shell::set_sidebar_collapsed(&app, collapsed)
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

fn option(tool: ToolId, requires: &[&str], available: bool) -> OperationOptions {
    OperationOptions {
        tool,
        requires: requires.iter().map(|value| (*value).to_string()).collect(),
        unavailable_reason: (!available)
            .then(|| format!("Missing required dependency: {}", requires.join(", "))),
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
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
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
            set_appearance,
            set_native_sidebar_collapsed
        ])
        .run(tauri::generate_context!())
        .expect("error while running Pidef");
}
