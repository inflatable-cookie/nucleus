pub(super) fn source_status(record_count: usize) -> String {
    if record_count == 0 {
        "empty".to_owned()
    } else {
        "records".to_owned()
    }
}

pub(super) fn source_summary(record_count: usize, empty: &str, records: &str) -> String {
    if record_count == 0 {
        empty.to_owned()
    } else {
        records.to_owned()
    }
}
