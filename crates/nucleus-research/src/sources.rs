//! Research source reference records.
//!
//! Source refs preserve provenance without storing raw browser caches,
//! copyrighted source payloads, raw transcripts, provider payloads, private
//! notes, credentials, or secret-bearing files.

use std::time::SystemTime;

use crate::ids::{ResearchRunBriefId, ResearchSourceId};

/// Provenance record for a research source.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResearchSourceRef {
    pub id: ResearchSourceId,
    pub run_id: ResearchRunBriefId,
    pub kind: ResearchSourceKind,
    pub locator: String,
    pub accessed_at: Option<SystemTime>,
    pub author_or_publisher: Option<String>,
    pub published_or_updated_at: Option<String>,
    pub retrieval_method: ResearchRetrievalMethodHint,
    pub reliability: ResearchSourceReliability,
    pub quote_or_license_note: Option<String>,
    pub retained_artifact_refs: Vec<String>,
}

impl ResearchSourceRef {
    /// Source refs preserve provenance. They do not store source payloads.
    pub fn stores_raw_source_payload(&self) -> bool {
        false
    }

    /// Retrieval method is a hint about provenance, not a command to retrieve.
    pub fn grants_retrieval_authority(&self) -> bool {
        false
    }

    /// Model-generated leads must be traced or accepted as speculation before
    /// they are treated as evidence.
    pub fn is_evidence_by_default(&self) -> bool {
        !matches!(self.kind, ResearchSourceKind::ModelGeneratedLead)
    }
}

/// Source category.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ResearchSourceKind {
    WebPage,
    OfficialDocs,
    SourceRepository,
    CodeFile,
    IssueOrDiscussion,
    Paper,
    Pdf,
    PackageRegistry,
    LocalFile,
    HumanNote,
    ModelGeneratedLead,
    Custom(String),
}

/// Retrieval method hint captured after or before source handling.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ResearchRetrievalMethodHint {
    Planned,
    Manual,
    Browser,
    Api,
    LocalFile,
    RepositoryCheckout,
    ModelGeneratedLead,
    Custom(String),
}

/// Coarse source reliability posture.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResearchSourceReliability {
    Unknown,
    Official,
    Primary,
    Secondary,
    Community,
    ModelLead,
    Low,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(kind: ResearchSourceKind) -> ResearchSourceRef {
        ResearchSourceRef {
            id: ResearchSourceId("research-source:harness:official-docs".to_owned()),
            run_id: ResearchRunBriefId("research-run:harness".to_owned()),
            kind,
            locator: "https://example.invalid/docs".to_owned(),
            accessed_at: None,
            author_or_publisher: Some("Example".to_owned()),
            published_or_updated_at: None,
            retrieval_method: ResearchRetrievalMethodHint::Planned,
            reliability: ResearchSourceReliability::Official,
            quote_or_license_note: Some("Link only until quote policy exists.".to_owned()),
            retained_artifact_refs: Vec::new(),
        }
    }

    #[test]
    fn source_refs_preserve_provenance_without_payloads() {
        let source = source(ResearchSourceKind::OfficialDocs);

        assert_eq!(source.run_id.0, "research-run:harness");
        assert_eq!(source.kind, ResearchSourceKind::OfficialDocs);
        assert!(!source.stores_raw_source_payload());
        assert!(!source.grants_retrieval_authority());
    }

    #[test]
    fn model_generated_leads_are_not_evidence_by_default() {
        let source = source(ResearchSourceKind::ModelGeneratedLead);

        assert!(!source.is_evidence_by_default());
        assert!(!source.stores_raw_source_payload());
    }
}
