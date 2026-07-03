//! Planning artifact linkage types.
//!
//! Existing planning artifact and task seed compatibility records remain in
//! their current engine/server path until migration is planned. The types here
//! link app-native planning records to those compatibility records without
//! copying payloads, creating tasks, or changing promotion authority.

use crate::ids::{MemoryProposalId, PlanningArtifactId, PlanningTaskSeedId, ResearchRunBriefId};

/// Link from an app-native planning record to an existing planning artifact
/// compatibility record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningArtifactLink {
    pub artifact_id: PlanningArtifactId,
    pub compatibility_record_ref: String,
    pub review: PlanningReviewState,
    pub projection_ref: Option<String>,
    pub source_refs: PlanningArtifactSourceRefs,
}

/// Link from an app-native planning record to an existing task seed
/// compatibility record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningTaskSeedLink {
    pub task_seed_id: PlanningTaskSeedId,
    pub compatibility_record_ref: String,
    pub source_artifact_ref: Option<PlanningArtifactId>,
    pub review: PlanningReviewState,
    pub promotion: PlanningTaskSeedPromotionLinkState,
    pub source_refs: PlanningArtifactSourceRefs,
}

/// Review posture mirrored from compatibility records.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PlanningReviewState {
    Draft,
    ReviewRequested,
    Accepted { reviewer_ref: String },
    ChangesRequested { reason: String },
    Rejected { reason: String },
    Superseded,
}

/// Task seed promotion posture. Promotion itself remains task-domain authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PlanningTaskSeedPromotionLinkState {
    NotReady { reason: String },
    Reviewable,
    ReadyForPromotion,
    Promoted { task_ref: String },
    Blocked { reason: String },
}

/// Source refs attached to artifact or task seed links.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningArtifactSourceRefs {
    pub research_run_brief_refs: Vec<ResearchRunBriefId>,
    pub memory_proposal_refs: Vec<MemoryProposalId>,
    pub evidence_refs: Vec<String>,
}

impl PlanningArtifactSourceRefs {
    /// Empty refs for a link that only maps compatibility identity.
    pub fn empty() -> Self {
        Self {
            research_run_brief_refs: Vec::new(),
            memory_proposal_refs: Vec::new(),
            evidence_refs: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifact_link_maps_existing_record_without_payload_migration() {
        let link = PlanningArtifactLink {
            artifact_id: PlanningArtifactId("artifact:planning:vision".to_owned()),
            compatibility_record_ref: "engine-planning-artifact:artifact:planning:vision"
                .to_owned(),
            review: PlanningReviewState::Accepted {
                reviewer_ref: "user:tom".to_owned(),
            },
            projection_ref: Some("nucleus/planning/artifact-planning-vision.toml".to_owned()),
            source_refs: PlanningArtifactSourceRefs::empty(),
        };

        assert_eq!(link.artifact_id.0, "artifact:planning:vision");
        assert!(matches!(link.review, PlanningReviewState::Accepted { .. }));
        assert!(link
            .compatibility_record_ref
            .starts_with("engine-planning-artifact:"));
    }

    #[test]
    fn task_seed_link_preserves_task_domain_promotion_authority() {
        let link = PlanningTaskSeedLink {
            task_seed_id: PlanningTaskSeedId("seed:planning:review".to_owned()),
            compatibility_record_ref: "engine-task-seed:seed:planning:review".to_owned(),
            source_artifact_ref: Some(PlanningArtifactId("artifact:planning:vision".to_owned())),
            review: PlanningReviewState::ReviewRequested,
            promotion: PlanningTaskSeedPromotionLinkState::ReadyForPromotion,
            source_refs: PlanningArtifactSourceRefs::empty(),
        };

        assert_eq!(link.task_seed_id.0, "seed:planning:review");
        assert_eq!(
            link.source_artifact_ref.as_ref().map(|id| id.0.as_str()),
            Some("artifact:planning:vision")
        );
        assert_eq!(
            link.promotion,
            PlanningTaskSeedPromotionLinkState::ReadyForPromotion
        );
    }

    #[test]
    fn memory_and_research_links_are_refs_only() {
        let refs = PlanningArtifactSourceRefs {
            research_run_brief_refs: vec![ResearchRunBriefId("research:brief:planning".to_owned())],
            memory_proposal_refs: vec![MemoryProposalId("memory:proposal:constraint".to_owned())],
            evidence_refs: vec!["evidence:planning:conversation-summary".to_owned()],
        };

        assert_eq!(refs.research_run_brief_refs.len(), 1);
        assert_eq!(refs.memory_proposal_refs.len(), 1);
        assert_eq!(refs.evidence_refs.len(), 1);
    }
}
