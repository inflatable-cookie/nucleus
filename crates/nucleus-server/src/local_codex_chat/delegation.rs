//! Orchestrator delegation tools: the harness-owned verbs an orchestrator
//! session may use (contract 033 Delegation Action Rule).
//!
//! The verbs are declared to the orchestrator's session through the existing
//! dynamic-tool channel only when the session's project has an active
//! designation for the session's provider instance. Every call is validated
//! against the grant envelope before any dispatch; refusals are returned as
//! tool results AND recorded as contract-020 receipts (family `ToolCall`).
//! Grants are deny-by-default; `message_run` / steering is lane phase 4 and
//! is deliberately absent.

use nucleus_core::{PersistenceRecordId, RevisionId};
use nucleus_engine::{
    decode_run_storage_record, EngineDelegationAction, EngineOrchestratorDesignation,
    EngineRunLifecycleState, EngineRuntimeReceiptEffectFamily, EngineRuntimeReceiptRecord,
    EngineRuntimeReceiptRecordId, EngineRuntimeReceiptRef, EngineRuntimeReceiptStatus,
};
use nucleus_local_store::{LocalStoreBackend, RevisionExpectation};
use serde::Deserialize;
use serde_json::{json, Value};

use super::task_authoring::TaskToolOutcome;
use crate::commands::{
    RunCommand, RunDispatchExecutionCommand, RunDeliveryExecutionCommand, RunProposeCommand,
    RunTransitionCommand, ServerCommand, ServerCommandKind,
};
use crate::control_api::{ServerControlRequest, ServerControlRequestKind};
use crate::ids::{ClientId, ServerCommandId, ServerControlRequestId};
use crate::request_handler::designations::active_designation_for_instance;
use crate::runtime_receipt_state::write_runtime_receipt;
use crate::state::ServerStateService;

/// The worker-brief seeding contract for `delegate`: run the worker's first
/// chat turn (the dispatch brief) against the run's conversation and
/// worktree. The production seeder is the reentrant chat service call; a
/// fixture seeder drives the same lifecycle without a live provider. The
/// control-request submitter is passed per call (not captured) so the seeder
/// and the verb handler share one submitter without aliasing.
pub(crate) struct WorkerSeedRequest {
    pub conversation_id: String,
    pub resource_id: String,
    pub brief: String,
    /// Worker route selection for the brief turn (validated against the
    /// envelope before this point).
    pub provider_instance: String,
    pub model: String,
}

pub(crate) struct WorkerSeedOutcome {
    pub turn_id: String,
    pub assistant_message: Option<String>,
}

/// Dynamic tool declarations offered to a designated orchestrator session.
pub(super) fn dynamic_tool_specs() -> Vec<Value> {
    vec![
        json!({
            "type": "function",
            "name": "delegate",
            "description": "Dispatch one worker run in this project from the orchestration registry: an isolated worktree is created through the gated branch/worktree runner, the objective is seeded as the worker's brief, and the completed worker turn is delivered through the run delivery pipeline. Returns the run id and delivery state. Validated against the project's designation grant envelope before dispatch; outside-envelope calls are refused with the reason.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "objective": { "type": "string", "description": "The worker brief's objective and scope. Required." },
                    "acceptance": { "type": "array", "items": { "type": "string" }, "description": "Acceptance criteria, one per entry." },
                    "stop_conditions": { "type": "array", "items": { "type": "string" }, "description": "Stop conditions, one per entry." },
                    "provider_instance": { "type": "string", "description": "Worker provider instance id; must be allowed by the designation envelope." },
                    "model": { "type": "string", "description": "Worker model id; must be allowed by the designation envelope." },
                    "token_budget": { "type": "integer", "description": "Per-run token budget; must fit the envelope's per-run cap." },
                    "time_budget_seconds": { "type": "integer", "description": "Per-run time budget in seconds; must fit the envelope's per-run cap." }
                },
                "required": ["objective", "provider_instance", "model"],
                "additionalProperties": false
            }
        }),
        json!({
            "type": "function",
            "name": "run_status",
            "description": "Read orchestration runs in this project. With run_id, returns that run's lifecycle state, provider, budgets, and closeout presence. Without run_id, returns the project fleet: every run with state, provider, and recency. Runs are project-scoped.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "run_id": { "type": "string", "description": "Optional specific run id; omit for the full project fleet." }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "type": "function",
            "name": "cancel_run",
            "description": "Request cancellation of one of this designation's own runs with deadline truth: the run transitions to cancelled before delivery. Runs dispatched by the operator or another designation are not touchable. Requires the cancel_run grant.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "run_id": { "type": "string", "description": "The run to cancel." },
                    "reason": { "type": "string", "description": "Optional cancellation reason recorded on the run." }
                },
                "required": ["run_id"],
                "additionalProperties": false
            }
        }),
        json!({
            "type": "function",
            "name": "accept_delivery",
            "description": "Accept one delivered run of this designation, transitioning it delivered -> accepted. Acceptance is a separate act from delivery; the operator retains the merge authority. Requires the accept_delivery grant.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "run_id": { "type": "string", "description": "The delivered run to accept." }
                },
                "required": ["run_id"],
                "additionalProperties": false
            }
        }),
        json!({
            "type": "function",
            "name": "reject_delivery",
            "description": "Reject one delivered run of this designation, transitioning it delivered -> rejected with an explicit recorded reason. Requires the reject_delivery grant.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "run_id": { "type": "string", "description": "The delivered run to reject." },
                    "reason": { "type": "string", "description": "Explicit rejection reason; required and recorded." }
                },
                "required": ["run_id", "reason"],
                "additionalProperties": false
            }
        }),
    ]
}

/// Dispatch one delegation tool call: resolve the active designation for the
/// session's route, validate the envelope, and execute the verb. Refusals are
/// tool results and durable receipts.
pub(crate) fn execute<B, S>(
    state: &ServerStateService<B>,
    project_id: &str,
    session_provider_instance: &str,
    turn_id: &str,
    call_id: &str,
    verb: &str,
    arguments: Value,
    command: &mut dyn FnMut(ServerControlRequest) -> Result<(), String>,
    seed_worker: &mut S,
) -> Result<TaskToolOutcome, String>
where
    B: LocalStoreBackend,
    S: FnMut(
        WorkerSeedRequest,
        &mut dyn FnMut(ServerControlRequest) -> Result<(), String>,
    ) -> Result<WorkerSeedOutcome, String>
        + ?Sized,
{
    let designation = active_designation_for_instance(state, project_id, session_provider_instance)?
        .ok_or_else(|| {
            format!(
                "session is not a designated orchestrator for project {project_id}: \
                 no active designation binds provider instance {session_provider_instance}"
            )
        })?;

    // The verb name is validated here so unknown verbs refuse before any
    // envelope check; per-verb envelope validation happens inside each
    // handler so refusals flow through the receipt writer.
    verb_action(verb)?;

    let outcome = match verb {
        "delegate" => execute_delegate(state, &designation, arguments, command, seed_worker),
        "run_status" => execute_run_status(state, &designation, arguments),
        "cancel_run" => execute_cancel(state, &designation, turn_id, call_id, arguments, command),
        "accept_delivery" => {
            execute_disposition(state, &designation, turn_id, call_id, arguments, command, true)
        }
        "reject_delivery" => {
            execute_disposition(state, &designation, turn_id, call_id, arguments, command, false)
        }
        other => Err(format!("unsupported delegation verb: {other}")),
    };

    match outcome {
        Ok(outcome) => {
            write_delegation_receipt(
                state,
                turn_id,
                call_id,
                verb,
                EngineRuntimeReceiptStatus::Completed,
                outcome.summary.clone(),
                outcome.effect_ref.clone(),
            )?;
            Ok(TaskToolOutcome::text(outcome.text))
        }
        Err(reason) => {
            write_delegation_receipt(
                state,
                turn_id,
                call_id,
                verb,
                EngineRuntimeReceiptStatus::Blocked,
                format!("delegation {verb} refused: {reason}"),
                format!("delegation:refusal:{verb}"),
            )?;
            Err(reason)
        }
    }
}

/// One accepted delegation outcome: tool-result text plus receipt evidence.
struct DelegationOutcome {
    text: String,
    summary: String,
    effect_ref: String,
}

impl DelegationOutcome {
    fn text(text: String, summary: String, effect_ref: String) -> Self {
        Self {
            text,
            summary,
            effect_ref,
        }
    }
}

fn verb_action(verb: &str) -> Result<EngineDelegationAction, String> {
    match verb {
        "delegate" => Ok(EngineDelegationAction::Delegate),
        "run_status" => Ok(EngineDelegationAction::RunStatus),
        "cancel_run" => Ok(EngineDelegationAction::CancelRun),
        "accept_delivery" => Ok(EngineDelegationAction::AcceptDelivery),
        "reject_delivery" => Ok(EngineDelegationAction::RejectDelivery),
        other => Err(format!("unsupported delegation verb: {other}")),
    }
}

fn require_action(
    designation: &EngineOrchestratorDesignation,
    action: EngineDelegationAction,
    label: &str,
) -> Result<(), String> {
    if designation
        .allowed_actions
        .contains(&action)
    {
        Ok(())
    } else {
        Err(format!(
            "delegation action {label} is outside the designation grant envelope \
             (allowed actions: {})",
            designation
                .allowed_actions
                .iter()
                .map(action_label)
                .collect::<Vec<_>>()
                .join(", ")
        ))
    }
}

fn action_label(action: &EngineDelegationAction) -> &'static str {
    match action {
        EngineDelegationAction::Delegate => "delegate",
        EngineDelegationAction::RunStatus => "run_status",
        EngineDelegationAction::CancelRun => "cancel_run",
        EngineDelegationAction::AcceptDelivery => "accept_delivery",
        EngineDelegationAction::RejectDelivery => "reject_delivery",
    }
}

#[derive(Deserialize)]
struct DelegateInput {
    objective: String,
    #[serde(default)]
    acceptance: Vec<String>,
    #[serde(default)]
    stop_conditions: Vec<String>,
    provider_instance: String,
    model: String,
    #[serde(default)]
    token_budget: Option<u64>,
    #[serde(default)]
    time_budget_seconds: Option<u64>,
}

fn execute_delegate<B, S>(
    state: &ServerStateService<B>,
    designation: &EngineOrchestratorDesignation,
    arguments: Value,
    command: &mut dyn FnMut(ServerControlRequest) -> Result<(), String>,
    seed_worker: &mut S,
) -> Result<DelegationOutcome, String>
where
    B: LocalStoreBackend,
    S: FnMut(
        WorkerSeedRequest,
        &mut dyn FnMut(ServerControlRequest) -> Result<(), String>,
    ) -> Result<WorkerSeedOutcome, String>
        + ?Sized,
{
    require_action(designation, EngineDelegationAction::Delegate, "delegate")?;

    let input: DelegateInput = serde_json::from_value(arguments)
        .map_err(|error| format!("invalid delegate arguments: {error}"))?;
    if input.objective.trim().is_empty() {
        return Err("delegate requires an objective".to_owned());
    }
    validate_worker_provider(designation, &input.provider_instance)?;
    validate_worker_model(designation, &input.model)?;
    validate_budgets(designation, input.token_budget, input.time_budget_seconds)?;
    concurrent_budget_available(state, &designation.designation_id, designation.concurrent_run_budget)?;

    let run_id = generate_run_id(&input.objective);
    let worktree_slug = run_id.strip_prefix("run:").unwrap_or(&run_id).to_owned();
    let branch_ref = format!("run/{worktree_slug}");
    let conversation_id_for_run = format!("conversation:run:{run_id}");

    submit(
        command,
        ServerControlRequest {
            id: ServerControlRequestId(format!("request:delegation:propose:{run_id}")),
            client_id: ClientId("client:orchestrator".to_owned()),
            kind: ServerControlRequestKind::Command(ServerCommand {
                id: ServerCommandId(format!("command:delegation:propose:{run_id}")),
                client_id: ClientId("client:orchestrator".to_owned()),
                kind: ServerCommandKind::Run(RunCommand::Propose(RunProposeCommand {
                    run_id: nucleus_engine::EngineRunId(run_id.clone()),
                    project_id: nucleus_projects::ProjectId(designation.project_id.clone()),
                    objective_scope: input.objective.trim().to_owned(),
                    acceptance: input.acceptance.clone(),
                    stop_conditions: input.stop_conditions.clone(),
                    worktree_ref: None,
                    provider_instance: input.provider_instance.clone(),
                    provider_model: input.model.clone(),
                    orchestrator_designation: Some(designation.designation_id.clone()),
                    token_budget: input.token_budget,
                    time_budget_seconds: input.time_budget_seconds,
                })),
            }),
        },
    )?;

    // Dispatch is the orchestrator's confirmed act: the designation grant is
    // the durable authority (the delegation receipt records the decision),
    // and the recorded actor is the designation, never the operator.
    submit(
        command,
        ServerControlRequest {
            id: ServerControlRequestId(format!("request:delegation:dispatch:{run_id}")),
            client_id: ClientId("client:orchestrator".to_owned()),
            kind: ServerControlRequestKind::Command(ServerCommand {
                id: ServerCommandId(format!("command:delegation:dispatch:{run_id}")),
                client_id: ClientId("client:orchestrator".to_owned()),
                kind: ServerCommandKind::RunDispatchExecution(RunDispatchExecutionCommand {
                    run_id: nucleus_engine::EngineRunId(run_id.clone()),
                    expected_revision: None,
                    operator_ref: designation.designation_id.clone(),
                }),
            }),
        },
    )?;

    let resource_id = worktree_resource_id(state, &designation.project_id, &worktree_slug)?;
    let brief = worker_brief(&run_id, &worktree_slug, &branch_ref, &input);
    let seed = seed_worker(
        WorkerSeedRequest {
            conversation_id: conversation_id_for_run.clone(),
            resource_id,
            brief,
            provider_instance: input.provider_instance.clone(),
            model: input.model.clone(),
        },
        command,
    )?;

    // The worker turn completed; the run has been marked running from
    // observed provider activity by the chat turn machinery. Deliver through
    // the pipeline: local commit, and push when the project has an origin
    // remote. PR creation stays operator-side (deny-by-default for delegated
    // runs; the per-delivery PR confirmation is an operator act).
    let remote_target = remote_target(state, &designation.project_id)?;
    let closeout_summary = seed
        .assistant_message
        .clone()
        .unwrap_or_else(|| "Worker turn completed without an assistant summary.".to_owned());
    let delivery = ServerControlRequest {
        id: ServerControlRequestId(format!("request:delegation:delivery:{run_id}")),
        client_id: ClientId("client:orchestrator".to_owned()),
        kind: ServerControlRequestKind::Command(ServerCommand {
            id: ServerCommandId(format!("command:delegation:delivery:{run_id}")),
            client_id: ClientId("client:orchestrator".to_owned()),
            kind: ServerCommandKind::RunDeliveryExecution(RunDeliveryExecutionCommand {
                run_id: nucleus_engine::EngineRunId(run_id.clone()),
                closeout_summary: closeout_summary.clone(),
                closeout_evidence_refs: vec![format!("turn:{}", seed.turn_id)],
                closeout_diff_ref: Some(format!("worktree:{worktree_slug}")),
                operator_ref: designation.designation_id.clone(),
                commit_message: format!("Deliver {run_id}"),
                remote_target,
                pull_request_creation: None,
                idempotency_key: format!("delivery:{run_id}"),
                expected_revision: None,
            }),
        }),
    };
    submit(command, delivery)?;

    Ok(DelegationOutcome::text(
        json!({
            "run_id": run_id,
            "conversation_id": conversation_id_for_run,
            "worktree_slug": worktree_slug,
            "branch_ref": branch_ref,
            "state": "delivered",
            "closeout_summary": closeout_summary,
            "orchestrator": designation.designation_id,
        })
        .to_string(),
        format!(
            "delegation accepted: run {run_id} dispatched to {} and delivered",
            input.provider_instance
        ),
        format!("delegation:delegate:{run_id}"),
    ))
}

fn validate_worker_provider(
    designation: &EngineOrchestratorDesignation,
    provider_instance: &str,
) -> Result<(), String> {
    match designation.allowed_worker_provider_instances.as_deref() {
        None => Ok(()),
        Some(allowed) if allowed.iter().any(|id| id == provider_instance) => Ok(()),
        Some(allowed) => Err(format!(
            "worker provider instance {provider_instance} is outside the designation \
             grant envelope (allowed worker providers: {})",
            allowed.join(", ")
        )),
    }
}

fn validate_worker_model(
    designation: &EngineOrchestratorDesignation,
    model: &str,
) -> Result<(), String> {
    match designation.allowed_worker_models.as_deref() {
        None => Ok(()),
        Some(allowed) if allowed.iter().any(|id| id == model) => Ok(()),
        Some(allowed) => Err(format!(
            "worker model {model} is outside the designation grant envelope \
             (allowed worker models: {})",
            allowed.join(", ")
        )),
    }
}

fn validate_budgets(
    designation: &EngineOrchestratorDesignation,
    token_budget: Option<u64>,
    time_budget_seconds: Option<u64>,
) -> Result<(), String> {
    if let (Some(cap), Some(requested)) = (designation.per_run_token_budget, token_budget) {
        if requested > cap {
            return Err(format!(
                "requested token budget {requested} exceeds the designation's per-run cap {cap}"
            ));
        }
    }
    if let (Some(cap), Some(requested)) =
        (designation.per_run_time_budget_seconds, time_budget_seconds)
    {
        if requested > cap {
            return Err(format!(
                "requested time budget {requested}s exceeds the designation's per-run cap {cap}s"
            ));
        }
    }
    Ok(())
}

/// Concurrent-run budget: the number of non-terminal runs this designation
/// owns must stay below the envelope's budget. Fails closed before dispatch.
fn concurrent_budget_available<B>(
    state: &ServerStateService<B>,
    designation_id: &str,
    budget: u64,
) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    let mut active = 0u64;
    for record in state
        .orchestration_runs()
        .list()
        .map_err(|error| format!("run registry listing failed: {error:?}"))?
    {
        let run = decode_run_storage_record(&record.payload.bytes)
            .map_err(|error| format!("run registry payload decode failed: {error:?}"))?;
        if run.orchestrator_designation.as_deref() == Some(designation_id)
            && matches!(
                run.state,
                EngineRunLifecycleState::Proposed
                    | EngineRunLifecycleState::Dispatched
                    | EngineRunLifecycleState::Running
            )
        {
            active += 1;
            if active >= budget {
                return Err(format!(
                    "designation {designation_id} is at its concurrent-run budget \
                     ({budget} active runs); no new delegation until one settles"
                ));
            }
        }
    }
    Ok(())
}

fn generate_run_id(objective: &str) -> String {
    let slug = objective
        .to_lowercase()
        .split(|character: char| !character.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .take(6)
        .collect::<Vec<_>>()
        .join("-");
    let slug = if slug.is_empty() {
        "run".to_owned()
    } else {
        slug.chars().take(40).collect()
    };
    format!("run:{slug}-{}", unique_suffix())
}

fn unique_suffix() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    format!("{millis:x}{counter:x}")
}

/// Resolve the dispatched worktree's project resource id by display name
/// (the run slug), mirroring the desktop dispatch path.
fn worktree_resource_id<B>(
    state: &ServerStateService<B>,
    project_id: &str,
    worktree_slug: &str,
) -> Result<String, String>
where
    B: LocalStoreBackend,
{
    let record = state
        .projects()
        .get(&PersistenceRecordId(project_id.to_owned()))
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

/// Origin remote presence for the delegated run's delivery push. Read-only
/// git config inspection, mirroring the desktop delivery path.
fn remote_target<B>(state: &ServerStateService<B>, project_id: &str) -> Result<String, String>
where
    B: LocalStoreBackend,
{
    let record = state
        .projects()
        .get(&PersistenceRecordId(project_id.to_owned()))
        .map_err(|error| format!("project lookup failed: {error:?}"))?
        .ok_or_else(|| format!("project not found: {project_id}"))?;
    let project = nucleus_projects::decode_project_storage_record(&record.payload.bytes)
        .map_err(|error| format!("project record decode failed: {error:?}"))?;
    let Some(root) = project
        .primary_location()
        .map(std::path::PathBuf::from)
    else {
        return Ok(String::new());
    };
    let config = std::fs::read_to_string(root.join(".git").join("config")).unwrap_or_default();
    Ok(if config.contains("[remote \"origin\"]") {
        "origin".to_owned()
    } else {
        String::new()
    })
}

fn worker_brief(
    run_id: &str,
    worktree_slug: &str,
    branch_ref: &str,
    input: &DelegateInput,
) -> String {
    let acceptance = if input.acceptance.is_empty() {
        "- none listed".to_owned()
    } else {
        input
            .acceptance
            .iter()
            .map(|item| format!("- {item}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let stop_conditions = if input.stop_conditions.is_empty() {
        "- none listed".to_owned()
    } else {
        input
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
        objective = input.objective.trim(),
    )
}

#[derive(Deserialize)]
struct RunStatusInput {
    #[serde(default)]
    run_id: Option<String>,
}

fn execute_run_status<B>(
    state: &ServerStateService<B>,
    designation: &EngineOrchestratorDesignation,
    arguments: Value,
) -> Result<DelegationOutcome, String>
where
    B: LocalStoreBackend,
{
    require_action(designation, EngineDelegationAction::RunStatus, "run_status")?;
    let input: RunStatusInput = serde_json::from_value(arguments)
        .map_err(|error| format!("invalid run_status arguments: {error}"))?;
    match input.run_id.filter(|id| !id.trim().is_empty()) {
        Some(run_id) => {
            let run = load_run(state, &run_id)?;
            validate_run_scope(designation, &run)?;
            Ok(DelegationOutcome::text(
                json!({
                    "run_id": run.run_id.0,
                    "project_id": run.project_id,
                    "state": run_state_label(run.state),
                    "provider_instance": run.provider_instance,
                    "provider_model": run.provider_model,
                    "token_budget": run.budget.token_budget,
                    "time_budget_seconds": run.budget.time_budget_seconds,
                    "has_closeout": run.closeout.is_some(),
                    "orchestrator_designation": run.orchestrator_designation,
                })
                .to_string(),
                format!("run_status returned run {run_id}"),
                format!("delegation:run_status:{run_id}"),
            ))
        }
        None => {
            let mut runs = Vec::new();
            for record in state
                .orchestration_runs()
                .list()
                .map_err(|error| format!("run registry listing failed: {error:?}"))?
            {
                let run = decode_run_storage_record(&record.payload.bytes)
                    .map_err(|error| format!("run registry payload decode failed: {error:?}"))?;
                if run.project_id != designation.project_id {
                    continue;
                }
                runs.push(json!({
                    "run_id": run.run_id.0,
                    "state": run_state_label(run.state),
                    "provider_instance": run.provider_instance,
                    "provider_model": run.provider_model,
                    "updated_at": run.updated_at,
                    "has_closeout": run.closeout.is_some(),
                    "orchestrator_designation": run.orchestrator_designation,
                }));
            }
            runs.sort_by(|left, right| {
                right
                    .get("updated_at")
                    .and_then(Value::as_u64)
                    .cmp(&left.get("updated_at").and_then(Value::as_u64))
            });
            Ok(DelegationOutcome::text(
                json!({ "project_id": designation.project_id, "runs": runs }).to_string(),
                format!("run_status returned the project fleet ({} runs)", runs.len()),
                "delegation:run_status:fleet".to_owned(),
            ))
        }
    }
}

#[derive(Deserialize)]
struct CancelRunInput {
    run_id: String,
    #[serde(default)]
    reason: Option<String>,
}

fn execute_cancel<B>(
    state: &ServerStateService<B>,
    designation: &EngineOrchestratorDesignation,
    turn_id: &str,
    call_id: &str,
    arguments: Value,
    command: &mut dyn FnMut(ServerControlRequest) -> Result<(), String>,
) -> Result<DelegationOutcome, String>
where
    B: LocalStoreBackend,
{
    require_action(designation, EngineDelegationAction::CancelRun, "cancel_run")?;
    let input: CancelRunInput = serde_json::from_value(arguments)
        .map_err(|error| format!("invalid cancel_run arguments: {error}"))?;
    let run = load_run(state, &input.run_id)?;
    validate_run_scope(designation, &run)?;
    submit(
        command,
        ServerControlRequest {
            id: ServerControlRequestId(format!("request:delegation:cancel:{}", input.run_id)),
            client_id: ClientId("client:orchestrator".to_owned()),
            kind: ServerControlRequestKind::Command(ServerCommand {
                id: ServerCommandId(format!(
                    "command:delegation:cancel:{turn_id}:{call_id}"
                )),
                client_id: ClientId("client:orchestrator".to_owned()),
                kind: ServerCommandKind::Run(RunCommand::Cancel(RunTransitionCommand {
                    run_id: nucleus_engine::EngineRunId(input.run_id.clone()),
                    operation_id: None,
                    expected_revision: None,
                    reason: input.reason.clone(),
                })),
            }),
        },
    )?;
    Ok(DelegationOutcome::text(
        json!({ "run_id": input.run_id, "state": "cancelled" }).to_string(),
        format!("run {} cancellation requested", input.run_id),
        format!("delegation:cancel_run:{}", input.run_id),
    ))
}

#[derive(Deserialize)]
struct DispositionInput {
    run_id: String,
    #[serde(default)]
    reason: Option<String>,
}

fn execute_disposition<B>(
    state: &ServerStateService<B>,
    designation: &EngineOrchestratorDesignation,
    turn_id: &str,
    call_id: &str,
    arguments: Value,
    command: &mut dyn FnMut(ServerControlRequest) -> Result<(), String>,
    accept: bool,
) -> Result<DelegationOutcome, String>
where
    B: LocalStoreBackend,
{
    let action = if accept {
        EngineDelegationAction::AcceptDelivery
    } else {
        EngineDelegationAction::RejectDelivery
    };
    require_action(designation, action, if accept { "accept_delivery" } else { "reject_delivery" })?;
    let input: DispositionInput = serde_json::from_value(arguments)
        .map_err(|error| format!("invalid disposition arguments: {error}"))?;
    let run = load_run(state, &input.run_id)?;
    validate_run_scope(designation, &run)?;

    let verb = if accept { "accept" } else { "reject" };
    if accept {
        if input.reason.is_some() {
            return Err("accept_delivery does not take a reason".to_owned());
        }
    } else if input
        .reason
        .as_deref()
        .is_none_or(|reason| reason.trim().is_empty())
    {
        return Err("reject_delivery requires an explicit reason".to_owned());
    }

    let kind = if accept {
        RunCommand::Accept(RunTransitionCommand {
            run_id: nucleus_engine::EngineRunId(input.run_id.clone()),
            operation_id: None,
            expected_revision: None,
            reason: None,
        })
    } else {
        RunCommand::Reject(RunTransitionCommand {
            run_id: nucleus_engine::EngineRunId(input.run_id.clone()),
            operation_id: None,
            expected_revision: None,
            reason: input.reason.clone(),
        })
    };
    submit(
        command,
        ServerControlRequest {
            id: ServerControlRequestId(format!("request:delegation:{verb}:{}", input.run_id)),
            client_id: ClientId("client:orchestrator".to_owned()),
            kind: ServerControlRequestKind::Command(ServerCommand {
                id: ServerCommandId(format!("command:delegation:{verb}:{turn_id}:{call_id}")),
                client_id: ClientId("client:orchestrator".to_owned()),
                kind: ServerCommandKind::Run(kind),
            }),
        },
    )?;

    Ok(DelegationOutcome::text(
        json!({
            "run_id": input.run_id,
            "state": if accept { "accepted" } else { "rejected" }
        })
        .to_string(),
        format!("run {} {}ed", input.run_id, if accept { "accept" } else { "reject" }),
        format!("delegation:{}_delivery:{}", if accept { "accept" } else { "reject" }, input.run_id),
    ))
}

fn load_run<B>(
    state: &ServerStateService<B>,
    run_id: &str,
) -> Result<nucleus_engine::EngineRunStorageRecord, String>
where
    B: LocalStoreBackend,
{
    let record = state
        .orchestration_runs()
        .get(&PersistenceRecordId(run_id.to_owned()))
        .map_err(|error| format!("run lookup failed: {error:?}"))?
        .ok_or_else(|| format!("run not found: {run_id}"))?;
    decode_run_storage_record(&record.payload.bytes)
        .map_err(|error| format!("run payload decode failed: {error:?}"))
}

/// Runs of other designations and operator-dispatched runs are not
/// touchable: a delegated disposition or cancellation requires the run to be
/// this designation's own, in this project, and not already terminal in a
/// way the engine would reject (the engine enforces the transition).
fn validate_run_scope(
    designation: &EngineOrchestratorDesignation,
    run: &nucleus_engine::EngineRunStorageRecord,
) -> Result<(), String> {
    if run.project_id != designation.project_id {
        return Err(format!(
            "run {} belongs to project {}, not the orchestrator's project {}",
            run.run_id.0, run.project_id, designation.project_id
        ));
    }
    if run.orchestrator_designation.as_deref() != Some(designation.designation_id.as_str()) {
        return Err(format!(
            "run {} was not delegated by designation {}; runs not delegated by this \
             designation are not touchable",
            run.run_id.0, designation.designation_id
        ));
    }
    Ok(())
}

fn run_state_label(state: EngineRunLifecycleState) -> &'static str {
    match state {
        EngineRunLifecycleState::Proposed => "proposed",
        EngineRunLifecycleState::Dispatched => "dispatched",
        EngineRunLifecycleState::Running => "running",
        EngineRunLifecycleState::Delivered => "delivered",
        EngineRunLifecycleState::Accepted => "accepted",
        EngineRunLifecycleState::Rejected => "rejected",
        EngineRunLifecycleState::Failed => "failed",
        EngineRunLifecycleState::Cancelled => "cancelled",
    }
}

fn submit(
    command: &mut dyn FnMut(ServerControlRequest) -> Result<(), String>,
    request: ServerControlRequest,
) -> Result<(), String> {
    command(request)
}

/// Durable contract-020 receipt for one delegation decision (accepted or
/// refused) — the audit trail for every delegation decision (contract 033
/// Audit Rule).
fn write_delegation_receipt<B>(
    state: &ServerStateService<B>,
    turn_id: &str,
    call_id: &str,
    verb: &str,
    status: EngineRuntimeReceiptStatus,
    summary: String,
    effect_ref: String,
) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    let receipt = EngineRuntimeReceiptRecord {
        receipt_id: EngineRuntimeReceiptRecordId(format!(
            "receipt:delegation:{turn_id}:{call_id}"
        )),
        family: EngineRuntimeReceiptEffectFamily::ToolCall,
        status,
        command_ref: None,
        effect_ref: Some(EngineRuntimeReceiptRef::Custom(effect_ref)),
        evidence_refs: vec![
            EngineRuntimeReceiptRef::Custom(format!("delegation:{verb}")),
            EngineRuntimeReceiptRef::Custom(format!("call:{call_id}")),
        ],
        artifact_refs: Vec::new(),
        summary: Some(summary),
    };

    write_runtime_receipt(
        state,
        &receipt,
        RevisionId(format!("rev:receipt:delegation:{turn_id}:{call_id}")),
        RevisionExpectation::MustNotExist,
    )
    .map(|_| ())
    .map_err(|error| format!("delegation receipt write failed: {error:?}"))
}

/// Whether the session route currently realizes orchestrator designation:
/// an active designation binds the session's provider instance to the
/// project. Exposed for session tool-set scoping at start and per-turn
/// re-validation (designation revocation blocks new delegation).
pub(crate) fn session_delegation_active<B>(
    state: &ServerStateService<B>,
    project_id: &str,
    provider_instance: &str,
) -> Result<bool, String>
where
    B: LocalStoreBackend,
{
    Ok(active_designation_for_instance(state, project_id, provider_instance)?.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_core::PersistenceRecordId;
    use nucleus_engine::{
        decode_run_storage_record, EngineRunId, EngineRunLifecycleState,
        EngineRuntimeReceiptStatus,
    };
    use nucleus_local_store::SqliteBackend;
    use nucleus_projects::ProjectId;

    use crate::commands::{
        OrchestratorDesignateCommand, OrchestratorDesignationCommand, ServerCommand,
        ServerCommandKind,
    };
    use crate::control_api::{ServerCommandReceiptStatus, ServerControlResponseStatus};
    use crate::ids::{ClientId, ServerCommandId, ServerControlRequestId};
    use crate::project_seed::{
        seed_local_project, seed_local_project_with_resource_root, LocalProjectSeed,
    };
    use crate::request_handler::run_commands::run_transition_from_operation_truth;
    use crate::request_handler::LocalControlRequestHandler;
    use crate::runtime_receipt_state::read_runtime_receipts;

    const PROJECT_ID: &str = "project:delegation-fixture";
    const ORCHESTRATOR_INSTANCE: &str = "codex:local-default";
    const DESIGNATION_ID: &str = "designation:project:delegation-fixture:codex:local-default";
    const WORKER_INSTANCE: &str = "codex:local-default";
    const WORKER_MODEL: &str = "gpt-5.4-mini";

    fn handler() -> (tempfile::TempDir, LocalControlRequestHandler<SqliteBackend>) {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
        (temp_dir, LocalControlRequestHandler::new(backend, None))
    }

    fn seed_project(handler: &LocalControlRequestHandler<SqliteBackend>) {
        seed_local_project(
            handler.state(),
            LocalProjectSeed {
                project_id: PROJECT_ID.to_owned(),
                display_name: "Delegation Fixture".to_owned(),
                importance_level: nucleus_projects::ImportanceLevel::Normal,
            },
        )
        .expect("seed project");
    }

    fn designate_command(
        concurrent_budget: u64,
        worker_instances: Option<Vec<String>>,
        worker_models: Option<Vec<String>>,
        per_run_token_budget: Option<u64>,
        actions: Vec<nucleus_engine::EngineDelegationAction>,
    ) -> ServerCommand {
        ServerCommand {
            id: ServerCommandId("command:designate:fixture".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerCommandKind::OrchestratorDesignation(
                OrchestratorDesignationCommand::Designate(OrchestratorDesignateCommand {
                    designation_id: DESIGNATION_ID.to_owned(),
                    project_id: ProjectId(PROJECT_ID.to_owned()),
                    orchestrator_provider_instance: ORCHESTRATOR_INSTANCE.to_owned(),
                    allowed_worker_provider_instances: worker_instances,
                    allowed_worker_models: worker_models,
                    concurrent_run_budget: concurrent_budget,
                    per_run_token_budget,
                    per_run_time_budget_seconds: None,
                    allowed_actions: actions,
                    steering_permitted: false,
                    expected_revision: None,
                }),
            ),
        }
    }

    fn designate(handler: &mut LocalControlRequestHandler<SqliteBackend>) {
        let response = handler.handle(ServerControlRequest {
            id: ServerControlRequestId("request:designate:fixture".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerControlRequestKind::Command(designate_command(
                2,
                Some(vec![WORKER_INSTANCE.to_owned()]),
                Some(vec![WORKER_MODEL.to_owned()]),
                Some(100_000),
                vec![
                    nucleus_engine::EngineDelegationAction::Delegate,
                    nucleus_engine::EngineDelegationAction::RunStatus,
                    nucleus_engine::EngineDelegationAction::CancelRun,
                    nucleus_engine::EngineDelegationAction::AcceptDelivery,
                    nucleus_engine::EngineDelegationAction::RejectDelivery,
                ],
            )),
        });
        assert_eq!(response.status, ServerControlResponseStatus::Accepted);
    }

    /// Submitter closure driving a real request handler (state clone shares
    /// the backend, so the tool's reads observe the handler's mutations).
    fn submitter(
        handler: &mut LocalControlRequestHandler<SqliteBackend>,
    ) -> impl FnMut(ServerControlRequest) -> Result<(), String> + '_ {
        move |request| {
            let response = handler.handle(request);
            if response.status == ServerControlResponseStatus::Accepted {
                Ok(())
            } else {
                Err(format!("command rejected: {:?}", response.body))
            }
        }
    }

    /// Fake worker-brief seeder: marks the run running from observed
    /// operation truth (as the real chat turn machinery would), writes the
    /// worker's change into the run worktree, and returns a canned closeout.
    fn fake_seeder(
        state: &ServerStateService<SqliteBackend>,
        repo_root: Option<std::path::PathBuf>,
    ) -> impl FnMut(
        WorkerSeedRequest,
        &mut dyn FnMut(ServerControlRequest) -> Result<(), String>,
    ) -> Result<WorkerSeedOutcome, String> + '_ {
        move |request, _submitter| {
            // The deterministic run conversation carries the run id.
            let run_id = request
                .conversation_id
                .strip_prefix("conversation:run:")
                .expect("run conversation")
                .to_owned();
            run_transition_from_operation_truth(
                state,
                "command:delegation:fixture:running",
                &EngineRunId(run_id.clone()),
                Some("operation:fixture".to_owned()),
                EngineRunLifecycleState::Running,
                None,
            )
            .expect("mark running");
            if let Some(repo_root) = repo_root.as_deref() {
                let slug = run_id.strip_prefix("run:").unwrap_or(&run_id);
                let worktree = repo_root
                    .parent()
                    .expect("repo parent")
                    .join(format!(
                        "{}-wt",
                        repo_root
                            .file_name()
                            .map(|name| name.to_string_lossy().into_owned())
                            .unwrap_or_else(|| "repo".to_owned())
                    ))
                    .join(slug);
                std::fs::write(worktree.join("delivery.txt"), "delivered\n").expect("change");
                std::fs::write(
                    worktree.join("Cargo.toml"),
                    "[workspace]\nmembers = []\nresolver = \"2\"\n",
                )
                .expect("cargo manifest");
            }
            Ok(WorkerSeedOutcome {
                turn_id: "turn:fixture".to_owned(),
                assistant_message: Some("delivered fixture".to_owned()),
            })
        }
    }

    fn read_run(
        state: &ServerStateService<SqliteBackend>,
        run_id: &str,
    ) -> nucleus_engine::EngineRunStorageRecord {
        let record = state
            .orchestration_runs()
            .get(&PersistenceRecordId(run_id.to_owned()))
            .expect("run get")
            .expect("run record");
        decode_run_storage_record(&record.payload.bytes).expect("decode run")
    }

    fn delegation_receipts(
        state: &ServerStateService<SqliteBackend>,
    ) -> Vec<EngineRuntimeReceiptRecord> {
        let mut receipts: Vec<EngineRuntimeReceiptRecord> = read_runtime_receipts(state)
            .expect("receipts")
            .into_iter()
            .filter(|receipt| receipt.receipt_id.0.starts_with("receipt:delegation:"))
            .collect();
        receipts.sort_by(|left, right| left.receipt_id.0.cmp(&right.receipt_id.0));
        receipts
    }

    fn call(
        state: &ServerStateService<SqliteBackend>,
        verb: &str,
        arguments: Value,
        command: &mut dyn FnMut(ServerControlRequest) -> Result<(), String>,
        seeder: &mut dyn FnMut(
            WorkerSeedRequest,
            &mut dyn FnMut(ServerControlRequest) -> Result<(), String>,
        ) -> Result<WorkerSeedOutcome, String>,
        call_tag: &str,
    ) -> Result<TaskToolOutcome, String> {
        execute(
            state,
            PROJECT_ID,
            ORCHESTRATOR_INSTANCE,
            "turn:delegation:1",
            call_tag,
            verb,
            arguments,
            command,
            seeder,
        )
    }

    fn expect_err_message(
        result: Result<TaskToolOutcome, String>,
        context: &str,
    ) -> String {
        match result {
            Err(reason) => reason,
            Ok(_) => panic!("{context}: expected refusal, got an accepted outcome"),
        }
    }


    #[test]
    fn delegation_requires_an_active_designation_for_the_session_route() {
        let (_temp, mut handler) = handler();
        seed_project(&handler);
        let state = handler.state().clone();
        let mut command = submitter(&mut handler);
        let mut seeder = fake_seeder(&state, None);

        let error = call(
            &state,
            "run_status",
            json!({}),
            &mut command,
            &mut seeder,
            "call:1",
        )
        .expect_err("no designation refuses the call");
        assert!(error.contains("not a designated orchestrator"));
        assert!(delegation_receipts(&state).is_empty());
    }

    #[test]
    fn envelope_rejects_an_action_outside_the_grant() {
        let (_temp, mut handler) = handler();
        seed_project(&handler);
        let response = handler.handle(ServerControlRequest {
            id: ServerControlRequestId("request:designate:fixture".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerControlRequestKind::Command(designate_command(
                2,
                Some(vec![WORKER_INSTANCE.to_owned()]),
                Some(vec![WORKER_MODEL.to_owned()]),
                None,
                vec![nucleus_engine::EngineDelegationAction::RunStatus],
            )),
        });
        assert_eq!(response.status, ServerControlResponseStatus::Accepted);
        let state = handler.state().clone();
        let mut command = submitter(&mut handler);
        let mut seeder = fake_seeder(&state, None);

        let error = call(
            &state,
            "cancel_run",
            json!({ "run_id": "run:1" }),
            &mut command,
            &mut seeder,
            "call:2",
        )
        .expect_err("cancel_run outside envelope");
        assert!(error.contains("outside the designation grant envelope"));

        // The refusal is recorded as a durable Blocked receipt.
        let receipts = delegation_receipts(&state);
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].status, EngineRuntimeReceiptStatus::Blocked);
        assert!(receipts[0]
            .summary
            .as_deref()
            .is_some_and(|summary| summary.contains("cancel_run refused")));
    }

    #[test]
    fn delegate_refuses_disallowed_worker_provider_and_model() {
        let (_temp, mut handler) = handler();
        seed_project(&handler);
        designate(&mut handler);
        let state = handler.state().clone();
        let mut command = submitter(&mut handler);
        let mut seeder = fake_seeder(&state, None);

        let error = call(
            &state,
            "delegate",
            json!({
                "objective": "implement the delegation fixture",
                "provider_instance": "other:local",
                "model": WORKER_MODEL,
            }),
            &mut command,
            &mut seeder,
            "call:3",
        )
        .expect_err("disallowed worker provider");
        assert!(error.contains("outside the designation grant envelope"));
        assert!(error.contains("other:local"));

        let error = call(
            &state,
            "delegate",
            json!({
                "objective": "implement the delegation fixture",
                "provider_instance": WORKER_INSTANCE,
                "model": "other-model",
            }),
            &mut command,
            &mut seeder,
            "call:4",
        )
        .expect_err("disallowed worker model");
        assert!(error.contains("other-model"));

        // Two refused calls, two Blocked receipts.
        let receipts = delegation_receipts(&state);
        assert_eq!(receipts.len(), 2);
        assert!(receipts
            .iter()
            .all(|receipt| receipt.status == EngineRuntimeReceiptStatus::Blocked));
    }

    #[test]
    fn delegate_refuses_budget_over_the_envelope_cap() {
        let (_temp, mut handler) = handler();
        seed_project(&handler);
        designate(&mut handler);
        let state = handler.state().clone();
        let mut command = submitter(&mut handler);
        let mut seeder = fake_seeder(&state, None);

        let error = call(
            &state,
            "delegate",
            json!({
                "objective": "implement the delegation fixture",
                "provider_instance": WORKER_INSTANCE,
                "model": WORKER_MODEL,
                "token_budget": 200_000,
            }),
            &mut command,
            &mut seeder,
            "call:5",
        )
        .expect_err("budget over cap");
        assert!(error.contains("exceeds the designation's per-run cap"));

        let receipts = delegation_receipts(&state);
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].status, EngineRuntimeReceiptStatus::Blocked);
    }

    #[test]
    fn delegate_fails_closed_at_the_concurrent_run_budget() {
        let (_temp, mut handler) = handler();
        seed_project(&handler);
        // Budget 1: one active run exhausts it.
        let response = handler.handle(ServerControlRequest {
            id: ServerControlRequestId("request:designate:fixture".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerControlRequestKind::Command(designate_command(
                1,
                Some(vec![WORKER_INSTANCE.to_owned()]),
                Some(vec![WORKER_MODEL.to_owned()]),
                None,
                vec![nucleus_engine::EngineDelegationAction::Delegate],
            )),
        });
        assert_eq!(response.status, ServerControlResponseStatus::Accepted);

        // One active run owned by the designation.
        let run_id = "run:active:1";
        let propose = crate::commands::RunCommand::Propose(crate::commands::RunProposeCommand {
            run_id: EngineRunId(run_id.to_owned()),
            project_id: ProjectId(PROJECT_ID.to_owned()),
            objective_scope: "active".to_owned(),
            acceptance: Vec::new(),
            stop_conditions: Vec::new(),
            worktree_ref: None,
            provider_instance: WORKER_INSTANCE.to_owned(),
            provider_model: WORKER_MODEL.to_owned(),
            orchestrator_designation: Some(DESIGNATION_ID.to_owned()),
            token_budget: None,
            time_budget_seconds: None,
        });
        let response = handler.handle(ServerControlRequest {
            id: ServerControlRequestId("request:propose:fixture".to_owned()),
            client_id: ClientId("client:orchestrator".to_owned()),
            kind: ServerControlRequestKind::Command(ServerCommand {
                id: ServerCommandId("command:propose:fixture".to_owned()),
                client_id: ClientId("client:orchestrator".to_owned()),
                kind: ServerCommandKind::Run(propose),
            }),
        });
        assert_eq!(response.status, ServerControlResponseStatus::Accepted);

        let state = handler.state().clone();
        let mut command = submitter(&mut handler);
        let mut seeder = fake_seeder(&state, None);
        let error = call(
            &state,
            "delegate",
            json!({
                "objective": "implement the delegation fixture",
                "provider_instance": WORKER_INSTANCE,
                "model": WORKER_MODEL,
            }),
            &mut command,
            &mut seeder,
            "call:6",
        )
        .expect_err("concurrent budget exhausted");
        assert!(error.contains("at its concurrent-run budget"));

        let receipts = delegation_receipts(&state);
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].status, EngineRuntimeReceiptStatus::Blocked);
    }

    #[test]
    fn run_status_reads_one_run_and_the_project_fleet() {
        let (_temp, mut handler) = handler();
        seed_project(&handler);
        designate(&mut handler);
        let state = handler.state().clone();

        // Persist one proposed run owned by the designation.
        let propose = crate::commands::RunCommand::Propose(crate::commands::RunProposeCommand {
            run_id: EngineRunId("run:status:1".to_owned()),
            project_id: ProjectId(PROJECT_ID.to_owned()),
            objective_scope: "status".to_owned(),
            acceptance: Vec::new(),
            stop_conditions: Vec::new(),
            worktree_ref: None,
            provider_instance: WORKER_INSTANCE.to_owned(),
            provider_model: WORKER_MODEL.to_owned(),
            orchestrator_designation: Some(DESIGNATION_ID.to_owned()),
            token_budget: Some(50_000),
            time_budget_seconds: None,
        });
        let response = handler.handle(ServerControlRequest {
            id: ServerControlRequestId("request:propose:status".to_owned()),
            client_id: ClientId("client:orchestrator".to_owned()),
            kind: ServerControlRequestKind::Command(ServerCommand {
                id: ServerCommandId("command:propose:status".to_owned()),
                client_id: ClientId("client:orchestrator".to_owned()),
                kind: ServerCommandKind::Run(propose),
            }),
        });
        assert_eq!(response.status, ServerControlResponseStatus::Accepted);

        let mut command = submitter(&mut handler);
        let mut seeder = fake_seeder(&state, None);

        let one = call(
            &state,
            "run_status",
            json!({ "run_id": "run:status:1" }),
            &mut command,
            &mut seeder,
            "call:7",
        )
        .expect("run_status one");
        assert!(one.text.contains("\"run:status:1\""));
        assert!(one.text.contains("\"proposed\""));
        assert!(one.text.contains("50000"));

        let fleet = call(
            &state,
            "run_status",
            json!({}),
            &mut command,
            &mut seeder,
            "call:8",
        )
        .expect("run_status fleet");
        assert!(fleet.text.contains("runs"));
        assert!(fleet.text.contains("\"run:status:1\""));

        let receipts = delegation_receipts(&state);
        assert_eq!(receipts.len(), 2);
        assert!(receipts
            .iter()
            .all(|receipt| receipt.status == EngineRuntimeReceiptStatus::Completed));
    }

    #[test]
    fn cancel_run_transitions_an_owned_proposed_run() {
        let (_temp, mut handler) = handler();
        seed_project(&handler);
        designate(&mut handler);
        let state = handler.state().clone();

        let propose = crate::commands::RunCommand::Propose(crate::commands::RunProposeCommand {
            run_id: EngineRunId("run:cancel:1".to_owned()),
            project_id: ProjectId(PROJECT_ID.to_owned()),
            objective_scope: "cancellable".to_owned(),
            acceptance: Vec::new(),
            stop_conditions: Vec::new(),
            worktree_ref: None,
            provider_instance: WORKER_INSTANCE.to_owned(),
            provider_model: WORKER_MODEL.to_owned(),
            orchestrator_designation: Some(DESIGNATION_ID.to_owned()),
            token_budget: None,
            time_budget_seconds: None,
        });
        let response = handler.handle(ServerControlRequest {
            id: ServerControlRequestId("request:propose:cancel".to_owned()),
            client_id: ClientId("client:orchestrator".to_owned()),
            kind: ServerControlRequestKind::Command(ServerCommand {
                id: ServerCommandId("command:propose:cancel".to_owned()),
                client_id: ClientId("client:orchestrator".to_owned()),
                kind: ServerCommandKind::Run(propose),
            }),
        });
        assert_eq!(response.status, ServerControlResponseStatus::Accepted);

        let mut command = submitter(&mut handler);
        let mut seeder = fake_seeder(&state, None);
        let outcome = call(
            &state,
            "cancel_run",
            json!({ "run_id": "run:cancel:1", "reason": "scope changed" }),
            &mut command,
            &mut seeder,
            "call:9",
        )
        .expect("cancel accepted");
        assert!(outcome.text.contains("\"cancelled\""));

        let run = read_run(&state, "run:cancel:1");
        assert_eq!(run.state, EngineRunLifecycleState::Cancelled);

        let receipts = delegation_receipts(&state);
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].status, EngineRuntimeReceiptStatus::Completed);
    }

    #[test]
    fn cancel_run_refuses_runs_not_owned_by_the_designation() {
        let (_temp, mut handler) = handler();
        seed_project(&handler);
        designate(&mut handler);
        let state = handler.state().clone();

        // Operator-dispatched run: orchestrator_designation is None.
        let propose = crate::commands::RunCommand::Propose(crate::commands::RunProposeCommand {
            run_id: EngineRunId("run:operator:1".to_owned()),
            project_id: ProjectId(PROJECT_ID.to_owned()),
            objective_scope: "operator".to_owned(),
            acceptance: Vec::new(),
            stop_conditions: Vec::new(),
            worktree_ref: None,
            provider_instance: WORKER_INSTANCE.to_owned(),
            provider_model: WORKER_MODEL.to_owned(),
            orchestrator_designation: None,
            token_budget: None,
            time_budget_seconds: None,
        });
        let response = handler.handle(ServerControlRequest {
            id: ServerControlRequestId("request:propose:operator".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerControlRequestKind::Command(ServerCommand {
                id: ServerCommandId("command:propose:operator".to_owned()),
                client_id: ClientId("client:desktop".to_owned()),
                kind: ServerCommandKind::Run(propose),
            }),
        });
        assert_eq!(response.status, ServerControlResponseStatus::Accepted);

        let mut command = submitter(&mut handler);
        let mut seeder = fake_seeder(&state, None);
        let error = call(
            &state,
            "cancel_run",
            json!({ "run_id": "run:operator:1" }),
            &mut command,
            &mut seeder,
            "call:10",
        )
        .expect_err("operator run not touchable");
        assert!(error.contains("was not delegated by designation"));
        assert!(error.contains("not touchable"));
    }

    #[test]
    fn accept_delivery_dispositions_a_delivered_owned_run() {
        let (_temp, mut handler) = handler();
        seed_project(&handler);
        designate(&mut handler);
        let state = handler.state().clone();

        // A delivered run persisted directly (the delivery pipeline itself is
        // exercised by the delegate happy-path fixture below).
        persist_delivered_run(&handler, "run:delivered:1", Some(DESIGNATION_ID.to_owned()));

        let mut command = submitter(&mut handler);
        let mut seeder = fake_seeder(&state, None);
        let outcome = call(
            &state,
            "accept_delivery",
            json!({ "run_id": "run:delivered:1" }),
            &mut command,
            &mut seeder,
            "call:11",
        )
        .expect("accept accepted");
        assert!(outcome.text.contains("\"accepted\""));

        let run = read_run(&state, "run:delivered:1");
        assert_eq!(run.state, EngineRunLifecycleState::Accepted);
    }

    #[test]
    fn reject_delivery_requires_and_records_an_explicit_reason() {
        let (_temp, mut handler) = handler();
        seed_project(&handler);
        designate(&mut handler);
        let state = handler.state().clone();
        persist_delivered_run(&handler, "run:delivered:2", Some(DESIGNATION_ID.to_owned()));

        let mut command = submitter(&mut handler);
        let mut seeder = fake_seeder(&state, None);

        let error = call(
            &state,
            "reject_delivery",
            json!({ "run_id": "run:delivered:2" }),
            &mut command,
            &mut seeder,
            "call:12",
        )
        .expect_err("missing reason");
        assert!(error.contains("requires an explicit reason"));

        let outcome = call(
            &state,
            "reject_delivery",
            json!({ "run_id": "run:delivered:2", "reason": "acceptance not met" }),
            &mut command,
            &mut seeder,
            "call:13",
        )
        .expect("reject accepted");
        assert!(outcome.text.contains("\"rejected\""));

        let run = read_run(&state, "run:delivered:2");
        assert_eq!(run.state, EngineRunLifecycleState::Rejected);
    }

    /// Persist a delivered run record directly (fleet-query fixture style).
    fn persist_delivered_run(
        handler: &LocalControlRequestHandler<SqliteBackend>,
        run_id: &str,
        orchestrator_designation: Option<String>,
    ) {
        use nucleus_core::{PersistenceDomain, PersistenceRecordKind, RevisionId};
        use nucleus_engine::{encode_run_storage_record, EngineRunCloseout, EngineRunObjective};
        use nucleus_local_store::{LocalStoreRecord, LocalStoreRecordPayload, RevisionExpectation};

        let run = nucleus_engine::EngineRunStorageRecord {
            run_id: EngineRunId(run_id.to_owned()),
            project_id: PROJECT_ID.to_owned(),
            objective: EngineRunObjective {
                scope: "delivered fixture".to_owned(),
                acceptance: vec!["fixture".to_owned()],
                stop_conditions: Vec::new(),
            },
            worktree_ref: None,
            base_ref: None,
            provider_instance: WORKER_INSTANCE.to_owned(),
            provider_model: WORKER_MODEL.to_owned(),
            orchestrator_designation,
            operation_id: Some("operation:fixture".to_owned()),
            conversation_id: Some(format!("conversation:run:{run_id}")),
            state: EngineRunLifecycleState::Delivered,
            budget: nucleus_engine::EngineRunBudgetEnvelope::default(),
            closeout: Some(EngineRunCloseout {
                summary: "delivered".to_owned(),
                evidence_refs: vec!["turn:fixture".to_owned()],
                diff_ref: None,
            }),
            transitions: Vec::new(),
            created_at: 1,
            updated_at: 1,
        };
        let payload = encode_run_storage_record(&run).expect("encode run");
        handler
            .state()
            .orchestration_runs()
            .put(
                LocalStoreRecord {
                    id: PersistenceRecordId(run_id.to_owned()),
                    domain: PersistenceDomain::OrchestrationRuns,
                    kind: PersistenceRecordKind::OrchestrationRun,
                    revision_id: RevisionId("rev:run:fixture".to_owned()),
                    payload: LocalStoreRecordPayload {
                        media_type: Some("application/json".to_owned()),
                        bytes: payload,
                    },
                },
                RevisionExpectation::MustNotExist,
            )
            .expect("persist delivered run");
    }
    /// Delegate happy path: the full server-side flow through the real
    /// authority chain — propose, gated isolated-worktree creation, worker
    /// brief seed (fixture seeder marking running from observed truth), and
    /// the real delivery pipeline (validation, commit, push). Mirrors the
    /// run-delivery pipeline fixture.
    #[test]
    fn delegate_happy_path_dispatches_seeds_and_delivers() {
        use std::process::Command as SystemCommand;

        fn run_git(cwd: &std::path::Path, args: &[&str]) {
            let status = SystemCommand::new("git")
                .args(args)
                .current_dir(cwd)
                .status()
                .expect("git");
            assert!(status.success(), "git {args:?} failed");
        }

        let temp = tempfile::tempdir().expect("temp dir");
        let mut handler = LocalControlRequestHandler::new(
            SqliteBackend::new(temp.path().join("state.sqlite")),
            None,
        );
        let repo = temp.path().join("repo");
        std::fs::create_dir_all(&repo).expect("repo dir");
        run_git(&repo, &["init", "-q", "-b", "main"]);
        run_git(&repo, &["config", "user.email", "fixture@example.com"]);
        run_git(&repo, &["config", "user.name", "fixture"]);
        std::fs::write(repo.join("readme.md"), "# fixture\n").expect("readme");
        run_git(&repo, &["add", "readme.md"]);
        run_git(&repo, &["commit", "-q", "-m", "initial"]);
        let remote = temp.path().join("remote.git");
        run_git(
            &repo,
            &["init", "--bare", "-q", remote.to_str().expect("remote path")],
        );
        run_git(
            &repo,
            &["remote", "add", "origin", remote.to_str().expect("remote path")],
        );
        seed_local_project_with_resource_root(
            handler.state(),
            LocalProjectSeed::nucleus_local(),
            Some(repo.clone()),
        )
        .expect("seed project");
        // The resource-root seed binds only project:nucleus-local, so the
        // designation must target that project for the real dispatch.
        let response = handler.handle(ServerControlRequest {
            id: ServerControlRequestId("request:designate:happy".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerControlRequestKind::Command(ServerCommand {
                id: ServerCommandId("command:designate:happy".to_owned()),
                client_id: ClientId("client:desktop".to_owned()),
                kind: ServerCommandKind::OrchestratorDesignation(
                    OrchestratorDesignationCommand::Designate(OrchestratorDesignateCommand {
                        designation_id: DESIGNATION_ID.to_owned(),
                        project_id: ProjectId("project:nucleus-local".to_owned()),
                        orchestrator_provider_instance: ORCHESTRATOR_INSTANCE.to_owned(),
                        allowed_worker_provider_instances: Some(vec![WORKER_INSTANCE.to_owned()]),
                        allowed_worker_models: Some(vec![WORKER_MODEL.to_owned()]),
                        concurrent_run_budget: 2,
                        per_run_token_budget: None,
                        per_run_time_budget_seconds: None,
                        allowed_actions: vec![
                            nucleus_engine::EngineDelegationAction::Delegate,
                            nucleus_engine::EngineDelegationAction::RunStatus,
                            nucleus_engine::EngineDelegationAction::CancelRun,
                            nucleus_engine::EngineDelegationAction::AcceptDelivery,
                            nucleus_engine::EngineDelegationAction::RejectDelivery,
                        ],
                        steering_permitted: false,
                        expected_revision: None,
                    }),
                ),
            }),
        });
        assert_eq!(response.status, ServerControlResponseStatus::Accepted);

        let state = handler.state().clone();
        let mut command = submitter(&mut handler);
        let mut seeder = fake_seeder(&state, Some(repo.clone()));

        let outcome = execute(
            &state,
            "project:nucleus-local",
            ORCHESTRATOR_INSTANCE,
            "turn:delegation:1",
            "call:happy:1",
            "delegate",
            json!({
                "objective": "implement the delegation fixture",
                "acceptance": ["fixture delivered"],
                "provider_instance": WORKER_INSTANCE,
                "model": WORKER_MODEL,
            }),
            &mut command,
            &mut seeder,
        )
        .expect("delegate accepted");
        assert!(outcome.text.contains("\"state\":\"delivered\""));

        // Exactly one run, owned by the designation, delivered.
        let records = state
            .orchestration_runs()
            .list()
            .expect("run records");
        assert_eq!(records.len(), 1);
        let run = read_run(&state, &records[0].id.0);
        assert_eq!(run.state, EngineRunLifecycleState::Delivered);
        assert_eq!(
            run.orchestrator_designation.as_deref(),
            Some(DESIGNATION_ID)
        );

        // The worker's worktree exists with the fixture change committed and
        // pushed (the delivery pipeline ran the validation hook).
        let worktree = temp.path().join("repo-wt").join(run_slug(&run.run_id));
        assert!(worktree.join("delivery.txt").exists());
        let changed = SystemCommand::new("git")
            .args(["log", "-1", "--oneline"])
            .current_dir(&worktree)
            .output()
            .expect("git log");
        assert!(changed.status.success());

        // The delegation decision is a durable Completed receipt; the
        // delivery pipeline receipts exist too.
        let receipts = delegation_receipts(&state);
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].status, EngineRuntimeReceiptStatus::Completed);
        assert!(receipts[0]
            .effect_ref
            .as_ref()
            .is_some_and(|reference| matches!(
                reference,
                EngineRuntimeReceiptRef::Custom(value) if value.contains("delegation:delegate:")
            )));
    }

    fn run_slug(run_id: &nucleus_engine::EngineRunId) -> String {
        run_id
            .0
            .strip_prefix("run:")
            .unwrap_or(&run_id.0)
            .to_owned()
    }
}
