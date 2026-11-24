//! The T3 provider send limit is measured after expansion of assistant quotes.

use std::collections::BTreeSet;

use reqwest::Url;
use serde_json::{Value, json};

/// The T3 provider message limit in UTF-16 code units.
pub const T3_ASSIGNMENT_LIMIT: usize = 120_000;

/// Count an assignment using T3's input units, including its quote appendix.
///
/// Percent-encoded citation IDs and the longest appendix heading are counted
/// conservatively. Ordinary assignments are measured exactly.
#[must_use]
pub fn assignment_units(text: &str) -> usize {
    const HEAD: &str = "[Assistant quote](";
    let mut size = text.encode_utf16().count();
    let mut refs = BTreeSet::new();
    let mut quotes = Vec::new();
    for (index, _) in text.match_indices(HEAD) {
        let start = index + HEAD.len();
        let Some((href, _)) = text[start..].split_once(')') else {
            continue;
        };
        let Some(citation) = quote(href) else {
            continue;
        };
        // Use the longest possible inline ID for each reference, including duplicates.
        size = size.saturating_sub(HEAD.len() + href.encode_utf16().count() + 1) + 36;
        if refs.insert(href) {
            quotes.push(
                json!({"id":format!("assistant-quote-{}", quotes.len() + 1), "citation":citation}),
            );
        }
    }
    if !quotes.is_empty() {
        let Ok(json) = serde_json::to_string_pretty(&quotes) else {
            return usize::MAX;
        };
        let escaped = json.bytes().filter(|byte| b"<>&".contains(byte)).count() * 5;
        size += 400 + json.encode_utf16().count() + escaped;
    }
    size
}

fn quote(href: &str) -> Option<Value> {
    if !href.starts_with("t3-citation://v1/")
        || href.encode_utf16().count() > 256_168
        || href.chars().any(char::is_whitespace)
    {
        return None;
    }
    let url = Url::parse(href).ok()?;
    let [environment, thread, message]: [&str; 3] = url
        .path()
        .strip_prefix('/')?
        .split('/')
        .collect::<Vec<_>>()
        .try_into()
        .ok()?;
    let fields: std::collections::BTreeMap<_, _> = url.query_pairs().collect();
    let mut value = json!({
        "version":1, "environmentId":environment,"threadId":thread,"messageId":message,
        "start":fields.get("start")?.parse::<u64>().ok()?,
        "end":fields.get("end")?.parse::<u64>().ok()?,
        "text":fields.get("text")?, "prefix":fields.get("prefix")?, "suffix":fields.get("suffix")?,
    });
    if let Some(comment) = fields.get("comment") {
        value["comment"] = json!(comment);
    }
    Some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_assignment_limit_counts_utf16_and_quote_expansion() {
        assert_eq!(assignment_units("a😀"), 3);
        let quote =
            "[Assistant quote](t3-citation://v1/e/t/m?start=0&end=1&text=a&prefix=&suffix=)";
        assert!(assignment_units(quote) > quote.len());
        assert_eq!(assignment_units("an ordinary lane link"), 21);
    }
}
