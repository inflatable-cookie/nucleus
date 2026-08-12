//! Goal execution tests, split from the tests_split god file; behavior
//! unchanged.

#[allow(unused_imports)]
use super::*;
#[allow(unused_imports)]
use super::{dispatch::*, outcome::*, persistence::*, rules::*, run_loop::*};

use nucleus_core::{PersistenceRecordId, RevisionId};
use nucleus_local_store::{LocalStoreRecordPayload, RevisionExpectation};

use crate::local_codex_chat::goal_run::tests::run_request;
use crate::local_codex_chat::goal_run::{GoalRunOutcome, GoalRunPlan};
use crate::local_codex_chat::{admit_goal_run, WorkflowMandate};
use crate::{ServerStateService, TaskReviewSnapshotStore};

mod execution_tests;
mod live_tests;
mod source_windows_tests;

fn admitted_plan(
    state: &ServerStateService<nucleus_local_store::SqliteBackend>,
    mandate: &WorkflowMandate,
    key: &str,
) -> GoalRunPlan {
    match admit_goal_run(state, run_request(mandate, key)).expect("admit Goal") {
        GoalRunOutcome::Admitted { plan } => plan,
        other => panic!("expected plan, got {other:?}"),
    }
}

struct SnapshotRuntime {
    workspace: tempfile::TempDir,
    _backend: tempfile::TempDir,
    store: TaskReviewSnapshotStore,
}

fn snapshot_runtime(
    state: &ServerStateService<nucleus_local_store::SqliteBackend>,
) -> SnapshotRuntime {
    let workspace = tempfile::tempdir().expect("workspace");
    redirect_project_root(state, workspace.path());
    let backend = tempfile::tempdir().expect("snapshot backend");
    let store = TaskReviewSnapshotStore::new(backend.path().join("snapshots")).expect("store");
    SnapshotRuntime {
        workspace,
        _backend: backend,
        store,
    }
}

fn linkage(index: usize) -> super::super::task_execution::TaskExecutionLinkage {
    super::super::task_execution::TaskExecutionLinkage {
        session_id: format!("session:{index}"),
        thread_id: format!("thread:{index}"),
        turn_id: format!("turn:{index}"),
    }
}

fn redirect_project_root(
    state: &ServerStateService<nucleus_local_store::SqliteBackend>,
    root: &std::path::Path,
) {
    let id = PersistenceRecordId("project:nucleus-local".to_owned());
    let mut record = state
        .projects()
        .get(&id)
        .expect("project lookup")
        .expect("project");
    let previous = record.revision_id.clone();
    let mut project =
        nucleus_projects::decode_project_storage_record(&record.payload.bytes).expect("decode");
    let resource = project.resources.first_mut().expect("seed resource");
    resource.current_locator = Some(root.to_string_lossy().into_owned());
    resource.location_status = nucleus_projects::ProjectResourceStorageLocationStatus::Present;
    record.revision_id = RevisionId("rev:project:live-smoke".to_owned());
    record.payload = LocalStoreRecordPayload {
        media_type: Some("application/json".to_owned()),
        bytes: nucleus_projects::encode_project_storage_payload(&project).expect("encode"),
    };
    state
        .projects()
        .put(record, RevisionExpectation::Exact(previous))
        .expect("redirect project");
}
