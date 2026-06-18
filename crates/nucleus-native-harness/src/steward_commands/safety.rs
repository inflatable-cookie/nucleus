pub(super) fn contains_forbidden_steward_command_term(value: &str) -> bool {
    [
        "raw_stdout",
        "raw_stderr",
        "terminal stream",
        "provider payload",
        "model raw output",
        "secret",
        "credential",
        "token",
        "push",
        "publish",
        "forge credential",
    ]
    .iter()
    .any(|term| value.to_lowercase().contains(term))
}
