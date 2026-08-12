//! Terminal runtime tests, split from the terminal_runtime god file;
//! behavior unchanged.

use super::*;

use super::env::{session_id, terminal_working_directory_with, validate_size};
use crate::{seed_local_project, LocalProjectSeed, ServerStateService};
use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreRecord, LocalStoreRecordPayload, RevisionExpectation, SqliteBackend,
};
use nucleus_projects::{
    decode_project_storage_record, encode_project_storage_payload,
    encode_project_storage_record, ImportanceBaseline, ImportanceLevel, Project,
    ProjectActivity, ProjectId, ProjectRetention, ProjectStatus,
};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

#[test]
fn terminal_session_identity_is_stable_and_panel_scoped() {
    assert_eq!(
        session_id("project:a", "panel:1"),
        session_id("project:a", "panel:1")
    );
    assert_ne!(
        session_id("project:a", "panel:1"),
        session_id("project:a", "panel:2")
    );
}

#[test]
fn terminal_sizes_reject_empty_dimensions() {
    assert!(validate_size(24, 80).is_ok());
    assert!(validate_size(0, 80).is_err());
    assert!(validate_size(24, 0).is_err());
}

#[test]
fn resource_free_project_uses_host_default_working_directory() {
    let directory = tempfile::tempdir().expect("temp dir");
    let state =
        ServerStateService::new(SqliteBackend::new(directory.path().join("state.sqlite")));
    persist_resource_free_project(&state, "project:empty");
    let fallback = directory.path().join("host-home");
    std::fs::create_dir(&fallback).expect("create fallback");

    assert_eq!(
        terminal_working_directory_with(&state, "project:empty", None, || {
            Ok(fallback.clone())
        })
        .expect("resolve terminal working directory"),
        (fallback, None)
    );
}

#[test]
fn resource_free_project_does_not_use_a_fallback_on_the_wrong_host() {
    let directory = tempfile::tempdir().expect("temp dir");
    let state =
        ServerStateService::new(SqliteBackend::new(directory.path().join("state.sqlite")));
    persist_resource_free_project(&state, "project:remote");
    let id = PersistenceRecordId("project:remote".to_owned());
    let mut record = state.projects().get(&id).expect("get").expect("project");
    let previous = record.revision_id.clone();
    let mut project = decode_project_storage_record(&record.payload.bytes).expect("decode");
    project.authority_host_ref = "host:remote-builder".to_owned();
    record.revision_id = RevisionId("rev:test:remote".to_owned());
    record.payload = LocalStoreRecordPayload {
        media_type: Some("application/json".to_owned()),
        bytes: encode_project_storage_payload(&project).expect("encode"),
    };
    state
        .projects()
        .put(record, RevisionExpectation::Exact(previous))
        .expect("put");

    let error = terminal_working_directory_with(&state, "project:remote", None, || {
        panic!("wrong-host fallback must not run")
    })
    .expect_err("wrong authority host");

    assert!(error.contains("authority host host:remote-builder"));
}

#[test]
fn explicit_resource_target_overrides_terminal_project_default() {
    let directory = tempfile::tempdir().expect("temp dir");
    let first = directory.path().join("first");
    let second = directory.path().join("second");
    std::fs::create_dir(&first).expect("first resource");
    std::fs::create_dir(&second).expect("second resource");
    let state =
        ServerStateService::new(SqliteBackend::new(directory.path().join("state.sqlite")));
    seed_local_project(&state, LocalProjectSeed::nucleus_local()).expect("seed project");
    let id = PersistenceRecordId("project:nucleus-local".to_owned());
    let mut record = state.projects().get(&id).expect("get").expect("project");
    let previous = record.revision_id.clone();
    let mut project = decode_project_storage_record(&record.payload.bytes).expect("decode");
    project.resources[0].current_locator = Some(first.to_string_lossy().into_owned());
    let mut second_resource = project.resources[0].clone();
    second_resource.resource_id = "resource:second".to_owned();
    second_resource.display_name = "Second".to_owned();
    second_resource.current_locator = Some(second.to_string_lossy().into_owned());
    project.resources.push(second_resource);
    record.revision_id = RevisionId("rev:terminal-multi-resource".to_owned());
    record.payload = LocalStoreRecordPayload {
        media_type: Some("application/json".to_owned()),
        bytes: encode_project_storage_payload(&project).expect("encode"),
    };
    state
        .projects()
        .put(record, RevisionExpectation::Exact(previous))
        .expect("put");

    assert_eq!(
        terminal_working_directory_with(
            &state,
            "project:nucleus-local",
            Some("resource:second"),
            || Err("host fallback must not run".to_owned()),
        )
        .expect("resolve explicit terminal target"),
        (
            second.canonicalize().expect("canonical second"),
            Some("resource:second".to_owned()),
        )
    );
}

#[cfg(not(windows))]
#[test]
fn local_host_terminal_streams_interactive_shell_output() {
    let directory = tempfile::tempdir().expect("temp dir");
    let state =
        ServerStateService::new(SqliteBackend::new(directory.path().join("state.sqlite")));
    seed_local_project(&state, LocalProjectSeed::nucleus_local()).expect("seed project");
    let runtime = TerminalHostRuntime::default();
    let (sender, receiver) = mpsc::channel();
    let snapshot = runtime
        .open_or_attach(
            &state,
            TerminalOpenRequest {
                project_id: "project:nucleus-local".to_owned(),
                panel_id: "terminal:test".to_owned(),
                resource_id: None,
                rows: 24,
                cols: 80,
            },
            Arc::new(move |event| {
                let _ = sender.send(event);
            }),
        )
        .expect("open terminal");
    assert_eq!(
        snapshot.resource_id.as_deref(),
        Some("resource:nucleus-local")
    );

    runtime
        .write(
            &snapshot.session_id,
            b"printf '__nucleus_terminal_round_trip__\\n'; exit\n",
        )
        .expect("write terminal");

    let deadline = Instant::now() + Duration::from_secs(10);
    let mut output = Vec::new();
    while Instant::now() < deadline {
        match receiver.recv_timeout(Duration::from_millis(250)) {
            Ok(TerminalEvent::Output { data, .. }) => {
                output.extend(data);
                if output
                    .windows(b"__nucleus_terminal_round_trip__".len())
                    .any(|window| window == b"__nucleus_terminal_round_trip__")
                {
                    return;
                }
            }
            Ok(_) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(error) => panic!("terminal event stream failed: {error}"),
        }
    }

    panic!("terminal output marker was not observed");
}

fn persist_resource_free_project(state: &ServerStateService<SqliteBackend>, project_id: &str) {
    let project = Project {
        id: ProjectId(project_id.to_owned()),
        display_name: "Empty project".to_owned(),
        authority_host_ref: LOCAL_HOST_ID.to_owned(),
        status: ProjectStatus::Active,
        retention: ProjectRetention::Durable,
        importance_baseline: ImportanceBaseline {
            level: ImportanceLevel::Normal,
            notes: None,
        },
        resources: Vec::new(),
        default_working_resource: None,
        management_projection: None,
        task_ids: Vec::new(),
        workspace_layout_refs: Vec::new(),
        activity: ProjectActivity {
            created_at: None,
            last_focused_at: None,
            last_agent_activity_at: None,
            last_task_activity_at: None,
        },
    };
    state
        .projects()
        .put(
            LocalStoreRecord {
                id: PersistenceRecordId(project_id.to_owned()),
                domain: PersistenceDomain::Projects,
                kind: PersistenceRecordKind::Project,
                revision_id: RevisionId("rev:test:1".to_owned()),
                payload: LocalStoreRecordPayload {
                    media_type: Some("application/json".to_owned()),
                    bytes: encode_project_storage_record(&project).expect("encode project"),
                },
            },
            RevisionExpectation::MustNotExist,
        )
        .expect("persist project");
}
