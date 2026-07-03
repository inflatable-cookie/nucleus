//! Research question records.
//!
//! Questions decompose a run brief without granting source retrieval,
//! provider execution, crawling, browser automation, or promotion authority.

use crate::ids::{ResearchQuestionId, ResearchRunBriefId};

/// First-class research question.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResearchQuestion {
    pub id: ResearchQuestionId,
    pub run_id: ResearchRunBriefId,
    pub text: String,
    pub priority: ResearchQuestionPriority,
    pub status: ResearchQuestionStatus,
    pub source_requirements: Vec<ResearchQuestionSourceRequirement>,
    pub answer_summary: Option<String>,
    pub evidence_refs: Vec<String>,
    pub open_gap_refs: Vec<String>,
}

impl ResearchQuestion {
    /// Questions route investigation only. They do not execute retrieval,
    /// providers, browsers, crawlers, or promotion flows.
    pub fn grants_execution_authority(&self) -> bool {
        false
    }

    /// Evidence refs are links to classified evidence, not raw source bodies.
    pub fn stores_raw_source_payload(&self) -> bool {
        false
    }
}

/// Question priority for planning parallel work.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResearchQuestionPriority {
    Low,
    Normal,
    High,
    Critical,
}

/// Question lifecycle state.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResearchQuestionStatus {
    Open,
    InProgress,
    Answered,
    Blocked,
    Deferred,
    Superseded,
}

/// Source requirement hint for answering a question.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResearchQuestionSourceRequirement {
    pub label: String,
    pub required: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn question() -> ResearchQuestion {
        ResearchQuestion {
            id: ResearchQuestionId("research-question:harness:identity".to_owned()),
            run_id: ResearchRunBriefId("research-run:harness".to_owned()),
            text: "Which identity model does each harness use?".to_owned(),
            priority: ResearchQuestionPriority::High,
            status: ResearchQuestionStatus::Open,
            source_requirements: vec![ResearchQuestionSourceRequirement {
                label: "official docs or source code".to_owned(),
                required: true,
            }],
            answer_summary: None,
            evidence_refs: vec!["evidence:classified-source-ref".to_owned()],
            open_gap_refs: vec!["gap:cursor-message-ids".to_owned()],
        }
    }

    #[test]
    fn question_records_keep_run_context_and_gaps() {
        let question = question();

        assert_eq!(question.run_id.0, "research-run:harness");
        assert_eq!(question.priority, ResearchQuestionPriority::High);
        assert_eq!(question.open_gap_refs, vec!["gap:cursor-message-ids"]);
    }

    #[test]
    fn question_records_do_not_grant_execution_or_store_raw_sources() {
        let question = question();

        assert!(!question.grants_execution_authority());
        assert!(!question.stores_raw_source_payload());
    }
}
