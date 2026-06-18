use super::types::{
    EngineTaskWorkItemId, EngineTaskWorkItemRecord,
    EngineTaskWorkItemRuntimeLinkState, EngineTaskWorkItemRuntimeProjection,
    EngineTaskWorkItemRuntimeProjectionEntry, EngineTaskWorkItemRuntimeProjectionEntryKind,
};

impl EngineTaskWorkItemRecord {
    /// Build a deterministic, sanitized runtime-link projection.
    pub fn runtime_projection(&self) -> EngineTaskWorkItemRuntimeProjection {
        let mut entries = Vec::new();

        if let Some(session_id) = &self.refs.session_id {
            entries.push(runtime_projection_entry(
                &self.work_item_id,
                EngineTaskWorkItemRuntimeProjectionEntryKind::Session,
                session_id.0.clone(),
                "linked agent session",
            ));
        }
        for turn_id in &self.refs.turn_ids {
            entries.push(runtime_projection_entry(
                &self.work_item_id,
                EngineTaskWorkItemRuntimeProjectionEntryKind::Turn,
                turn_id.0.clone(),
                "linked agent turn",
            ));
        }
        for receipt_id in &self.refs.receipt_ids {
            entries.push(runtime_projection_entry(
                &self.work_item_id,
                EngineTaskWorkItemRuntimeProjectionEntryKind::Receipt,
                receipt_id.0.clone(),
                "linked runtime receipt",
            ));
        }
        for checkpoint_id in &self.refs.checkpoint_ids {
            entries.push(runtime_projection_entry(
                &self.work_item_id,
                EngineTaskWorkItemRuntimeProjectionEntryKind::Checkpoint,
                checkpoint_id.0.clone(),
                "linked checkpoint",
            ));
        }
        for diff_id in &self.refs.diff_summary_ids {
            entries.push(runtime_projection_entry(
                &self.work_item_id,
                EngineTaskWorkItemRuntimeProjectionEntryKind::DiffSummary,
                diff_id.0.clone(),
                "linked diff summary",
            ));
        }
        for timeline_id in &self.refs.timeline_entry_ids {
            entries.push(runtime_projection_entry(
                &self.work_item_id,
                EngineTaskWorkItemRuntimeProjectionEntryKind::Timeline,
                timeline_id.0.clone(),
                "linked task timeline entry",
            ));
        }
        for validation_ref in &self.refs.validation_refs {
            entries.push(runtime_projection_entry(
                &self.work_item_id,
                EngineTaskWorkItemRuntimeProjectionEntryKind::Validation,
                validation_ref.clone(),
                "linked validation evidence",
            ));
        }
        for artifact_ref in &self.refs.artifact_refs {
            entries.push(runtime_projection_entry(
                &self.work_item_id,
                EngineTaskWorkItemRuntimeProjectionEntryKind::Artifact,
                artifact_ref.clone(),
                "linked artifact evidence",
            ));
        }

        let state = runtime_link_state(self);
        let summary = format!(
            "{} runtime links projected for {}",
            entries.len(),
            self.work_item_id.0
        );

        EngineTaskWorkItemRuntimeProjection {
            work_item_id: self.work_item_id.clone(),
            task_id: self.task_id.clone(),
            state,
            entries,
            summary,
        }
    }
}
fn runtime_projection_entry(
    work_item_id: &EngineTaskWorkItemId,
    kind: EngineTaskWorkItemRuntimeProjectionEntryKind,
    source_ref: String,
    summary: &str,
) -> EngineTaskWorkItemRuntimeProjectionEntry {
    EngineTaskWorkItemRuntimeProjectionEntry {
        entry_id: format!("projection:{}:{source_ref}", work_item_id.0),
        kind,
        source_ref,
        summary: summary.to_owned(),
    }
}

fn runtime_link_state(work_item: &EngineTaskWorkItemRecord) -> EngineTaskWorkItemRuntimeLinkState {
    if work_item.refs.session_id.is_none() {
        return EngineTaskWorkItemRuntimeLinkState::RepairRequired(
            "work item is missing an agent session ref".to_owned(),
        );
    }
    if work_item.refs.receipt_ids.is_empty() && work_item.refs.timeline_entry_ids.is_empty() {
        return EngineTaskWorkItemRuntimeLinkState::Partial;
    }
    EngineTaskWorkItemRuntimeLinkState::Linked
}
