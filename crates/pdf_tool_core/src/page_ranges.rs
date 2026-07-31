use crate::PdfToolError;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PageSelection {
    Single(u32),
    Range { start: u32, end: u32 },
}

pub fn parse_page_ranges(input: &str) -> Result<Vec<PageSelection>, PdfToolError> {
    let mut selections = Vec::new();

    for raw_part in input.split(',') {
        let part = raw_part.trim();
        if part.is_empty() {
            continue;
        }

        if let Some((start, end)) = part.split_once('-') {
            let start = parse_page(start)?;
            let end = parse_page(end)?;
            if start > end {
                return Err(PdfToolError::InvalidRequest(format!(
                    "page range starts after it ends: {part}"
                )));
            }
            selections.push(PageSelection::Range { start, end });
        } else {
            selections.push(PageSelection::Single(parse_page(part)?));
        }
    }

    if selections.is_empty() {
        return Err(PdfToolError::InvalidRequest(
            "at least one page or range is required".to_string(),
        ));
    }

    Ok(selections)
}

fn parse_page(value: &str) -> Result<u32, PdfToolError> {
    let page = value
        .trim()
        .parse::<u32>()
        .map_err(|_| PdfToolError::InvalidRequest(format!("invalid page number: {value}")))?;

    if page == 0 {
        return Err(PdfToolError::InvalidRequest(
            "page numbers start at 1".to_string(),
        ));
    }

    Ok(page)
}

pub fn qpdf_range(selection: &PageSelection) -> String {
    match selection {
        PageSelection::Single(page) => page.to_string(),
        PageSelection::Range { start, end } => format!("{start}-{end}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_mixed_ranges() {
        let ranges = parse_page_ranges("1, 3-5, 9").unwrap();
        assert_eq!(
            ranges,
            vec![
                PageSelection::Single(1),
                PageSelection::Range { start: 3, end: 5 },
                PageSelection::Single(9)
            ]
        );
    }

    #[test]
    fn rejects_zero() {
        assert!(parse_page_ranges("0").is_err());
    }

    #[test]
    fn rejects_reversed_range() {
        assert!(parse_page_ranges("9-3").is_err());
    }
}
