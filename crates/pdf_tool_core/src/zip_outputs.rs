use crate::PdfToolError;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Bundles the given outputs into a single ZIP archive ("Package into ZIP").
pub fn zip_outputs(sources: &[PathBuf], destination: &Path) -> Result<(), PdfToolError> {
    let file = fs::File::create(destination)?;
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    for source in sources {
        let name = source
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("output.pdf")
            .to_string();
        writer
            .start_file(name, options)
            .map_err(|error| PdfToolError::ConversionFailed(error.to_string()))?;
        let bytes = fs::read(source)?;
        writer.write_all(&bytes)?;
    }

    writer
        .finish()
        .map_err(|error| PdfToolError::ConversionFailed(error.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundles_outputs_into_a_zip() {
        let temp = tempfile::tempdir().unwrap();
        let first = temp.path().join("a_part_1.pdf");
        let second = temp.path().join("a_part_2.pdf");
        fs::write(&first, b"first").unwrap();
        fs::write(&second, b"second").unwrap();

        let destination = temp.path().join("bundle.zip");
        zip_outputs(&[first.clone(), second.clone()], &destination).unwrap();

        let file = fs::File::open(&destination).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        assert_eq!(archive.len(), 2);

        let mut names: Vec<String> = Vec::new();
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).unwrap();
            names.push(entry.name().unwrap().to_string());
            let mut content = String::new();
            use std::io::Read;
            entry.read_to_string(&mut content).unwrap();
            assert!(content == "first" || content == "second");
        }
        names.sort();
        assert_eq!(names, vec!["a_part_1.pdf", "a_part_2.pdf"]);
    }
}
