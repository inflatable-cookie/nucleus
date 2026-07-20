use std::time::Duration;

use nucleus_agent_adapters::{
    run_codex_read_only_smoke, CodexReadOnlySmokeCleanup, CodexReadOnlySmokeStatus,
};
use nucleus_server::{
    CodexAppServerLiveExecutorCleanupStatus, CodexAppServerLiveExecutorMethod,
    CodexAppServerLiveExecutorOutcomeStatus, CodexAppServerTurnStartExecutorSmokeBoundaryRecord,
    CodexAppServerTurnStartExecutorSmokeBoundaryStatus,
};

const SMOKE_MODEL: &str = "gpt-5.4-mini";
const SMOKE_REASONING: &str = "low";
const SMOKE_PROMPT: &str = "Reply with exactly: nucleus codex direct smoke ok";

pub(crate) struct LiveCodexSmokeOutcome {
    pub(crate) provider_write_executed: bool,
    pub(crate) thread_id: Option<String>,
    pub(crate) turn_id: Option<String>,
    pub(crate) turn_status: Option<String>,
    pub(crate) notifications_seen: usize,
    pub(crate) server_requests_seen: usize,
    pub(crate) method_sequence: Vec<CodexAppServerLiveExecutorMethod>,
    pub(crate) outcome_status: CodexAppServerLiveExecutorOutcomeStatus,
    pub(crate) cleanup_status: CodexAppServerLiveExecutorCleanupStatus,
    status: LiveCodexSmokeStatus,
}

impl LiveCodexSmokeOutcome {
    pub(crate) fn status_label(&self) -> &'static str {
        match self.status {
            LiveCodexSmokeStatus::Executed => "executed",
            LiveCodexSmokeStatus::Blocked => "blocked",
            LiveCodexSmokeStatus::Failed => "failed",
            LiveCodexSmokeStatus::TimedOut => "timed_out",
            LiveCodexSmokeStatus::CleanupRequired => "cleanup_required",
        }
    }

    #[cfg(test)]
    pub(crate) fn executed_for_test(label: &str) -> Self {
        Self {
            provider_write_executed: true,
            thread_id: Some(format!("thread:{label}")),
            turn_id: Some(format!("turn:{label}")),
            turn_status: Some("completed".to_owned()),
            notifications_seen: 3,
            server_requests_seen: 1,
            method_sequence: completed_method_sequence(),
            outcome_status: CodexAppServerLiveExecutorOutcomeStatus::Completed,
            cleanup_status: CodexAppServerLiveExecutorCleanupStatus::Completed,
            status: LiveCodexSmokeStatus::Executed,
        }
    }

    #[cfg(test)]
    pub(crate) fn blocked_for_test() -> Self {
        Self {
            provider_write_executed: false,
            thread_id: None,
            turn_id: None,
            turn_status: None,
            notifications_seen: 0,
            server_requests_seen: 0,
            method_sequence: Vec::new(),
            outcome_status: CodexAppServerLiveExecutorOutcomeStatus::Blocked(
                "durable live provider-write gate blocked".to_owned(),
            ),
            cleanup_status: CodexAppServerLiveExecutorCleanupStatus::NotRequired,
            status: LiveCodexSmokeStatus::Blocked,
        }
    }

    #[cfg(test)]
    pub(crate) fn cleanup_required_for_test(label: &str) -> Self {
        let reason = "turn cleanup failed".to_owned();
        let outcome_status =
            CodexAppServerLiveExecutorOutcomeStatus::CleanupRequired(reason.clone());
        Self {
            provider_write_executed: true,
            thread_id: Some(format!("thread:{label}")),
            turn_id: Some(format!("turn:{label}")),
            turn_status: Some("completed".to_owned()),
            notifications_seen: 2,
            server_requests_seen: 0,
            method_sequence: method_sequence("completed"),
            outcome_status,
            cleanup_status: CodexAppServerLiveExecutorCleanupStatus::Failed(reason),
            status: LiveCodexSmokeStatus::CleanupRequired,
        }
    }
}

#[derive(Clone, Copy)]
enum LiveCodexSmokeStatus {
    Executed,
    Blocked,
    Failed,
    TimedOut,
    CleanupRequired,
}

pub(crate) fn run_live_codex_turn_start_smoke(
    boundary: &CodexAppServerTurnStartExecutorSmokeBoundaryRecord,
) -> Result<LiveCodexSmokeOutcome, String> {
    if boundary.status
        != CodexAppServerTurnStartExecutorSmokeBoundaryStatus::EligibleForSeparatelyConfirmedRealWriteSmoke
    {
        return Ok(LiveCodexSmokeOutcome::blocked_for_runtime());
    }

    let cwd =
        std::env::current_dir().map_err(|error| format!("failed to read current dir: {error}"))?;
    let outcome = run_codex_read_only_smoke(
        &cwd,
        SMOKE_MODEL,
        SMOKE_REASONING,
        SMOKE_PROMPT,
        Duration::from_secs(120),
    )?;
    let (status, outcome_status) = match outcome.status {
        CodexReadOnlySmokeStatus::Completed => (
            LiveCodexSmokeStatus::Executed,
            CodexAppServerLiveExecutorOutcomeStatus::Completed,
        ),
        CodexReadOnlySmokeStatus::Failed(reason) => (
            LiveCodexSmokeStatus::Failed,
            CodexAppServerLiveExecutorOutcomeStatus::Failed(reason),
        ),
        CodexReadOnlySmokeStatus::TimedOut => (
            LiveCodexSmokeStatus::TimedOut,
            CodexAppServerLiveExecutorOutcomeStatus::TimedOut,
        ),
        CodexReadOnlySmokeStatus::CleanupRequired(reason) => (
            LiveCodexSmokeStatus::CleanupRequired,
            CodexAppServerLiveExecutorOutcomeStatus::CleanupRequired(reason),
        ),
    };
    let cleanup_status = match outcome.cleanup {
        CodexReadOnlySmokeCleanup::Completed => CodexAppServerLiveExecutorCleanupStatus::Completed,
        CodexReadOnlySmokeCleanup::Failed(reason) => {
            CodexAppServerLiveExecutorCleanupStatus::Failed(reason)
        }
    };
    let method_sequence = method_sequence(&outcome.turn_status);

    Ok(LiveCodexSmokeOutcome {
        provider_write_executed: outcome.provider_turn_started,
        thread_id: Some(outcome.thread_id),
        turn_id: Some(outcome.turn_id),
        turn_status: Some(outcome.turn_status),
        notifications_seen: outcome.events_seen,
        server_requests_seen: outcome.provider_requests_seen,
        method_sequence,
        outcome_status,
        cleanup_status,
        status,
    })
}

impl LiveCodexSmokeOutcome {
    fn blocked_for_runtime() -> Self {
        Self {
            provider_write_executed: false,
            thread_id: None,
            turn_id: None,
            turn_status: None,
            notifications_seen: 0,
            server_requests_seen: 0,
            method_sequence: Vec::new(),
            outcome_status: CodexAppServerLiveExecutorOutcomeStatus::Blocked(
                "durable live provider-write gate blocked".to_owned(),
            ),
            cleanup_status: CodexAppServerLiveExecutorCleanupStatus::NotRequired,
            status: LiveCodexSmokeStatus::Blocked,
        }
    }
}

fn method_sequence(turn_status: &str) -> Vec<CodexAppServerLiveExecutorMethod> {
    if turn_status == "completed" {
        return completed_method_sequence();
    }
    let mut methods = vec![
        CodexAppServerLiveExecutorMethod::Initialize,
        CodexAppServerLiveExecutorMethod::InitializedNotification,
        CodexAppServerLiveExecutorMethod::ThreadStart,
        CodexAppServerLiveExecutorMethod::TurnStart,
    ];
    methods.push(CodexAppServerLiveExecutorMethod::Cleanup);
    methods
}

pub(crate) fn completed_method_sequence() -> Vec<CodexAppServerLiveExecutorMethod> {
    vec![
        CodexAppServerLiveExecutorMethod::Initialize,
        CodexAppServerLiveExecutorMethod::InitializedNotification,
        CodexAppServerLiveExecutorMethod::ThreadStart,
        CodexAppServerLiveExecutorMethod::TurnStart,
        CodexAppServerLiveExecutorMethod::TurnCompleted,
        CodexAppServerLiveExecutorMethod::Cleanup,
    ]
}
