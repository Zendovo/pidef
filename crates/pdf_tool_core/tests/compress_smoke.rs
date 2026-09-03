use pdf_tool_core::{run_job_with_dependency_roots, CompressionProfile, JobRequest, Operation};
use std::{fs, path::PathBuf};
use uuid::Uuid;

#[test]
fn compresses_uncompressed_streams_with_safe_profile() {
    let workspace_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..");
    let resource_root = workspace_root
        .join("src-tauri")
        .join("resources")
        .join("bin")
        .join(platform_key());

    if !resource_root.join("qpdf").exists() {
        return;
    }

    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("input.pdf");
    let output = temp.path().join("compressed.pdf");
    fs::write(&input, uncompressed_stream_pdf()).unwrap();

    let result = run_job_with_dependency_roots(
        JobRequest {
            id: Uuid::new_v4(),
            operation: Operation::CompressPdf {
                input: input.clone(),
                profile: CompressionProfile::Safe,
            },
            output: Some(output),
        },
        &[resource_root],
    )
    .unwrap();

    assert_eq!(result.outputs.len(), 1);
    assert!(result.outputs[0].is_file());
    assert!(result.warnings.is_empty());
    let input_bytes = result.input_bytes.unwrap();
    let output_bytes = result.output_bytes.unwrap();
    assert!(
        output_bytes * 2 < input_bytes,
        "expected safe compression to halve {input_bytes} bytes, got {output_bytes}"
    );
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

/// A PDF whose content stream is stored uncompressed (no /Filter) with highly
/// repetitive operators, so flate recompression should shrink it dramatically.
fn uncompressed_stream_pdf() -> Vec<u8> {
    let mut content = String::new();
    for index in 0..4000u32 {
        let x = (index % 40) * 5;
        let y = (index / 40) * 5;
        content.push_str(&format!(
            "{:.2} {:.2} {:.2} rg {x} {y} 4 4 re f\n",
            (index % 10) as f32 / 10.0,
            (index % 7) as f32 / 7.0,
            (index % 5) as f32 / 5.0
        ));
    }

    let objects: Vec<Vec<u8>> = vec![
        b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
        format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>"
        )
        .into_bytes(),
        format!("<< /Length {} >>\nstream\n{}\nendstream", content.len(), content).into_bytes(),
    ];

    let mut pdf = b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n".to_vec();
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
