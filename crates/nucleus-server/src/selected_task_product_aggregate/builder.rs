//! Selected-task product aggregate assembly.
//!
//! Module index over the builder surface: section projections, source health
//! and gap projection, and the matching helpers.

mod matching;
mod sections;
mod sources;

use sections::{
    command_previews, completion, identity, readiness, review, rework, scm_handoff, work_evidence,
    workflow,
};
use sources::{source_gaps, source_health};
use super::types::{SelectedTaskProductAggregate, SelectedTaskProductAggregateInput};
use crate::TaskWorkflowNoEffects;

pub fn selected_task_product_aggregate(
    input: SelectedTaskProductAggregateInput,
) -> SelectedTaskProductAggregate {
    let gaps = source_gaps(&input);
    let source_health = source_health(&input, &gaps);

    SelectedTaskProductAggregate {
        aggregate_id: format!("selected-task-product-aggregate:{}", input.task_id.0),
        project_id: input.project_id.clone(),
        task_id: input.task_id.clone(),
        identity: identity(&input),
        workflow: workflow(&input),
        readiness: readiness(&input),
        command_previews: command_previews(&input),
        work_evidence: work_evidence(&input),
        review: review(&input),
        rework: rework(&input),
        completion: completion(&input),
        scm_handoff: scm_handoff(&input),
        source_health,
        gaps,
        no_effects: TaskWorkflowNoEffects::read_only(),
    }
}
