//! Registry of live agent runtimes keyed by adapter id.
//!
//! Hosts resolve a provider runtime by adapter id instead of hardcoding a
//! provider; new adapters register here.

use std::sync::Arc;

use nucleus_agent_protocol::{AgentSessionRuntime, TaskExecutionRuntime};

use crate::swallowtail_codex::{
    SwallowtailCodexSessionRuntime, SwallowtailCodexTaskExecutionRuntime,
};

/// Registry of live, executable adapter runtimes.
#[derive(Clone, Default)]
pub struct AgentAdapterRegistry {
    runtimes: Vec<Arc<dyn AgentSessionRuntime + Send + Sync>>,
    task_runtimes: Vec<Arc<dyn TaskExecutionRuntime + Send + Sync>>,
}

impl AgentAdapterRegistry {
    /// Registry with every built-in adapter registered.
    pub fn with_builtin_adapters() -> Self {
        let mut registry = Self::default();
        registry.register(Arc::new(SwallowtailCodexSessionRuntime));
        registry.register_task_runtime(Arc::new(SwallowtailCodexTaskExecutionRuntime));
        registry
    }

    pub fn register(&mut self, runtime: Arc<dyn AgentSessionRuntime + Send + Sync>) {
        self.runtimes.push(runtime);
    }

    pub fn register_task_runtime(&mut self, runtime: Arc<dyn TaskExecutionRuntime + Send + Sync>) {
        self.task_runtimes.push(runtime);
    }

    pub fn adapter_ids(&self) -> Vec<String> {
        self.runtimes
            .iter()
            .map(|runtime| runtime.adapter_id().to_owned())
            .collect()
    }

    /// Resolve one adapter's runtime by id.
    pub fn runtime(
        &self,
        adapter_id: &str,
    ) -> Result<Arc<dyn AgentSessionRuntime + Send + Sync>, String> {
        self.runtimes
            .iter()
            .find(|runtime| runtime.adapter_id() == adapter_id)
            .cloned()
            .ok_or_else(|| format!("no live adapter registered for {adapter_id}"))
    }

    /// Resolve one adapter's bounded task-execution runtime by id.
    pub fn task_runtime(
        &self,
        adapter_id: &str,
    ) -> Result<Arc<dyn TaskExecutionRuntime + Send + Sync>, String> {
        self.task_runtimes
            .iter()
            .find(|runtime| runtime.adapter_id() == adapter_id)
            .cloned()
            .ok_or_else(|| format!("no task execution adapter registered for {adapter_id}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::swallowtail_codex::CODEX_LIVE_ADAPTER_ID;

    #[test]
    fn builtin_registry_resolves_codex_and_rejects_unknown_adapters() {
        let registry = AgentAdapterRegistry::with_builtin_adapters();

        assert!(registry.runtime(CODEX_LIVE_ADAPTER_ID).is_ok());
        assert!(registry.task_runtime(CODEX_LIVE_ADAPTER_ID).is_ok());
        assert!(registry.runtime("claude").is_err());
        assert!(registry.task_runtime("claude").is_err());
        assert_eq!(registry.adapter_ids(), vec![CODEX_LIVE_ADAPTER_ID]);
    }
}
