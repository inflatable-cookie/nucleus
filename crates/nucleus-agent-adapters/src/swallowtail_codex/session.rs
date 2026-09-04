//! The live Codex chat session wrapper.
//!
//! Split from the swallowtail_codex god file; behavior unchanged.

use std::time::Duration;

use futures_executor::block_on;
use nucleus_agent_protocol::{
    AgentActivityHandler, AgentHarnessMode, AgentLiveSession, AgentStartedSessionInfo,
    AgentToolCallHandler, AgentTurnFailure, AgentTurnReply, AgentTurnRequest,
    AgentUserInputHandler,
};
use swallowtail_runtime::{HostServices, InteractiveSessionHandle, OperationContent, TurnRequest};

use super::host;
use super::runtime_error;
use super::runtime_turn_id;
use super::turn::{completed_output, drive_turn, require_clean_turn};

pub(super) struct SwallowtailCodexLiveSession {
    pub(super) info: AgentStartedSessionInfo,
    pub(super) session: Option<Box<dyn InteractiveSessionHandle>>,
    pub(super) services: HostServices,
    pub(super) turn_timeout: Duration,
}

impl AgentLiveSession for SwallowtailCodexLiveSession {
    fn info(&self) -> &AgentStartedSessionInfo {
        &self.info
    }

    fn send_turn(
        &mut self,
        request: AgentTurnRequest,
        on_activity: &mut AgentActivityHandler<'_>,
        on_tool_call: &mut AgentToolCallHandler<'_>,
        on_user_input: &mut AgentUserInputHandler<'_>,
    ) -> Result<AgentTurnReply, AgentTurnFailure> {
        if request.model != self.info.model
            || Some(request.reasoning_effort.as_str()) != self.info.reasoning_effort.as_deref()
        {
            return Err(AgentTurnFailure::Failed(
                "chat route changed; reopen the provider session".to_owned(),
            ));
        }
        let session = self
            .session
            .as_mut()
            .ok_or_else(|| "Codex session is already closed".to_owned())?;
        let deadline = self
            .services
            .time()
            .map(|time| host::deadline_after(time.as_ref(), self.turn_timeout))
            .ok_or_else(|| "Codex turn time service is unavailable".to_owned())?;
        let mut turn = block_on(
            session.start_turn(
                TurnRequest::new(
                    runtime_turn_id("chat")?,
                    OperationContent::new(request.message).map_err(|error| error.to_string())?,
                )
                .with_deadline(deadline),
                self.services.clone(),
            ),
        )
        .map_err(runtime_error)?;
        let provider_turn_id = turn
            .provider_turn_ref()
            .ok_or_else(|| "Codex turn did not return a provider turn id".to_owned())?
            .as_provider_value()
            .to_owned();
        let outcome = block_on(drive_turn(
            turn.as_mut(),
            &provider_turn_id,
            &request.cancellation,
            on_activity,
            on_tool_call,
            on_user_input,
        ));
        let cleanup = block_on(turn.close());
        let outcome = outcome?;
        require_clean_turn(cleanup)?;
        let assistant_message =
            completed_output(&outcome, self.info.harness_mode == AgentHarnessMode::Plan)?;

        Ok(AgentTurnReply {
            turn_id: provider_turn_id,
            assistant_message,
        })
    }
}

impl Drop for SwallowtailCodexLiveSession {
    fn drop(&mut self) {
        if let Some(session) = self.session.take() {
            let _ = block_on(session.close(
                host::cleanup_request(&self.services, self.turn_timeout),
                self.services.clone(),
            ));
        }
    }
}
