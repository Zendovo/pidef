use pdf_tool_core::{
    build_jpg_pdf, run_job_with_dependency_roots, CompressionProfile, JobRequest, Operation,
};
use std::{fs, path::PathBuf, process::Command};
use uuid::Uuid;

#[test]
fn downsamples_high_resolution_images_when_compressing() {
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

    let source_image = image::RgbImage::from_fn(2600, 1800, |x, y| {
        let width = f64::from(2600 - 1);
        let height = f64::from(1800 - 1);
        image::Rgb([
            (f64::from(x) / width * 255.0) as u8,
            (f64::from(y) / height * 255.0) as u8,
            ((f64::from(x) + f64::from(y)) / (width + height) * 255.0) as u8,
        ])
    });
    let jpeg_path = temp.path().join("photo.jpg");
    image::DynamicImage::ImageRgb8(source_image)
        .save_with_format(&jpeg_path, image::ImageFormat::Jpeg)
        .unwrap();

    let input = temp.path().join("input.pdf");
    fs::write(
        &input,
        build_jpg_pdf(&[jpeg_path], "a4", "fit", 0.0).unwrap(),
    )
    .unwrap();

    let output = temp.path().join("compressed.pdf");
    let result = run_job_with_dependency_roots(
        JobRequest {
            id: Uuid::new_v4(),
            operation: Operation::CompressPdf {
                input: input.clone(),
                profile: CompressionProfile::Balanced,
            },
            output: Some(output),
        },
        &[resource_root.clone()],
    )
    .unwrap();

    let input_bytes = result.input_bytes.unwrap();
    let output_bytes = result.output_bytes.unwrap();
    assert!(
        output_bytes < input_bytes,
        "expected lossy compression to reduce {input_bytes} bytes, got {output_bytes}"
    );
    assert!(
        result
            .warnings
            .iter()
            .any(|warning| warning.contains("Downsampled")),
        "expected a downsample warning, got {:?}",
        result.warnings
    );

    // The rewritten output must be a valid PDF.
    let check = Command::new(resource_root.join("qpdf"))
        .arg("--check")
        .arg(result.outputs[0].clone())
        .output()
        .unwrap();
    let code = check.status.code();
    assert!(
        code == Some(0) || code == Some(3),
        "qpdf --check failed: {} {}",
        String::from_utf8_lossy(&check.stdout),
        String::from_utf8_lossy(&check.stderr)
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
