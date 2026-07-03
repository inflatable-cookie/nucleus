//! Guided planning session state.
//!
//! A planning session is durable project backbone state. It records a guided
//! planning pass without implying model execution, agent scheduling, active
//! task creation, or raw transcript authority.

use std::time::SystemTime;

use nucleus_projects::ProjectId;

use crate::ids::PlanningSessionId;
use crate::refs::{PlanningOutputRefs, PlanningParticipantRef, PlanningSourceRef};

/// Guided planning session record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningSession {
    pub id: PlanningSessionId,
    pub project_id: ProjectId,
    pub kind: PlanningSessionKind,
    pub status: PlanningSessionStatus,
    pub prompt_or_template_refs: Vec<String>,
    pub participants: Vec<PlanningParticipantRef>,
    pub source_refs: Vec<PlanningSourceRef>,
    pub output_refs: PlanningOutputRefs,
    pub timestamps: PlanningSessionTimestamps,
}

/// Planning session kind.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PlanningSessionKind {
    ProjectIntake,
    VisionDefinition,
    Ideation,
    ArchitecturePlanning,
    ResearchPlanning,
    DeepResearch,
    RoadmapPlanning,
    TaskBreakdown,
    DecisionReview,
    Other(String),
}

/// Planning session lifecycle state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PlanningSessionStatus {
    Draft,
    Active,
    Paused,
    Review,
    Accepted,
    Superseded,
    Archived,
}

/// Planning session timestamps.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningSessionTimestamps {
    pub created_at: Option<SystemTime>,
    pub updated_at: Option<SystemTime>,
    pub accepted_at: Option<SystemTime>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::refs::{PlanningParticipantRole, PlanningSourceKind};

    #[test]
    fn planning_session_represents_guided_project_planning() {
        let session = PlanningSession {
            id: PlanningSessionId("planning-session:nucleus:intake".to_owned()),
            project_id: ProjectId("project:nucleus".to_owned()),
            kind: PlanningSessionKind::ProjectIntake,
            status: PlanningSessionStatus::Active,
            prompt_or_template_refs: vec!["template:project-intake:v1".to_owned()],
            participants: vec![PlanningParticipantRef {
                actor_ref: "user:tom".to_owned(),
                role: PlanningParticipantRole::Human,
            }],
            source_refs: vec![PlanningSourceRef {
                source_ref: "conversation-summary:intake".to_owned(),
                kind: PlanningSourceKind::ConversationSummary,
            }],
            output_refs: PlanningOutputRefs::empty(),
            timestamps: PlanningSessionTimestamps {
                created_at: None,
                updated_at: None,
                accepted_at: None,
            },
        };

        assert_eq!(session.id.0, "planning-session:nucleus:intake");
        assert_eq!(session.project_id.0, "project:nucleus");
        assert_eq!(session.kind, PlanningSessionKind::ProjectIntake);
        assert_eq!(session.status, PlanningSessionStatus::Active);
        assert!(session.output_refs.artifact_refs.is_empty());
    }

    #[test]
    fn planning_session_kind_covers_initial_contract_kinds() {
        let kinds = [
            PlanningSessionKind::ProjectIntake,
            PlanningSessionKind::VisionDefinition,
            PlanningSessionKind::Ideation,
            PlanningSessionKind::ArchitecturePlanning,
            PlanningSessionKind::ResearchPlanning,
            PlanningSessionKind::DeepResearch,
            PlanningSessionKind::RoadmapPlanning,
            PlanningSessionKind::TaskBreakdown,
            PlanningSessionKind::DecisionReview,
        ];

        assert_eq!(kinds.len(), 9);
        assert!(kinds.contains(&PlanningSessionKind::TaskBreakdown));
        assert!(kinds.contains(&PlanningSessionKind::ArchitecturePlanning));
        assert!(kinds.contains(&PlanningSessionKind::RoadmapPlanning));
    }

    #[test]
    fn transcript_refs_are_source_refs_not_authority() {
        let source = PlanningSourceRef {
            source_ref: "transcript:provider-local:turns-redacted".to_owned(),
            kind: PlanningSourceKind::TranscriptRef,
        };

        assert_eq!(source.kind, PlanningSourceKind::TranscriptRef);
        assert!(source.source_ref.starts_with("transcript:"));
    }
}
