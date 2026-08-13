//! Run dispatch Tauri command: operator-confirmed dispatch of a worker run.
//!
//! The dispatch dialog's explicit confirm act drives the whole sequence:
//! propose the run record, execute the operator-confirmed dispatch (the
//! server writes the durable branch/worktree runner effect intent and runs
//! the gated `git worktree add` — never a bare spawn), then seed the worker
//! brief as the first message of the deterministic run conversation
//! (`conversation:run:<run_id>`) bound to the worktree resource. The turn
//! hook transitions the run to running when the first activity is observed.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use nucleus_engine::EngineRunId;
use nucleus_local_store::SqliteBackend;
use nucleus_server::{
    commands::{RunCommand, RunDispatchExecutionCommand, RunProposeCommand},
    ClientId, ControlRequestEnvelopeDto, ControlResponseBodyDto, LocalCodexChatHarnessMode,
    LocalCodexChatReply, LocalCodexChatRequest, ServerCommand, ServerCommandId,
    ServerCommandKind, ServerControlRequest, ServerControlRequestId, ServerControlRequestKind,
    TauriIpcControlCommandAdapter,
};

use crate::chat_commands::send_agent_chat_message;
use crate::DesktopState;

/// Objective form from the dispatch dialog (the run's contract-033 fields).
#[derive(Clone, Debug, serde::Deserialize)]
pub(crate) struct RunDispatchRequest {
    pub project_id: String,
    /// Worktree slug; the server derives the worktree
    /// (`<repo>-wt/<slug>` on branch `run/<slug>`) from the run id.
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

/// Dispatch result returned to the UI.
#[derive(Clone, Debug, serde::Serialize)]
pub(crate) struct RunDispatchOutcome {
    pub run_id: String,
    pub conversation_id: String,
    pub worktree_slug: String,
    pub branch_ref: String,
    pub brief_reply: LocalCodexChatReply,
}

/// The run's deterministic worker conversation id.
fn run_conversation_id(run_id: &str) -> String {
    format!("conversation:run:{run_id}")
}

/// Unique short run id suffix: monotonic counter + millis, hex.
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
    // The server derives the worktree slug from the run id: `<slug>-<suffix>`.
    let worktree_slug = run_id
        .strip_prefix("run:")
        .unwrap_or(&slug)
        .to_owned();
    let branch_ref = format!("run/{worktree_slug}");
    let adapter = std::sync::Arc::clone(&state.adapter);

    // 1. Propose the run record (contract 033 Run Record Rule).
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

    // 2. Dispatch execution: the dispatch command IS the operator
    // confirmation; the server writes the durable effect intent and drives
    // the gated isolated-worktree creation, registers the worktree resource,
    // and binds the deterministic conversation to the run record.
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

    // 3. Locate the worktree resource the server registered: display name is
    // the worktree directory basename (the run slug).
    let worktree_resource_id = worktree_resource_id(&state, &request.project_id, &worktree_slug)?;

    // 4. Seed the brief as the worker conversation's first message; the
    // turn-start hook transitions the run to running from observed activity.
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
    let brief_reply = send_agent_chat_message(window, state, chat_request).await?;

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
    let envelope = ControlRequestEnvelopeDto::try_from(&request)
        .map_err(|error| error.reason)?;
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
            Err(format!("run dispatch command was not accepted: {status}"))
        }
        ControlResponseBodyDto::Error { reason, .. } => Err(reason),
        _ => Err("run dispatch command returned an unexpected response".to_owned()),
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

/// The playbook-shaped worker brief rendered into the worker's first message:
/// objective, scope, acceptance, stop conditions, and worker rules.
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
