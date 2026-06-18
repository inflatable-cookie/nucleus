pub(super) fn contains_forbidden_effigy_term(value: &str) -> bool {
    [
        "raw_stdout",
        "raw_stderr",
        "secret",
        "credential",
        "token",
        "local cache",
        "provider transcript",
    ]
    .iter()
    .any(|term| value.to_lowercase().contains(term))
}
