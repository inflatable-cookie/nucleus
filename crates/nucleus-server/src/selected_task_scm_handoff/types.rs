use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskScmHandoffReadiness {
    pub handoff_id: String,
    pub project_id: ProjectId,
    pub task_id: TaskId,
    pub readiness: SelectedTaskScmHandoffSummary,
    pub target: SelectedTaskScmHandoffTarget,
    pub evidence: SelectedTaskScmHandoffEvidence,
    pub next: SelectedTaskScmHandoffNextStep,
    pub source_counts: SelectedTaskScmHandoffSourceCounts,
    pub gaps: Vec<SelectedTaskScmHandoffGap>,
    pub no_effects: SelectedTaskScmHandoffNoEffects,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskScmHandoffSummary {
    pub state: SelectedTaskScmHandoffState,
    pub reason: String,
    pub handoff_refs: Vec<String>,
    pub blocker_refs: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SelectedTaskScmHandoffState {
    Missing,
    Blocked,
    EvidenceReady,
    PrepReady,
    PublicationPending,
    Represented,
    RepairRequired,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskScmHandoffTarget {
    pub shape: SelectedTaskScmHandoffTargetShape,
    pub target_refs: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SelectedTaskScmHandoffTargetShape {
    ForgeReview,
    ProviderPublication,
    ProviderGate,
    DirectAuthorityUpdate,
    ManualHandoff,
    CustomProviderValue,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskScmHandoffEvidence {
    pub work_item_refs: Vec<String>,
    pub scm_handoff_refs: Vec<String>,
    pub scm_work_session_refs: Vec<String>,
    pub provider_change_refs: Vec<String>,
    pub checkpoint_refs: Vec<String>,
    pub diff_summary_refs: Vec<String>,
    pub runtime_receipt_refs: Vec<String>,
    pub validation_refs: Vec<String>,
    pub review_refs: Vec<String>,
    pub change_request_prep_refs: Vec<String>,
    pub repair_refs: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskScmHandoffNextStep {
    pub category: SelectedTaskScmHandoffNextCategory,
    pub summary: String,
    pub next_ref: Option<String>,
    pub rationale_refs: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SelectedTaskScmHandoffNextCategory {
    InspectEvidence,
    PrepareChangeRequest,
    ReviewPreparation,
    PublishHandoff,
    Repair,
    Wait,
    PlanningAmbiguity,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskScmHandoffSourceCounts {
    pub task_records: usize,
    pub work_items: usize,
    pub scm_handoff_refs: usize,
    pub scm_work_session_refs: usize,
    pub provider_change_refs: usize,
    pub checkpoint_refs: usize,
    pub diff_summary_refs: usize,
    pub runtime_receipt_refs: usize,
    pub validation_refs: usize,
    pub review_refs: usize,
    pub change_request_prep_refs: usize,
    pub repair_refs: usize,
    pub gap_count: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskScmHandoffGap {
    pub area: SelectedTaskScmHandoffGapArea,
    pub reason: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SelectedTaskScmHandoffGapArea {
    Task,
    WorkProgress,
    ScmHandoff,
    WorkSession,
    ProviderChange,
    Checkpoint,
    Diff,
    RuntimeReceipt,
    Validation,
    Review,
    ChangeRequestPrep,
    Target,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskScmHandoffNoEffects {
    pub scm_mutation_performed: bool,
    pub forge_mutation_performed: bool,
    pub credential_resolution_performed: bool,
    pub task_mutation_performed: bool,
    pub provider_execution_performed: bool,
    pub review_mutation_performed: bool,
    pub accepted_memory_apply_performed: bool,
    pub planning_apply_performed: bool,
    pub projection_write_performed: bool,
    pub ui_effect_performed: bool,
}

impl SelectedTaskScmHandoffNoEffects {
    pub fn read_only() -> Self {
        Self {
            scm_mutation_performed: false,
            forge_mutation_performed: false,
            credential_resolution_performed: false,
            task_mutation_performed: false,
            provider_execution_performed: false,
            review_mutation_performed: false,
            accepted_memory_apply_performed: false,
            planning_apply_performed: false,
            projection_write_performed: false,
            ui_effect_performed: false,
        }
    }
}
