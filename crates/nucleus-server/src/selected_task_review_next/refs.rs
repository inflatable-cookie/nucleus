use std::collections::HashSet;

pub(super) fn clean_refs(refs: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut cleaned = refs
        .into_iter()
        .map(|reference| reference.trim().to_owned())
        .filter(|reference| !reference.is_empty())
        .filter(|reference| seen.insert(reference.clone()))
        .collect::<Vec<_>>();
    cleaned.sort();
    cleaned
}

pub(super) fn clean_optional(value: String) -> Option<String> {
    let value = value.trim().to_owned();
    (!value.is_empty()).then_some(value)
}
