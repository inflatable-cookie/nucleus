use nucleus_local_store::LocalStoreResult;

use super::helpers::invalid;
use super::types::DurableCodexLiveSmokeEvidencePersistenceInput;

pub(super) fn validate_input(
    input: &DurableCodexLiveSmokeEvidencePersistenceInput,
) -> LocalStoreResult<()> {
    if input.run.run_id.trim().is_empty()
        || input.run.boundary.write_attempt_id.trim().is_empty()
        || input.persistence_evidence_refs.is_empty()
    {
        return invalid(
            "durable live smoke evidence requires run, write attempt, and evidence refs",
        );
    }
    if input
        .persistence_evidence_refs
        .iter()
        .chain(input.artifact_refs.iter())
        .chain(input.existing_write_attempt_ids.iter())
        .any(|value| value.trim().is_empty())
    {
        return invalid("durable live smoke evidence refs cannot be empty");
    }
    if input.run.provider_write_executed
        || input.run.executor_invoked
        || input.run.raw_provider_material_retained
        || input.run.task_mutation_permitted
    {
        return invalid("durable live smoke persistence cannot persist widened authority");
    }
    Ok(())
}
