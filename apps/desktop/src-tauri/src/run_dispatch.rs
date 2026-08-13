//! Run dispatch Tauri command: operator-confirmed dispatch of a worker run.
//!
//! The dispatch dialog's explicit confirm act drives the whole sequence:
//! propose the run record, execute the operator-confirmed dispatch (the
//! server writes the durable branch/worktree runner effect intent and runs
//! the gated `git worktree add` — never a bare spawn), seed the worker brief,
//! then, after the observed worker turn returns, drive the delivery pipeline.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use nucleus_engine::EngineRunId;
use nucleus_local_store::SqliteBackend;
use nucleus_server::{
    commands::{
        RunCommand, RunDeliveryExecutionCommand, RunDispatchExecutionCommand, RunProposeCommand,
    },
    ClientId, ControlRequestEnvelopeDto, ControlResponseBodyDto, LocalCodexChatHarnessMode,
    LocalCodexChatReply, LocalCodexChatRequest, ServerCommand, ServerCommandId, ServerCommandKind,
    ServerControlRequest, ServerControlRequestId, ServerControlRequestKind,
    TauriIpcControlCommandAdapter,
};
use tauri::Manager;

use crate::chat_commands::send_agent_chat_message;
use crate::{notifications, DesktopState};

#[derive(Clone, Debug, serde::Deserialize)]
pub(crate) struct RunDispatchRequest {
    pub project_id: String,
    pub slug: String,
    pub objective_scope: String,
    #[serde(default)]
    pub acceptance: Vec<String>,
    #[serde(default)]
    pub stop_conditions: Vec<String>,
    pub provider_instance: String,
    pub provider_model: String,
    #[serde(default)]
    pub token_budget: Option<u64>,
    #[serde(default)]
    pub time_budget_seconds: Option<u64>,
    pub operator_ref: String,
}

#[derive(Clone, Debug, serde::Serialize)]
pub(crate) struct RunDispatchOutcome {
    pub run_id: String,
    pub conversation_id: String,
    pub worktree_slug: String,
    pub branch_ref: String,
    pub brief_reply: LocalCodexChatReply,
}

fn run_conversation_id(run_id: &str) -> String {
    format!("conversation:run:{run_id}")
}

fn unique_run_suffix() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    format!("{millis:x}{counter:x}")
}

#[tauri::command]
pub(crate) async fn dispatch_run(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
    request: RunDispatchRequest,
) -> Result<RunDispatchOutcome, String> {
    let slug = request.slug.trim().to_owned();
    if slug.is_empty() {
        return Err("dispatch requires a worktree slug".to_owned());
    }
    if request.objective_scope.trim().is_empty() {
        return Err("dispatch requires an objective".to_owned());
    }
    if request.operator_ref.trim().is_empty() {
        return Err("dispatch requires an operator ref".to_owned());
    }
    if request.provider_instance.trim().is_empty() || request.provider_model.trim().is_empty() {
        return Err("dispatch requires a provider instance and model".to_owned());
    }

    let run_id = format!("run:{slug}-{}", unique_run_suffix());
    let conversation_id = run_conversation_id(&run_id);
    let worktree_slug = run_id.strip_prefix("run:").unwrap_or(&slug).to_owned();
    let branch_ref = format!("run/{worktree_slug}");
    let adapter = std::sync::Arc::clone(&state.adapter);

    let propose = ServerControlRequest {
        id: ServerControlRequestId(format!("request:run:propose:{run_id}")),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(ServerCommand {
            id: ServerCommandId(format!("command:run:propose:{run_id}")),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerCommandKind::Run(RunCommand::Propose(RunProposeCommand {
                run_id: EngineRunId(run_id.clone()),
                project_id: nucleus_projects::ProjectId(request.project_id.clone()),
                objective_scope: request.objective_scope.clone(),
                acceptance: request.acceptance.clone(),
                stop_conditions: request.stop_conditions.clone(),
                worktree_ref: None,
                provider_instance: request.provider_instance.clone(),
                provider_model: request.provider_model.clone(),
                orchestrator_designation: None,
                token_budget: request.token_budget,
                time_budget_seconds: request.time_budget_seconds,
            })),
        }),
    };
    submit_control(&adapter, propose)?;

    let dispatch = ServerControlRequest {
        id: ServerControlRequestId(format!("request:run:dispatch-exec:{run_id}")),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(ServerCommand {
            id: ServerCommandId(format!("command:run:dispatch-exec:{run_id}")),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerCommandKind::RunDispatchExecution(RunDispatchExecutionCommand {
                run_id: EngineRunId(run_id.clone()),
                expected_revision: None,
                operator_ref: request.operator_ref.clone(),
            }),
        }),
    };
    submit_control(&adapter, dispatch)?;

    let worktree_resource_id = worktree_resource_id(&state, &request.project_id, &worktree_slug)?;
    let brief = worker_brief(&request, &run_id, &worktree_slug, &branch_ref);
    let chat_request = LocalCodexChatRequest {
        conversation_id: conversation_id.clone(),
        project_id: request.project_id.clone(),
        resource_id: Some(worktree_resource_id),
        message: brief,
        active_task_id: None,
        active_goal_id: None,
        provider_instance_id: Some(request.provider_instance.clone()),
        provider_instance_revision: None,
        protocol_facade_id: None,
        provider_id: None,
        model: Some(request.provider_model.clone()),
        reasoning_effort: None,
        harness_mode: LocalCodexChatHarnessMode::Normal,
        idioms_enabled: true,
    };
    let brief_reply = send_agent_chat_message(window.clone(), state.clone(), chat_request).await?;

    // The chat turn has already marked `dispatched -> running` from observed
    // provider activity. Only after that observed completion do we submit the
    // pipeline: intent first, then the gated commit/push runner, then the
    // forge pull-request lane under the confirmed scope.
    let remote_target = remote_target(&state, &request.project_id)?;
    let pushed = !remote_target.is_empty();
    let pull_request_creation = forge_pull_request_scope(&state, &request.project_id, &branch_ref);
    let delivery = ServerControlRequest {
        id: ServerControlRequestId(format!("request:run:delivery:{run_id}")),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(ServerCommand {
            id: ServerCommandId(format!("command:run:delivery:{run_id}")),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerCommandKind::RunDeliveryExecution(RunDeliveryExecutionCommand {
                run_id: EngineRunId(run_id.clone()),
                closeout_summary: brief_reply.assistant_message.clone().unwrap_or_else(|| {
                    "Worker turn completed without an assistant summary.".to_owned()
                }),
                closeout_evidence_refs: vec![format!("turn:{}", brief_reply.turn_id)],
                closeout_diff_ref: Some(format!("worktree:{worktree_slug}")),
                operator_ref: request.operator_ref.clone(),
                commit_message: format!("Deliver {run_id}"),
                remote_target,
                pull_request_creation,
                idempotency_key: format!("delivery:{run_id}"),
                expected_revision: None,
            }),
        }),
    };
    if let Err(error) = submit_control(&adapter, delivery) {
        notifications::publish_command_refusal(
            &window.app_handle(),
            &format!("command:run:delivery:{run_id}"),
            Some(&request.project_id),
            "Run delivery",
            &error,
        );
        return Err(error);
    }
    let pr_url = delivered_pr_url(&state, &run_id);
    notifications::publish_run_delivery(
        &window.app_handle(),
        &run_id,
        pushed,
        pr_url.as_deref(),
    );

    Ok(RunDispatchOutcome {
        run_id,
        conversation_id,
        worktree_slug,
        branch_ref,
        brief_reply,
    })
}

fn submit_control(
    adapter: &Mutex<TauriIpcControlCommandAdapter<SqliteBackend>>,
    request: ServerControlRequest,
) -> Result<(), String> {
    let envelope = ControlRequestEnvelopeDto::try_from(&request).map_err(|error| error.reason)?;
    let response = adapter
        .lock()
        .map_err(|_| "desktop command adapter lock is poisoned".to_owned())?
        .submit_control_envelope(envelope)
        .map_err(|error| error.reason)?;
    match response.body {
        ControlResponseBodyDto::CommandReceipt { status, .. }
            if status == "accepted_for_state_mutation" =>
        {
            Ok(())
        }
        ControlResponseBodyDto::CommandReceipt { status, .. } => {
            Err(format!("run command was not accepted: {status}"))
        }
        ControlResponseBodyDto::Error { reason, .. } => Err(reason),
        _ => Err("run command returned an unexpected response".to_owned()),
    }
}

fn worktree_resource_id(
    state: &DesktopState,
    project_id: &str,
    worktree_slug: &str,
) -> Result<String, String> {
    let record = state
        .server_state
        .projects()
        .get(&nucleus_core::PersistenceRecordId(project_id.to_owned()))
        .map_err(|error| format!("project lookup failed: {error:?}"))?
        .ok_or_else(|| format!("project not found: {project_id}"))?;
    let project = nucleus_projects::decode_project_storage_record(&record.payload.bytes)
        .map_err(|error| format!("project record decode failed: {error:?}"))?;
    project
        .resources
        .iter()
        .find(|resource| {
            resource.kind == nucleus_projects::ProjectResourceStorageKind::GitRepository
                && resource.display_name == worktree_slug
        })
        .map(|resource| resource.resource_id.clone())
        .ok_or_else(|| {
            format!("dispatched worktree resource was not registered for run slug {worktree_slug}")
        })
}

fn remote_target(state: &DesktopState, project_id: &str) -> Result<String, String> {
    let record = state
        .server_state
        .projects()
        .get(&nucleus_core::PersistenceRecordId(project_id.to_owned()))
        .map_err(|error| format!("project lookup failed: {error:?}"))?
        .ok_or_else(|| format!("project not found: {project_id}"))?;
    let project = nucleus_projects::decode_project_storage_record(&record.payload.bytes)
        .map_err(|error| format!("project record decode failed: {error:?}"))?;
    let Some(root) = project.primary_location().map(PathBuf::from) else {
        return Ok(String::new());
    };
    let config = fs::read_to_string(root.join(".git").join("config")).unwrap_or_default();
    Ok(if config.contains("[remote \"origin\"]") {
        "origin".to_owned()
    } else {
        String::new()
    })
}

/// Operator-confirmed PR-creation scope for one run delivery: forge provider
/// inferred from the configured origin remote URL, base branch from the
/// project's default branch, head the run's own branch, title/body generated
/// from the closeout evidence. `None` keeps the delivery branch-only (no
/// forge call) when the project has no origin remote.
fn forge_pull_request_scope(
    state: &DesktopState,
    project_id: &str,
    branch_ref: &str,
) -> Option<nucleus_server::ForgePullRequestCreationScope> {
    let record = state
        .server_state
        .projects()
        .get(&nucleus_core::PersistenceRecordId(project_id.to_owned()))
        .ok()??;
    let project = nucleus_projects::decode_project_storage_record(&record.payload.bytes).ok()?;
    let root = project.primary_location().map(PathBuf::from)?;
    let remote_url = origin_remote_url(&root)?;
    let provider = if remote_url.to_ascii_lowercase().contains("github") {
        nucleus_server::ForgePullRequestProvider::GitHub
    } else if remote_url.to_ascii_lowercase().contains("gitlab") {
        nucleus_server::ForgePullRequestProvider::GitLab
    } else {
        nucleus_server::ForgePullRequestProvider::GenericForge
    };
    Some(nucleus_server::ForgePullRequestCreationScope {
        forge_provider: provider,
        base_branch: project_default_branch(&project),
        head_branch: branch_ref.to_owned(),
        title_source: nucleus_server::ForgePullRequestTextSource::GeneratedFromEvidence,
        body_source: nucleus_server::ForgePullRequestTextSource::GeneratedFromEvidence,
    })
}

fn origin_remote_url(root: &Path) -> Option<String> {
    let config = fs::read_to_string(root.join(".git").join("config")).ok()?;
    let mut in_origin = false;
    for line in config.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_origin = trimmed.contains("\"origin\"");
            continue;
        }
        if in_origin {
            if let Some(url) = trimmed.strip_prefix("url =") {
                let url = url.trim();
                if !url.is_empty() {
                    return Some(url.to_owned());
                }
            }
        }
    }
    None
}

fn project_default_branch(project: &nucleus_projects::ProjectStorageRecord) -> String {
    project
        .default_working_resource
        .as_ref()
        .and_then(|target| project.resource(&target.resource_id))
        .and_then(|resource| resource.default_branch.as_deref())
        .filter(|branch| !branch.trim().is_empty())
        .unwrap_or("main")
        .to_owned()
}

/// Read the pull-request link from the delivered run's closeout evidence
/// (`delivery:pr-url:<url>`), published by the server-owned delivery pipeline
/// after the forge pull-request lane ran.
fn delivered_pr_url(state: &DesktopState, run_id: &str) -> Option<String> {
    let record = state
        .server_state
        .orchestration_runs()
        .get(&nucleus_core::PersistenceRecordId(run_id.to_owned()))
        .ok()??;
    let run = nucleus_engine::decode_run_storage_record(&record.payload.bytes).ok()?;
    let closeout = run.closeout.as_ref()?;
    closeout
        .evidence_refs
        .iter()
        .find_map(|reference| reference.strip_prefix("delivery:pr-url:").map(str::to_owned))
}

fn worker_brief(
    request: &RunDispatchRequest,
    run_id: &str,
    worktree_slug: &str,
    branch_ref: &str,
) -> String {
    let acceptance = if request.acceptance.is_empty() {
        "- none listed".to_owned()
    } else {
        request
            .acceptance
            .iter()
            .map(|item| format!("- {item}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let stop_conditions = if request.stop_conditions.is_empty() {
        "- none listed".to_owned()
    } else {
        request
            .stop_conditions
            .iter()
            .map(|item| format!("- {item}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    format!(
        "# Dispatch brief: {run_id}\n\n\
         You are dispatched as a worker run for this project. Work inside your isolated \
         worktree ({worktree_slug}) on branch {branch_ref}.\n\n\
         ## Objective\n\n{objective}\n\n\
         ## Acceptance\n\n{acceptance}\n\n\
         ## Stop conditions\n\n{stop_conditions}\n\n\
         ## Worker rules\n\n\
         - Operate only inside your run's worktree; do not modify the primary checkout.\n\
         - Follow the project's AGENTS.md and repository conventions.\n\
         - Keep the work bounded to the objective. When a stop condition fires, stop and report.\n\
         - When the work is complete, report a closeout: what changed, the evidence, and a diff summary.\n",
        objective = request.objective_scope.trim(),
    )
}
