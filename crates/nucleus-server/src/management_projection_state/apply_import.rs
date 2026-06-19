use nucleus_core::PersistenceDomain;
use nucleus_local_store::{LocalStoreBackend, LocalStoreResult, RevisionExpectation};

use crate::state::ServerStateService;

use super::types::{ManagementProjectionImportApplyReport, ManagementProjectionImportApplyRequest};

use self::prepare::{prepare_staged_record, PreparedApplyRecord};
use self::receipts::{
    receipt_for_applied, receipt_for_block, receipt_for_skipped, write_apply_receipt,
};

mod prepare;
mod receipts;

pub fn apply_management_projection_import<B>(
    state: &ServerStateService<B>,
    request: ManagementProjectionImportApplyRequest,
) -> LocalStoreResult<ManagementProjectionImportApplyReport>
where
    B: LocalStoreBackend,
{
    let mut prepared = Vec::new();
    let mut blocked = Vec::new();

    for staged in request.staged {
        match prepare_staged_record(state, staged, &request.targets, &request.conflicts)? {
            PreparedApplyRecord::Ready(record, applied) => prepared.push((record, applied)),
            PreparedApplyRecord::Blocked(block) => blocked.push(block),
        }
    }

    if !blocked.is_empty() {
        let mut receipts = Vec::new();
        let mut blocked_with_receipts = Vec::new();
        for block in blocked {
            let receipt = receipt_for_block(&block);
            write_apply_receipt(state, &receipt)?;
            let mut block = block;
            block.receipt_id = Some(receipt.receipt_id.clone());
            receipts.push(receipt);
            blocked_with_receipts.push(block);
        }
        for (_record, applied) in prepared {
            let receipt = receipt_for_skipped(&applied);
            write_apply_receipt(state, &receipt)?;
            receipts.push(receipt);
        }
        return Ok(ManagementProjectionImportApplyReport {
            applied: Vec::new(),
            blocked: blocked_with_receipts,
            receipts,
            authoritative_state_mutated: false,
            scm_mutation_performed: false,
        });
    }

    let mut applied = Vec::new();
    let mut receipts = Vec::new();
    for (record, applied_record) in prepared {
        let expectation = request
            .targets
            .iter()
            .find(|target| target.record_id.0 == record.id.0)
            .map(revision_expectation)
            .unwrap_or(RevisionExpectation::MustNotExist);

        match record.domain {
            PersistenceDomain::Projects => {
                state.projects().put(record, expectation)?;
            }
            PersistenceDomain::Tasks => {
                state.tasks().put(record, expectation)?;
            }
            _ => unreachable!("prepared apply records only use project/task domains"),
        }
        let receipt = receipt_for_applied(&applied_record);
        write_apply_receipt(state, &receipt)?;
        let mut applied_record = applied_record;
        applied_record.receipt_id = receipt.receipt_id.clone();
        receipts.push(receipt);
        applied.push(applied_record);
    }

    Ok(ManagementProjectionImportApplyReport {
        authoritative_state_mutated: !applied.is_empty(),
        applied,
        blocked: Vec::new(),
        receipts,
        scm_mutation_performed: false,
    })
}

fn revision_expectation(
    target: &super::types::ManagementProjectionApplyTarget,
) -> RevisionExpectation {
    match &target.expected_current_revision {
        Some(revision) => RevisionExpectation::Exact(revision.clone()),
        None => RevisionExpectation::MustNotExist,
    }
}
