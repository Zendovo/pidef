use pdf_tool_core::{
    detect_dependencies, run_job, DependencySet, JobRequest, JobResult, OperationOptions, ToolId,
};
use std::{fs, path::PathBuf};

#[tauri::command]
fn get_dependencies() -> DependencySet {
    detect_dependencies()
}

#[tauri::command]
fn get_operation_options() -> Vec<OperationOptions> {
    let deps = detect_dependencies();
    vec![
        option(ToolId::MergePdf, &["qpdf"], deps.has_qpdf()),
        option(ToolId::SplitPdf, &["qpdf"], deps.has_qpdf()),
        option(ToolId::OrganizePdf, &["qpdf"], deps.has_qpdf()),
        option(
            ToolId::CompressPdf,
            &["Ghostscript"],
            deps.has_ghostscript(),
        ),
        option(ToolId::PdfToJpg, &["pdftoppm"], deps.has_pdf_renderer()),
        option(ToolId::JpgToPdf, &[], true),
        option(ToolId::PptToPdf, &["LibreOffice"], deps.has_libreoffice()),
        option(ToolId::WordToPdf, &["LibreOffice"], deps.has_libreoffice()),
        option(ToolId::UnlockPdf, &["qpdf"], deps.has_qpdf()),
        option(ToolId::ProtectPdf, &["qpdf"], deps.has_qpdf()),
    ]
}

#[tauri::command]
fn execute_job(request: JobRequest) -> Result<JobResult, String> {
    run_job(request).map_err(|error| error.to_string())
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

fn copy_dir_all(source: &PathBuf, destination: &PathBuf) -> std::io::Result<()> {
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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_dependencies,
            get_operation_options,
            execute_job,
            save_output
        ])
        .run(tauri::generate_context!())
        .expect("error while running Local PDF Tool");
}
