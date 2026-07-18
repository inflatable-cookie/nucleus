use serde::{Deserialize, Serialize};

use crate::control_envelope_dto::ControlCommandDto;
use crate::ids::ServerCommandId;
use crate::memory_proposal_review_command::{
    MemoryProposalReviewAction, MemoryProposalReviewCommand,
};

/// Supported memory proposal review command actions.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum ControlMemoryProposalReviewActionDto {
    Queue,
    Defer,
    Reject,
    MarkReviewedForPromotion,
}

pub(super) fn memory_proposal_review_dto(
    command_id: &ServerCommandId,
    command: &MemoryProposalReviewCommand,
) -> ControlCommandDto {
    ControlCommandDto::MemoryProposalReview {
        command_id: command_id.0.clone(),
        action: memory_proposal_review_action_dto(command.action),
        proposal_id: command.proposal_id.clone(),
        expected_revision: command.expected_revision.0.clone(),
        reviewer_ref: command.reviewer_ref.clone(),
        note: command.note.clone(),
    }
}

pub(super) fn memory_proposal_review_action(
    action: ControlMemoryProposalReviewActionDto,
) -> MemoryProposalReviewAction {
    match action {
        ControlMemoryProposalReviewActionDto::Queue => MemoryProposalReviewAction::Queue,
        ControlMemoryProposalReviewActionDto::Defer => MemoryProposalReviewAction::Defer,
        ControlMemoryProposalReviewActionDto::Reject => MemoryProposalReviewAction::Reject,
        ControlMemoryProposalReviewActionDto::MarkReviewedForPromotion => {
            MemoryProposalReviewAction::MarkReviewedForPromotion
        }
    }
}

fn memory_proposal_review_action_dto(
    action: MemoryProposalReviewAction,
) -> ControlMemoryProposalReviewActionDto {
    match action {
        MemoryProposalReviewAction::Queue => ControlMemoryProposalReviewActionDto::Queue,
        MemoryProposalReviewAction::Defer => ControlMemoryProposalReviewActionDto::Defer,
        MemoryProposalReviewAction::Reject => ControlMemoryProposalReviewActionDto::Reject,
        MemoryProposalReviewAction::MarkReviewedForPromotion => {
            ControlMemoryProposalReviewActionDto::MarkReviewedForPromotion
        }
    }
}
