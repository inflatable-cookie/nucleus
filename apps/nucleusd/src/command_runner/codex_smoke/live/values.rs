use serde_json::Value;

pub(super) fn string_field<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("codex response missing string field `{field}`"))
}

pub(super) fn turn_field_from_start_response(
    response: &Value,
    field: &str,
) -> Result<String, String> {
    let turn = response
        .get("turn")
        .ok_or_else(|| "codex turn/start response missing turn".to_owned())?;
    string_field(turn, field).map(str::to_owned)
}
