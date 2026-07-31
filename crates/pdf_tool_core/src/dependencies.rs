use serde::{Deserialize, Serialize};
use std::{
    env,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyInfo {
    pub name: String,
    pub command: String,
    pub path: Option<PathBuf>,
    pub available: bool,
    pub optional: bool,
    pub source: DependencySource,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DependencySource {
    Bundled,
    System,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencySet {
    pub qpdf: DependencyInfo,
    pub ghostscript: DependencyInfo,
    pub pdf_renderer: DependencyInfo,
    pub libreoffice: DependencyInfo,
}

impl DependencySet {
    pub fn has_qpdf(&self) -> bool {
        self.qpdf.available
    }

    pub fn has_ghostscript(&self) -> bool {
        self.ghostscript.available
    }

    pub fn has_pdf_renderer(&self) -> bool {
        self.pdf_renderer.available
    }

    pub fn has_libreoffice(&self) -> bool {
        self.libreoffice.available
    }
}

pub fn detect_dependencies() -> DependencySet {
    detect_dependencies_with_roots(&[])
}

pub fn detect_dependencies_with_roots(roots: &[PathBuf]) -> DependencySet {
    DependencySet {
        qpdf: dependency("qpdf", &["qpdf"], false, roots),
        ghostscript: dependency("Compression engine", &[], true, roots),
        pdf_renderer: dependency(
            "PDFium",
            &["libpdfium.dylib", "pdfium.dll", "libpdfium.so"],
            false,
            roots,
        ),
        libreoffice: dependency("LibreOffice", &["soffice", "libreoffice"], true, roots),
    }
}

fn dependency(
    name: &str,
    candidates: &[&str],
    optional: bool,
    roots: &[PathBuf],
) -> DependencyInfo {
    for candidate in candidates {
        if let Some(path) = find_candidate(candidate, roots) {
            let source = if roots.iter().any(|root| path.starts_with(root)) {
                DependencySource::Bundled
            } else {
                DependencySource::System
            };

            return DependencyInfo {
                name: name.to_string(),
                command: path.to_string_lossy().to_string(),
                path: Some(path),
                available: true,
                optional,
                source,
            };
        }
    }

    DependencyInfo {
        name: name.to_string(),
        command: candidates.first().copied().unwrap_or("todo").to_string(),
        path: None,
        available: false,
        optional,
        source: DependencySource::Unavailable,
    }
}

fn find_candidate(command: &str, roots: &[PathBuf]) -> Option<PathBuf> {
    if command.contains(std::path::MAIN_SEPARATOR) {
        return Path::new(command).exists().then(|| PathBuf::from(command));
    }

    for dir in roots.iter().chain(search_paths().iter()) {
        let candidate = dir.join(command);
        if candidate.exists() {
            return Some(candidate);
        }

        #[cfg(windows)]
        {
            let candidate = dir.join(format!("{command}.exe"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn search_paths() -> Vec<PathBuf> {
    let mut paths = env::var_os("PATH")
        .map(|value| env::split_paths(&value).collect::<Vec<_>>())
        .unwrap_or_default();

    for path in common_tool_paths() {
        if !paths.iter().any(|existing| existing == &path) {
            paths.push(path);
        }
    }

    paths
}

fn common_tool_paths() -> Vec<PathBuf> {
    let mut paths = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
    ];

    #[cfg(target_os = "macos")]
    {
        paths.push(PathBuf::from(
            "/Applications/LibreOffice.app/Contents/MacOS",
        ));
    }

    paths
}
