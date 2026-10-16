mod dependencies;
mod image_optimize;
mod jobs;
mod operations;
mod page_ranges;
mod zip_outputs;

pub use dependencies::{
    detect_dependencies, detect_dependencies_with_roots, DependencyInfo, DependencySet,
};
pub use image_optimize::{
    downsample_dct_images, downsample_dct_images_bytes, ImageOptimizeSettings,
};
pub use jobs::{
    CompressionProfile, JobProgress, JobRequest, JobResult, Operation, OperationOptions,
    OrganizePage, PdfPreview, PdfPreviewPage, PdfPreviewRequest, PdfToolError, ProtectPermissions,
    ToolId,
};
#[cfg(feature = "render")]
pub use operations::render_pdf_preview;
pub use operations::{
    build_jpg_pdf, build_jpg_pdf_from_bytes, compress_arguments, page_spec, protect_arguments,
    run_job, run_job_with_dependency_roots,
};
pub use page_ranges::{parse_page_ranges, qpdf_range, PageSelection};
pub use zip_outputs::zip_outputs;
