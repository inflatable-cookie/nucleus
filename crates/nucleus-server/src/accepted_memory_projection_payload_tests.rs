use nucleus_memory::{AcceptedMemoryStorageBody, MemoryProposalStorageKind};

use crate::accepted_memory_projection_payload::{
    decode_accepted_memory_projection_payload, encode_accepted_memory_projection_payload,
    AcceptedMemoryProjectionPayload, ACCEPTED_MEMORY_PROJECTION_FILE_SCHEMA_VERSION,
};
use crate::accepted_memory_projection_test_fixtures::accepted_memory;

#[test]
fn projected_memory_payload_round_trips_as_sanitized_toml() {
    let record = accepted_memory("memory:payload");
    let payload =
        AcceptedMemoryProjectionPayload::from_accepted_memory_record(&record).expect("payload");

    let encoded = encode_accepted_memory_projection_payload(&payload).expect("encode");
    let decoded = decode_accepted_memory_projection_payload(&encoded).expect("decode");
    let toml = String::from_utf8(encoded).expect("toml");

    assert_eq!(decoded, payload);
    assert_eq!(
        decoded.schema_version,
        ACCEPTED_MEMORY_PROJECTION_FILE_SCHEMA_VERSION
    );
    assert_eq!(decoded.memory_id, "memory:payload");
    assert_eq!(decoded.title, "Use server-owned accepted memory");
    assert_eq!(decoded.accepted_by_ref, record.actors.accepted_by_ref);
    assert!(toml.contains("schema_version = 1"));
    assert!(toml.contains("memory_id = \"memory:payload\""));
    assert!(toml.contains("[body]"));
}

#[test]
fn projected_memory_payload_preserves_sanitized_summary_and_refs_only() {
    let mut record = accepted_memory("memory:summary");
    record.body = AcceptedMemoryStorageBody::Summary {
        summary: "Sanitized summary".to_owned(),
        detail: Some("Sanitized detail".to_owned()),
    };

    let payload =
        AcceptedMemoryProjectionPayload::from_accepted_memory_record(&record).expect("payload");
    let encoded =
        String::from_utf8(encode_accepted_memory_projection_payload(&payload).expect("encode"))
            .expect("toml");

    assert!(encoded.contains("Sanitized summary"));
    assert!(encoded.contains("Sanitized detail"));
    for forbidden in [
        "raw_transcript",
        "provider_payload",
        "terminal_stream",
        "private_note",
        "credential",
        "secret_value",
        "provider_native_memory",
    ] {
        assert!(
            !encoded.contains(forbidden),
            "projection payload leaked {forbidden}"
        );
    }
}

#[test]
fn unsupported_storage_schema_is_rejected_before_projection_payload() {
    let mut record = accepted_memory("memory:unsupported-schema");
    record.schema_version = 999;

    let error = AcceptedMemoryProjectionPayload::from_accepted_memory_record(&record)
        .expect_err("unsupported schema");

    assert!(error
        .reason
        .contains("unsupported accepted memory storage schema"));
}

#[test]
fn unsupported_projection_schema_is_rejected_on_decode() {
    let mut payload = AcceptedMemoryProjectionPayload::from_accepted_memory_record(
        &accepted_memory("memory:future-schema"),
    )
    .expect("payload");
    payload.schema_version = 999;

    let encoded = encode_accepted_memory_projection_payload(&payload).expect("encode");
    let error =
        decode_accepted_memory_projection_payload(&encoded).expect_err("unsupported schema");

    assert!(error
        .reason
        .contains("unsupported accepted memory projection schema"));
}

#[test]
fn provider_native_other_kind_can_be_represented_but_is_not_admission_authority() {
    let mut record = accepted_memory("memory:other-kind");
    record.kind = MemoryProposalStorageKind::Other {
        label: "provider_native_blob".to_owned(),
    };

    let payload =
        AcceptedMemoryProjectionPayload::from_accepted_memory_record(&record).expect("payload");
    let encoded =
        String::from_utf8(encode_accepted_memory_projection_payload(&payload).expect("encode"))
            .expect("toml");

    assert!(encoded.contains("provider_native_blob"));
}
