use super::types::{
    AcceptedMemoryReviewReadinessCounts, AcceptedMemoryReviewReadinessRecord,
    AcceptedMemoryReviewReadinessStatus,
};

impl AcceptedMemoryReviewReadinessCounts {
    pub(super) fn from_records(records: &[AcceptedMemoryReviewReadinessRecord]) -> Self {
        let mut counts = Self {
            records: records.len(),
            accepted_memories: 0,
            projectable: 0,
            projection_blocked: 0,
            projection_write_admitted: 0,
            projection_write_blocked: 0,
            import_candidates_ready: 0,
            import_candidates_blocked: 0,
            import_admitted: 0,
            import_blocked: 0,
            duplicate_noops: 0,
            conflicts: 0,
            apply_admitted: 0,
            approval_required: 0,
            apply_blocked: 0,
            blocker_count: 0,
            evidence_ref_count: 0,
        };

        for record in records {
            counts.count_record(record);
        }

        counts
    }

    fn count_record(&mut self, record: &AcceptedMemoryReviewReadinessRecord) {
        self.blocker_count += record.blocker_count;
        self.evidence_ref_count += record.evidence_ref_count;
        match record.status {
            AcceptedMemoryReviewReadinessStatus::AcceptedMemoryPresent => {
                self.accepted_memories += 1;
            }
            AcceptedMemoryReviewReadinessStatus::Projectable => self.projectable += 1,
            AcceptedMemoryReviewReadinessStatus::ProjectionBlocked => {
                self.projection_blocked += 1;
            }
            AcceptedMemoryReviewReadinessStatus::ProjectionWriteAdmitted => {
                self.projection_write_admitted += 1;
            }
            AcceptedMemoryReviewReadinessStatus::ProjectionWriteBlocked => {
                self.projection_write_blocked += 1;
            }
            AcceptedMemoryReviewReadinessStatus::ImportCandidateReady => {
                self.import_candidates_ready += 1;
            }
            AcceptedMemoryReviewReadinessStatus::ImportCandidateBlocked => {
                self.import_candidates_blocked += 1;
            }
            AcceptedMemoryReviewReadinessStatus::ImportAdmitted => self.import_admitted += 1,
            AcceptedMemoryReviewReadinessStatus::ImportBlocked => self.import_blocked += 1,
            AcceptedMemoryReviewReadinessStatus::DuplicateNoop => self.duplicate_noops += 1,
            AcceptedMemoryReviewReadinessStatus::Conflict => self.conflicts += 1,
            AcceptedMemoryReviewReadinessStatus::ApplyAdmitted => self.apply_admitted += 1,
            AcceptedMemoryReviewReadinessStatus::ApprovalRequired => {
                self.approval_required += 1;
            }
            AcceptedMemoryReviewReadinessStatus::ApplyBlocked => self.apply_blocked += 1,
        }
    }
}
