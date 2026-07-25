use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use nucleus_agent_protocol::AgentTurnCancellation;

#[derive(Clone, Default)]
pub struct LocalCodexChatCancellationRegistry {
    active: Arc<Mutex<HashMap<ChatTurnKey, AgentTurnCancellation>>>,
}

impl LocalCodexChatCancellationRegistry {
    pub fn begin(
        &self,
        project_id: &str,
        conversation_id: &str,
    ) -> Result<ActiveLocalCodexChatTurn, String> {
        let key = ChatTurnKey::new(project_id, conversation_id)?;
        let cancellation = AgentTurnCancellation::new();
        let mut active = self
            .active
            .lock()
            .map_err(|_| "agent chat cancellation registry is poisoned".to_owned())?;
        if active.contains_key(&key) {
            return Err("agent chat conversation already has an active turn".to_owned());
        }
        active.insert(key.clone(), cancellation.clone());
        Ok(ActiveLocalCodexChatTurn {
            registry: self.clone(),
            key,
            cancellation,
        })
    }

    pub fn request(&self, project_id: &str, conversation_id: &str) -> Result<bool, String> {
        let key = ChatTurnKey::new(project_id, conversation_id)?;
        let active = self
            .active
            .lock()
            .map_err(|_| "agent chat cancellation registry is poisoned".to_owned())?;
        Ok(active.get(&key).is_some_and(AgentTurnCancellation::request))
    }

    fn finish(&self, key: &ChatTurnKey, cancellation: &AgentTurnCancellation) {
        if let Ok(mut active) = self.active.lock() {
            if active
                .get(key)
                .is_some_and(|current| current.same_request(cancellation))
            {
                active.remove(key);
            }
        }
    }
}

pub struct ActiveLocalCodexChatTurn {
    registry: LocalCodexChatCancellationRegistry,
    key: ChatTurnKey,
    cancellation: AgentTurnCancellation,
}

impl ActiveLocalCodexChatTurn {
    pub fn cancellation(&self) -> AgentTurnCancellation {
        self.cancellation.clone()
    }
}

impl Drop for ActiveLocalCodexChatTurn {
    fn drop(&mut self) {
        self.registry.finish(&self.key, &self.cancellation);
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ChatTurnKey {
    project_id: String,
    conversation_id: String,
}

impl ChatTurnKey {
    fn new(project_id: &str, conversation_id: &str) -> Result<Self, String> {
        let project_id = project_id.trim();
        let conversation_id = conversation_id.trim();
        if project_id.is_empty() || conversation_id.is_empty() {
            return Err("agent chat cancellation target must be explicit".to_owned());
        }
        Ok(Self {
            project_id: project_id.to_owned(),
            conversation_id: conversation_id.to_owned(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::LocalCodexChatCancellationRegistry;

    #[test]
    fn cancellation_targets_only_the_exact_active_conversation() {
        let registry = LocalCodexChatCancellationRegistry::default();
        let active = registry
            .begin("project:one", "conversation:one")
            .expect("begin active turn");

        assert!(!registry
            .request("project:one", "conversation:other")
            .expect("request other conversation"));
        assert!(registry
            .request("project:one", "conversation:one")
            .expect("request active conversation"));
        assert!(active.cancellation().is_requested());
        assert!(!registry
            .request("project:one", "conversation:one")
            .expect("repeat request"));
    }

    #[test]
    fn active_registration_is_released_with_its_guard() {
        let registry = LocalCodexChatCancellationRegistry::default();
        let active = registry
            .begin("project:one", "conversation:one")
            .expect("begin active turn");
        assert!(registry.begin("project:one", "conversation:one").is_err());

        drop(active);

        assert!(registry.begin("project:one", "conversation:one").is_ok());
    }
}
