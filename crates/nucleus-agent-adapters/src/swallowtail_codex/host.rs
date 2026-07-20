use futures_executor::block_on;
use std::ffi::OsString;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use swallowtail_core::{ExecutionHostId, SafeDiagnostic};
use swallowtail_host_local::{LocalProcessHost, LocalProcessLimits};
use swallowtail_runtime::{
    BoxFuture, Deadline, EnvironmentRef, ExecutableRef, HostServices, JoinedTask, MonotonicInstant,
    RuntimeFailure, ScopeId, ScopedTaskService, TimeService, WorkingResourceRef,
};

const HOST_ID: &str = "nucleus.embedded";
const EXECUTABLE: &str = "nucleus.codex.executable";
const ENVIRONMENT: &str = "nucleus.codex.saved-login";
pub(super) const WORKING_RESOURCE: &str = "nucleus.chat.working-resource";

pub(super) fn local_host(working_directory: &Path) -> Result<LocalProcessHost, String> {
    Ok(LocalProcessHost::builder(LocalProcessLimits::default())
        .approve_executable(
            ExecutableRef::new(EXECUTABLE).map_err(|error| error.to_string())?,
            "codex",
        )
        .approve_environment(environment_ref()?, approved_environment())
        .approve_working_resource(working_resource_ref()?, working_directory)
        .build())
}

pub(super) fn services(host: &Arc<LocalProcessHost>) -> HostServices {
    HostServices::new(host_id())
        .with_task(Arc::new(ThreadTaskService))
        .with_process(host.clone())
        .with_time(host.clone())
        .with_working_resource(host.clone())
}

pub(super) fn environment_ref() -> Result<EnvironmentRef, String> {
    EnvironmentRef::new(ENVIRONMENT).map_err(|error| error.to_string())
}

pub(super) fn working_resource_ref() -> Result<WorkingResourceRef, String> {
    WorkingResourceRef::new(WORKING_RESOURCE).map_err(|error| error.to_string())
}

pub(super) fn deadline_after(time: &dyn TimeService, duration: Duration) -> Deadline {
    let ticks = u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX);
    Deadline::at(MonotonicInstant::from_ticks(
        time.now().ticks().saturating_add(ticks),
    ))
}

pub(super) fn host_id() -> ExecutionHostId {
    ExecutionHostId::new(HOST_ID).expect("static host id is valid")
}

pub(super) fn executable_target() -> &'static str {
    EXECUTABLE
}

pub(super) fn safe_failure(message: impl Into<String>) -> RuntimeFailure {
    RuntimeFailure::new(SafeDiagnostic::new(
        "nucleus.swallowtail.integration_failed",
        message,
    ))
}

fn approved_environment() -> Vec<(OsString, OsString)> {
    const KEYS: &[&str] = &[
        "HOME",
        "PATH",
        "CODEX_HOME",
        "TMPDIR",
        "TEMP",
        "TMP",
        "SYSTEMROOT",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "NO_PROXY",
    ];
    KEYS.iter()
        .filter_map(|key| std::env::var_os(key).map(|value| (OsString::from(key), value)))
        .collect()
}

struct ThreadTaskService;

struct ThreadTask(Mutex<Option<JoinHandle<()>>>);

impl JoinedTask for ThreadTask {
    fn join(self: Box<Self>) -> BoxFuture<'static, Result<(), RuntimeFailure>> {
        Box::pin(async move {
            self.0
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take()
                .ok_or_else(|| safe_failure("Swallowtail task was already joined"))?
                .join()
                .map_err(|_| safe_failure("Swallowtail task failed"))?;
            Ok(())
        })
    }
}

impl ScopedTaskService for ThreadTaskService {
    fn spawn(
        &self,
        _scope: ScopeId,
        task: BoxFuture<'static, ()>,
    ) -> Result<Box<dyn JoinedTask>, RuntimeFailure> {
        Ok(Box::new(ThreadTask(Mutex::new(Some(thread::spawn(
            move || block_on(task),
        ))))))
    }
}
