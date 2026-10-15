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
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
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

    /// Image resampling targets for the lossy presets. `None` keeps the
    /// preset fully lossless.
    pub fn image_settings(self) -> Option<crate::ImageOptimizeSettings> {
        match self {
            CompressionProfile::Safe => None,
            CompressionProfile::Balanced => Some(crate::ImageOptimizeSettings {
                target_dpi: 150.0,
                trigger_dpi: 225.0,
                jpeg_quality: 85,
            }),
            CompressionProfile::Small => Some(crate::ImageOptimizeSettings {
                target_dpi: 100.0,
                trigger_dpi: 150.0,
                jpeg_quality: 65,
            }),
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
    /// Render only these 1-based page numbers (used for zoomed views).
    pub pages: Option<Vec<u32>>,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserializes_camel_case_fields_from_frontend() {
        let split: Operation = serde_json::from_str(
            r#"{"kind":"splitPdf","input":"/tmp/a.pdf","ranges":"1, 2-3","outputPattern":"split-{n}.pdf"}"#,
        )
        .unwrap();
        assert!(matches!(
            split,
            Operation::SplitPdf { output_pattern, .. } if output_pattern == "split-{n}.pdf"
        ));

        let pdf_to_jpg: Operation = serde_json::from_str(
            r#"{"kind":"pdfToJpg","input":"/tmp/a.pdf","dpi":200,"firstPage":null,"lastPage":null,"quality":90}"#,
        )
        .unwrap();
        assert!(matches!(
            pdf_to_jpg,
            Operation::PdfToJpg { first_page: None, last_page: None, .. }
        ));

        let protect: Operation = serde_json::from_str(
            r#"{"kind":"protectPdf","input":"/tmp/a.pdf","userPassword":"u","ownerPassword":"o","permissions":{"allowPrinting":true,"allowCopying":false,"allowModification":false}}"#,
        )
        .unwrap();
        assert!(matches!(
            protect,
            Operation::ProtectPdf {
                permissions: ProtectPermissions { allow_copying: false, .. },
                ..
            }
        ));

        let organize_page: OrganizePage =
            serde_json::from_str(r#"{"sourcePage":3,"rotateDegrees":90}"#).unwrap();
        assert_eq!(organize_page.source_page, 3);
    }

    #[test]
    fn serializes_camel_case_fields_round_trip() {
        let operation = Operation::ProtectPdf {
            input: "/tmp/a.pdf".into(),
            user_password: "u".into(),
            owner_password: "o".into(),
            permissions: ProtectPermissions {
                allow_printing: true,
                allow_copying: true,
                allow_modification: false,
            },
        };
        let json = serde_json::to_string(&operation).unwrap();
        assert!(json.contains("userPassword"));
        assert!(json.contains("allowPrinting"));
        let round_trip: Operation = serde_json::from_str(&json).unwrap();
        assert_eq!(serde_json::to_value(&round_trip).unwrap(), serde_json::to_value(&operation).unwrap());
    }
}
