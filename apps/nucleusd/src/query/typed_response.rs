//! Generic typed-response rendering.
//!
//! Every control DTO renders through one serde-driven flattener instead of a
//! hand-written per-query lines module. Output shape: `domain=<label>`, the
//! body's `type=<variant>` tag, then `key=value` lines with dotted prefixes
//! for nested records and `<key>_count` lines for arrays.

use nucleus_server::{ControlResponseBodyDto, ControlResponseEnvelopeDto};
use serde_json::Value;

pub(super) fn print_typed_dto_response(
    label: &str,
    dto: ControlResponseEnvelopeDto,
) -> Result<(), String> {
    if dto.status != nucleus_server::ControlResponseStatusDto::Complete {
        return Err(format!("{label} query returned status {:?}", dto.status));
    }
    for line in typed_response_lines(label, &dto.body)? {
        println!("{line}");
    }
    Ok(())
}

pub(super) fn typed_response_lines(
    label: &str,
    body: &ControlResponseBodyDto,
) -> Result<Vec<String>, String> {
    let value = serde_json::to_value(body)
        .map_err(|error| format!("{label} response serialization failed: {error}"))?;
    let mut lines = vec![format!("domain={label}")];
    flatten("", &value, &mut lines);
    Ok(lines)
}

/// Field names that must never reach rendered output, regardless of DTO
/// shape. DTOs are sanitized by construction; this is the belt to that
/// suspenders, guaranteed by one test instead of hundreds of greps.
fn forbidden_key(key: &str) -> bool {
    key.contains("raw_payload")
        || key.contains("raw_stdout")
        || key.contains("raw_stderr")
        || key.contains("secret")
        || key.contains("credential_material")
        || key.starts_with("private")
}

fn flatten(prefix: &str, value: &Value, lines: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                if forbidden_key(key) {
                    continue;
                }
                let child_prefix = if prefix.is_empty() {
                    key.clone()
                } else {
                    format!("{prefix}.{key}")
                };
                flatten(&child_prefix, child, lines);
            }
        }
        Value::Array(items) => {
            lines.push(format!("{prefix}_count={}", items.len()));
            for (index, item) in items.iter().enumerate() {
                flatten(&format!("{prefix}.{index}"), item, lines);
            }
        }
        Value::Null => lines.push(format!("{prefix}=none")),
        Value::Bool(flag) => lines.push(format!("{prefix}={flag}")),
        Value::Number(number) => lines.push(format!("{prefix}={number}")),
        Value::String(text) => lines.push(format!("{prefix}={text}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renderer_flattens_variant_tag_fields_and_arrays() {
        let body = ControlResponseBodyDto::QueryUnsupported {
            reason: "not wired".to_owned(),
        };
        let lines = typed_response_lines("demo", &body).expect("render");

        assert_eq!(lines[0], "domain=demo");
        assert!(lines.contains(&"type=query_unsupported".to_owned()));
        assert!(lines.contains(&"reason=not wired".to_owned()));
    }

    #[test]
    fn renderer_never_emits_forbidden_keys() {
        // Property-style guard over the flattener itself: any DTO shape that
        // ever grows a forbidden field name is dropped at render time.
        let value = serde_json::json!({
            "ok_field": "visible",
            "raw_payload": "must-not-appear",
            "raw_stdout_bytes": "must-not-appear",
            "provider_secret": "must-not-appear",
            "private_note": "must-not-appear",
            "nested": { "raw_payload_ref": "must-not-appear", "kept": 1 },
        });
        let mut lines = vec![];
        flatten("", &value, &mut lines);
        let rendered = lines.join("\n");

        assert!(rendered.contains("ok_field=visible"));
        assert!(rendered.contains("nested.kept=1"));
        assert!(!rendered.contains("must-not-appear"));
    }
}
