use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ToolId {
    MergePdf,
    SplitPdf,
    OrganizePdf,
    CompressPdf,
    PdfToJpg,
    JpgToPdf,
    PptToPdf,
    WordToPdf,
    UnlockPdf,
    ProtectPdf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRequest {
    pub id: Uuid,
    pub operation: Operation,
    pub output: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Operation {
    MergePdf {
        inputs: Vec<PathBuf>,
    },
    SplitPdf {
        input: PathBuf,
        ranges: String,
        output_pattern: String,
    },
    OrganizePdf {
        input: PathBuf,
        pages: Vec<OrganizePage>,
    },
    CompressPdf {
        input: PathBuf,
        profile: CompressionProfile,
    },
    PdfToJpg {
        input: PathBuf,
        dpi: u16,
        first_page: Option<u32>,
        last_page: Option<u32>,
        quality: u8,
    },
    JpgToPdf {
        inputs: Vec<PathBuf>,
        page_size: String,
        fit_mode: String,
        margin_mm: f32,
    },
    PptToPdf {
        input: PathBuf,
    },
    WordToPdf {
        input: PathBuf,
    },
    UnlockPdf {
        input: PathBuf,
        password: String,
    },
    ProtectPdf {
        input: PathBuf,
        user_password: String,
        owner_password: String,
        permissions: ProtectPermissions,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizePage {
    pub source_page: u32,
    pub rotate_degrees: i16,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CompressionProfile {
    Safe,
    Balanced,
    Small,
}

impl CompressionProfile {
    pub fn label(self) -> &'static str {
        match self {
            CompressionProfile::Safe => "Safe",
            CompressionProfile::Balanced => "Balanced",
            CompressionProfile::Small => "Small",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtectPermissions {
    pub allow_printing: bool,
    pub allow_copying: bool,
    pub allow_modification: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobProgress {
    pub id: Uuid,
    pub percent: u8,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobResult {
    pub id: Uuid,
    pub outputs: Vec<PathBuf>,
    pub warnings: Vec<String>,
    pub input_bytes: Option<u64>,
    pub output_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationOptions {
    pub tool: ToolId,
    pub requires: Vec<String>,
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfPreviewRequest {
    pub input: PathBuf,
    pub max_pages: Option<u16>,
    pub width: Option<i32>,
    pub quality: Option<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfPreviewPage {
    pub page_number: u32,
    pub width: u32,
    pub height: u32,
    pub data_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfPreview {
    pub page_count: u32,
    pub pages: Vec<PdfPreviewPage>,
}

#[derive(Debug, Error)]
pub enum PdfToolError {
    #[error("missing dependency: {0}")]
    MissingDependency(String),
    #[error("invalid password or encrypted file could not be opened")]
    InvalidPassword,
    #[error("unsupported file: {0}")]
    UnsupportedFile(String),
    #[error("output already exists: {0}")]
    OutputConflict(String),
    #[error("invalid request: {0}")]
    InvalidRequest(String),
    #[error("conversion failed: {0}")]
    ConversionFailed(String),
    #[error("io error: {0}")]
    Io(String),
}

impl From<std::io::Error> for PdfToolError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value.to_string())
    }
}
