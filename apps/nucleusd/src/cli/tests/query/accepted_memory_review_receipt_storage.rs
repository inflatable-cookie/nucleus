use crate::cli::{CliConfig, QueryDomain};

#[test]
fn cli_config_parses_accepted_memory_review_receipt_storage_query_domain() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "accepted-memory-review-receipt-storage-diagnostics".to_owned(),
        "--project".to_owned(),
        "project:nucleus-local".to_owned(),
    ])
    .expect("parse accepted memory review receipt storage diagnostics query");

    assert_eq!(
        config.query,
        Some(QueryDomain::AcceptedMemoryReviewReceiptStorageDiagnostics {
            project_id: "project:nucleus-local".to_owned()
        })
    );
}
