use crate::{
    SelectedTaskScmHandoffEvidence, SelectedTaskScmHandoffGap, SelectedTaskScmHandoffGapArea,
    SelectedTaskScmHandoffSourceCounts, SelectedTaskScmHandoffTarget,
    SelectedTaskScmHandoffTargetShape, TaskWorkflowDrilldown,
};

pub fn evidence_summary(drilldown: &TaskWorkflowDrilldown) -> SelectedTaskScmHandoffEvidence {
    let scm_handoff_refs = clean_refs(drilldown.scm_handoff.handoff_refs.clone());
    let work_item_refs = clean_refs(
        drilldown
            .work_progress
            .work_items
            .iter()
            .map(|item| item.work_item_ref.clone())
            .collect(),
    );
    let checkpoint_refs = clean_refs(
        drilldown
            .work_progress
            .work_items
            .iter()
            .flat_map(|item| item.checkpoint_refs.iter().cloned())
            .collect(),
    );
    let diff_summary_refs = clean_refs(
        drilldown
            .work_progress
            .work_items
            .iter()
            .flat_map(|item| item.diff_summary_refs.iter().cloned())
            .collect(),
    );
    let runtime_receipt_refs = clean_refs(
        drilldown
            .runtime
            .runtime_receipt_refs
            .iter()
            .cloned()
            .chain(
                drilldown
                    .work_progress
                    .work_items
                    .iter()
                    .flat_map(|item| item.receipt_refs.iter().cloned()),
            )
            .collect(),
    );
    let validation_refs = clean_refs(
        drilldown
            .work_progress
            .work_items
            .iter()
            .flat_map(|item| item.validation_refs.iter().cloned())
            .collect(),
    );

    SelectedTaskScmHandoffEvidence {
        work_item_refs,
        scm_work_session_refs: filter_refs(&scm_handoff_refs, &["scm-session", "work-session"]),
        provider_change_refs: filter_refs(
            &scm_handoff_refs,
            &[
                "change",
                "commit",
                "snapshot",
                "snap",
                "publication",
                "changeset",
                "revision",
            ],
        ),
        change_request_prep_refs: filter_refs(&scm_handoff_refs, &["prep", "change-request"]),
        repair_refs: filter_refs(&scm_handoff_refs, &["repair", "missing", "superseded"]),
        scm_handoff_refs,
        checkpoint_refs,
        diff_summary_refs,
        runtime_receipt_refs,
        validation_refs,
        review_refs: clean_refs(drilldown.review.review_refs.clone()),
    }
}

pub fn target(evidence: &SelectedTaskScmHandoffEvidence) -> SelectedTaskScmHandoffTarget {
    let refs = &evidence.scm_handoff_refs;
    let shape = if contains_any(
        refs,
        &["forge-review", "pull-request", "merge-request", "pr:"],
    ) {
        SelectedTaskScmHandoffTargetShape::ForgeReview
    } else if contains_any(refs, &["publication", "publish"]) {
        SelectedTaskScmHandoffTargetShape::ProviderPublication
    } else if contains_any(refs, &["gate"]) {
        SelectedTaskScmHandoffTargetShape::ProviderGate
    } else if contains_any(refs, &["direct-authority", "direct"]) {
        SelectedTaskScmHandoffTargetShape::DirectAuthorityUpdate
    } else if contains_any(refs, &["manual"]) {
        SelectedTaskScmHandoffTargetShape::ManualHandoff
    } else if contains_any(refs, &["custom"]) {
        SelectedTaskScmHandoffTargetShape::CustomProviderValue
    } else {
        SelectedTaskScmHandoffTargetShape::Unknown
    };

    SelectedTaskScmHandoffTarget {
        shape,
        target_refs: refs
            .iter()
            .filter(|reference| is_target_ref(reference))
            .cloned()
            .collect(),
    }
}

pub fn source_counts(
    drilldown: &TaskWorkflowDrilldown,
    evidence: &SelectedTaskScmHandoffEvidence,
) -> SelectedTaskScmHandoffSourceCounts {
    SelectedTaskScmHandoffSourceCounts {
        task_records: usize::from(drilldown.task.is_some()),
        work_items: evidence.work_item_refs.len(),
        scm_handoff_refs: evidence.scm_handoff_refs.len(),
        scm_work_session_refs: evidence.scm_work_session_refs.len(),
        provider_change_refs: evidence.provider_change_refs.len(),
        checkpoint_refs: evidence.checkpoint_refs.len(),
        diff_summary_refs: evidence.diff_summary_refs.len(),
        runtime_receipt_refs: evidence.runtime_receipt_refs.len(),
        validation_refs: evidence.validation_refs.len(),
        review_refs: evidence.review_refs.len(),
        change_request_prep_refs: evidence.change_request_prep_refs.len(),
        repair_refs: evidence.repair_refs.len(),
        gap_count: 0,
    }
}

pub fn gaps(
    drilldown: &TaskWorkflowDrilldown,
    evidence: &SelectedTaskScmHandoffEvidence,
    target: &SelectedTaskScmHandoffTarget,
) -> Vec<SelectedTaskScmHandoffGap> {
    let mut gaps = Vec::new();

    if drilldown.task.is_none() {
        gaps.push(gap(
            SelectedTaskScmHandoffGapArea::Task,
            "selected task was not found",
        ));
    }
    if evidence.work_item_refs.is_empty() {
        gaps.push(gap(
            SelectedTaskScmHandoffGapArea::WorkProgress,
            "no task work-item refs exist for SCM handoff",
        ));
    }
    if evidence.scm_handoff_refs.is_empty() {
        gaps.push(gap(
            SelectedTaskScmHandoffGapArea::ScmHandoff,
            "no SCM handoff refs exist for the selected task",
        ));
    }
    if evidence.scm_work_session_refs.is_empty() && !evidence.scm_handoff_refs.is_empty() {
        gaps.push(gap(
            SelectedTaskScmHandoffGapArea::WorkSession,
            "no SCM work-session ref is present in handoff evidence",
        ));
    }
    if evidence.provider_change_refs.is_empty() && !evidence.scm_handoff_refs.is_empty() {
        gaps.push(gap(
            SelectedTaskScmHandoffGapArea::ProviderChange,
            "no provider-neutral change ref is present in handoff evidence",
        ));
    }
    if evidence.checkpoint_refs.is_empty() {
        gaps.push(gap(
            SelectedTaskScmHandoffGapArea::Checkpoint,
            "no checkpoint refs exist for SCM handoff review",
        ));
    }
    if evidence.diff_summary_refs.is_empty() {
        gaps.push(gap(
            SelectedTaskScmHandoffGapArea::Diff,
            "no diff summary refs exist for SCM handoff review",
        ));
    }
    if evidence.runtime_receipt_refs.is_empty() {
        gaps.push(gap(
            SelectedTaskScmHandoffGapArea::RuntimeReceipt,
            "no runtime receipt refs exist for SCM handoff review",
        ));
    }
    if evidence.validation_refs.is_empty() {
        gaps.push(gap(
            SelectedTaskScmHandoffGapArea::Validation,
            "no validation refs exist for SCM handoff review",
        ));
    }
    if evidence.review_refs.is_empty() {
        gaps.push(gap(
            SelectedTaskScmHandoffGapArea::Review,
            "no review refs exist before SCM handoff",
        ));
    }
    if evidence.change_request_prep_refs.is_empty() && !evidence.scm_handoff_refs.is_empty() {
        gaps.push(gap(
            SelectedTaskScmHandoffGapArea::ChangeRequestPrep,
            "no change-request prep ref exists for handoff",
        ));
    }
    if target.shape == SelectedTaskScmHandoffTargetShape::Unknown
        && !evidence.scm_handoff_refs.is_empty()
    {
        gaps.push(gap(
            SelectedTaskScmHandoffGapArea::Target,
            "SCM handoff target shape is unknown",
        ));
    }

    gaps
}

fn gap(area: SelectedTaskScmHandoffGapArea, reason: &str) -> SelectedTaskScmHandoffGap {
    SelectedTaskScmHandoffGap {
        area,
        reason: reason.to_owned(),
    }
}

fn filter_refs(refs: &[String], needles: &[&str]) -> Vec<String> {
    refs.iter()
        .filter(|reference| matches_any(reference, needles))
        .cloned()
        .collect()
}

fn contains_any(refs: &[String], needles: &[&str]) -> bool {
    refs.iter().any(|reference| matches_any(reference, needles))
}

fn is_target_ref(reference: &str) -> bool {
    matches_any(
        reference,
        &[
            "forge-review",
            "pull-request",
            "merge-request",
            "publication",
            "gate",
            "direct-authority",
            "manual",
            "custom",
        ],
    )
}

fn matches_any(reference: &str, needles: &[&str]) -> bool {
    let reference = reference.to_ascii_lowercase();
    needles.iter().any(|needle| reference.contains(needle))
}

fn clean_refs(refs: Vec<String>) -> Vec<String> {
    let mut refs = refs
        .into_iter()
        .map(|reference| reference.trim().to_owned())
        .filter(|reference| !reference.is_empty())
        .collect::<Vec<_>>();
    refs.sort();
    refs.dedup();
    refs
}
