use pdf_tool_core::{
    render_pdf_preview, run_job_with_dependency_roots, JobRequest, Operation, PdfPreviewRequest,
};
use std::{fs, path::PathBuf};
use uuid::Uuid;

#[test]
fn reuses_bundled_pdfium_for_preview_and_pdf_to_jpg() {
    let workspace_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..");
    let resource_root = workspace_root
        .join("src-tauri")
        .join("resources")
        .join("bin")
        .join(platform_key());

    if !resource_root.join(pdfium_library_name()).exists() {
        return;
    }

    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("input.pdf");
    let output = temp.path().join("jpg");
    fs::write(&input, minimal_pdf()).unwrap();

    let preview = render_pdf_preview(
        PdfPreviewRequest {
            input: input.clone(),
            max_pages: Some(1),
            pages: None,
            width: Some(120),
            quality: Some(72),
        },
        &[resource_root.clone()],
    )
    .unwrap();
    assert_eq!(preview.page_count, 1);
    assert_eq!(preview.pages.len(), 1);
    assert!(preview.pages[0]
        .data_url
        .starts_with("data:image/jpeg;base64,"));

    let result = run_job_with_dependency_roots(
        JobRequest {
            id: Uuid::new_v4(),
            operation: Operation::PdfToJpg {
                input: input.clone(),
                dpi: 96,
                first_page: None,
                last_page: None,
                quality: 85,
            },
            output: Some(output),
        },
        &[resource_root],
    )
    .unwrap();

    assert_eq!(result.outputs.len(), 1);
    assert!(result.outputs[0].is_file());
    assert!(fs::metadata(&result.outputs[0]).unwrap().len() > 0);
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
}

fn pdfium_library_name() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "libpdfium.dylib"
    }
    #[cfg(target_os = "windows")]
    {
        "pdfium.dll"
    }
    #[cfg(target_os = "linux")]
    {
        "libpdfium.so"
    }
}

fn minimal_pdf() -> &'static [u8] {
    b"%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>
endobj
4 0 obj
<< /Length 44 >>
stream
0.2 0.5 0.8 rg
20 20 160 160 re
f
endstream
endobj
xref
0 5
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000202 00000 n 
trailer
<< /Size 5 /Root 1 0 R >>
startxref
296
%%EOF
"
}
