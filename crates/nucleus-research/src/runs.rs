//! Research run brief records.
//!
//! A run brief records a bounded investigation. It is not a crawler job,
//! model execution request, browser automation session, or promotion command.

use std::time::SystemTime;

use nucleus_projects::ProjectId;

use crate::ids::ResearchRunBriefId;

/// Bounded deep research run brief.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResearchRunBrief {
    pub id: ResearchRunBriefId,
    pub project_id: Option<ProjectId>,
    pub title: ResearchRunTitle,
    pub brief: ResearchBrief,
    pub status: ResearchRunBriefStatus,
    pub scope_boundary: ResearchRunScopeBoundary,
    pub source_plan_refs: Vec<String>,
    pub confidence: ResearchConfidence,
    pub coverage: ResearchCoverageSummary,
    pub timestamps: ResearchRunTimestamps,
}

impl ResearchRunBrief {
    /// A run brief is planning state, not active research execution.
    pub fn is_active_execution(&self) -> bool {
        false
    }

    /// Promotion into planning, memory, tasks, docs, or projection requires a
    /// separate reviewed command.
    pub fn grants_promotion_authority(&self) -> bool {
        false
    }
}

/// Human-readable research run title.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResearchRunTitle(pub String);

/// Sanitized research brief text.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResearchBrief {
    pub summary: String,
    pub detail: Option<String>,
}

/// Research run lifecycle state.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResearchRunBriefStatus {
    Proposed,
    Active,
    Paused,
    Blocked,
    Synthesized,
    Accepted,
    Superseded,
    Archived,
}

impl ResearchRunBriefStatus {
    /// Status records do not execute providers, crawlers, browsers, or
    /// promotion flows.
    pub fn grants_execution_authority(&self) -> bool {
        false
    }
}

/// Explicit scope boundary for a research run.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResearchRunScopeBoundary {
    pub in_scope: Vec<String>,
    pub out_of_scope: Vec<String>,
    pub constraints: Vec<String>,
}

impl ResearchRunScopeBoundary {
    /// Scope boundaries guide investigation. They do not grant access to raw
    /// sources or credentials.
    pub fn grants_source_access_authority(&self) -> bool {
        false
    }
}

/// Coarse confidence signal for current run state.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResearchConfidence {
    Unknown,
    Low,
    Medium,
    High,
}

/// Coverage summary for the current run state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResearchCoverageSummary {
    pub covered_refs: Vec<String>,
    pub gap_refs: Vec<String>,
    pub note: Option<String>,
}

/// Run timestamps where known.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResearchRunTimestamps {
    pub created_at: Option<SystemTime>,
    pub updated_at: Option<SystemTime>,
    pub synthesized_at: Option<SystemTime>,
    pub accepted_at: Option<SystemTime>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_brief() -> ResearchRunBrief {
        ResearchRunBrief {
            id: ResearchRunBriefId("research-run:nucleus:harness-comms".to_owned()),
            project_id: Some(ProjectId("project:nucleus".to_owned())),
            title: ResearchRunTitle("Harness communications evidence".to_owned()),
            brief: ResearchBrief {
                summary: "Compare harness communication surfaces.".to_owned(),
                detail: Some(
                    "Focus on refs and evidence before source retrieval exists.".to_owned(),
                ),
            },
            status: ResearchRunBriefStatus::Proposed,
            scope_boundary: ResearchRunScopeBoundary {
                in_scope: vec!["official docs".to_owned(), "source refs".to_owned()],
                out_of_scope: vec!["crawler implementation".to_owned()],
                constraints: vec!["no raw source retention".to_owned()],
            },
            source_plan_refs: vec!["source-plan:harness-comms:v1".to_owned()],
            confidence: ResearchConfidence::Unknown,
            coverage: ResearchCoverageSummary {
                covered_refs: Vec::new(),
                gap_refs: vec!["gap:identity-models".to_owned()],
                note: Some("Brief exists before execution.".to_owned()),
            },
            timestamps: ResearchRunTimestamps {
                created_at: None,
                updated_at: None,
                synthesized_at: None,
                accepted_at: None,
            },
        }
    }

    #[test]
    fn run_brief_can_be_project_bound() {
        let run = run_brief();

        assert_eq!(
            run.project_id,
            Some(ProjectId("project:nucleus".to_owned()))
        );
        assert_eq!(run.id.0, "research-run:nucleus:harness-comms");
        assert_eq!(run.status, ResearchRunBriefStatus::Proposed);
    }

    #[test]
    fn run_brief_can_be_standalone() {
        let mut run = run_brief();
        run.project_id = None;

        assert!(run.project_id.is_none());
        assert!(!run.is_active_execution());
    }

    #[test]
    fn statuses_do_not_grant_execution_authority() {
        let statuses = [
            ResearchRunBriefStatus::Proposed,
            ResearchRunBriefStatus::Active,
            ResearchRunBriefStatus::Paused,
            ResearchRunBriefStatus::Blocked,
            ResearchRunBriefStatus::Synthesized,
            ResearchRunBriefStatus::Accepted,
            ResearchRunBriefStatus::Superseded,
            ResearchRunBriefStatus::Archived,
        ];

        assert!(statuses
            .iter()
            .all(|status| !status.grants_execution_authority()));
    }

    #[test]
    fn scope_and_run_do_not_grant_access_or_promotion() {
        let run = run_brief();

        assert!(!run.scope_boundary.grants_source_access_authority());
        assert!(!run.grants_promotion_authority());
    }
}
