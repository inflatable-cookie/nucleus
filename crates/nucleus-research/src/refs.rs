//! Cross-domain research refs.
//!
//! Research records link to planning artifacts, memory proposals, task seeds,
//! source evidence, and sanitized artifacts by ref only.

/// Candidate promotion targets for reviewed research output.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ResearchPromotionTargetRefs {
    pub memory_proposal_refs: Vec<String>,
    pub planning_artifact_refs: Vec<String>,
    pub task_seed_refs: Vec<String>,
    pub source_evidence_refs: Vec<String>,
}

impl ResearchPromotionTargetRefs {
    /// Empty target refs for synthesis that is not ready to promote.
    pub fn empty() -> Self {
        Self::default()
    }

    /// Promotion target refs do not mutate the target domains.
    pub fn grants_mutation_authority(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn promotion_targets_are_refs_only() {
        let refs = ResearchPromotionTargetRefs {
            memory_proposal_refs: vec!["memory-proposal:research-finding".to_owned()],
            planning_artifact_refs: vec!["planning-artifact:decision-support".to_owned()],
            task_seed_refs: vec!["task-seed:follow-up".to_owned()],
            source_evidence_refs: vec!["evidence:source-classification".to_owned()],
        };

        assert!(!refs.grants_mutation_authority());
        assert_eq!(refs.task_seed_refs.len(), 1);
    }
}
