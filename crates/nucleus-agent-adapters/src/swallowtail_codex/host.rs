use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;
use swallowtail_adapter_codex::CODEX_CLI_AXIS;
use swallowtail_core::{ExecutionHostId, InterfaceVersionAxis};
use swallowtail_host_local::{LocalHostServices, LocalProcessHost, LocalProcessLimits};
use swallowtail_runtime::{
    Deadline, EnvironmentRef, ExecutableRef, HostServices, InstalledExecutableTarget,
    MonotonicInstant, TimeService, WorkingResourceRef,
};

const HOST_ID: &str = "nucleus.embedded";
const EXECUTABLE: &str = "nucleus.codex.executable";
const ENVIRONMENT: &str = "nucleus.codex.saved-login";
pub(super) const WORKING_RESOURCE: &str = "nucleus.chat.working-resource";

#[derive(Clone)]
pub(super) struct CodexHost {
    local: LocalHostServices,
    target: InstalledExecutableTarget,
    environment: EnvironmentRef,
    working_resource: WorkingResourceRef,
}

impl CodexHost {
    pub(super) fn services(&self) -> HostServices {
        self.local.services().clone()
    }

    pub(super) const fn target(&self) -> &InstalledExecutableTarget {
        &self.target
    }

    pub(super) const fn environment(&self) -> &EnvironmentRef {
        &self.environment
    }

    pub(super) const fn working_resource(&self) -> &WorkingResourceRef {
        &self.working_resource
    }
}

pub(super) fn local_host(working_directory: &Path) -> Result<CodexHost, String> {
    let codex_executable = resolve_codex_executable()?;
    approved_host(working_directory, codex_executable)
}

pub(super) fn approved_host(
    working_directory: &Path,
    codex_executable: PathBuf,
) -> Result<CodexHost, String> {
    let environment = EnvironmentRef::new(ENVIRONMENT).map_err(|error| error.to_string())?;
    let working_resource =
        WorkingResourceRef::new(WORKING_RESOURCE).map_err(|error| error.to_string())?;
    let executable = ExecutableRef::new(EXECUTABLE).map_err(|error| error.to_string())?;
    let axis = InterfaceVersionAxis::new(CODEX_CLI_AXIS).map_err(|error| error.to_string())?;
    let (builder, target) = LocalProcessHost::builder(LocalProcessLimits::default())
        .approve_installed_executable(executable, axis, codex_executable);
    let local = builder
        .approve_environment(environment.clone(), approved_environment())
        .approve_working_resource(working_resource.clone(), working_directory)
        .build_services(host_id());
    Ok(CodexHost {
        local,
        target,
        environment,
        working_resource,
    })
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

fn resolve_codex_executable() -> Result<PathBuf, String> {
    let path = std::env::var_os("PATH");
    find_executable_in_path("codex", path.as_deref())
        .or_else(|| {
            fallback_codex_candidates()
                .into_iter()
                .find(|path| is_direct_executable(path))
        })
        .map(|path| std::fs::canonicalize(&path).unwrap_or(path))
        .ok_or_else(|| {
            "Nucleus could not resolve a direct host-approved Codex executable; script launchers cannot satisfy environment-free version discovery"
                .to_owned()
        })
}

fn find_executable_in_path(name: &str, path: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    let path = path?;
    std::env::split_paths(path)
        .flat_map(|directory| executable_names(name).map(move |name| directory.join(name)))
        .find(|candidate| is_direct_executable(candidate))
}

fn executable_names(name: &str) -> impl Iterator<Item = String> {
    #[cfg(windows)]
    let names = [format!("{name}.exe"), name.to_owned()];
    #[cfg(not(windows))]
    let names = [name.to_owned()];
    names.into_iter()
}

fn fallback_codex_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        let home = PathBuf::from(home);
        for name in executable_names("codex") {
            candidates.push(home.join(".local/bin").join(&name));
            candidates.push(
                home.join(".codex/packages/standalone/current/bin")
                    .join(&name),
            );
        }
    }
    #[cfg(not(windows))]
    {
        candidates.push(PathBuf::from("/opt/homebrew/bin/codex"));
        candidates.push(PathBuf::from("/usr/local/bin/codex"));
        candidates.push(PathBuf::from("/usr/bin/codex"));
    }
    candidates
}

fn is_direct_executable(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return false;
        }
    }
    let mut header = [0_u8; 2];
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    matches!(file.read(&mut header), Ok(2)) && header != *b"#!"
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

#[cfg(test)]
mod tests {
    use super::{find_executable_in_path, is_direct_executable};

    #[test]
    fn path_resolution_promotes_an_absolute_executable_target() {
        let current = std::env::current_exe().expect("test executable path");
        let parent = current.parent().expect("test executable parent");
        let name = current
            .file_name()
            .and_then(|name| name.to_str())
            .expect("test executable name");
        let search_path = std::env::join_paths([parent]).expect("search path");

        let resolved =
            find_executable_in_path(name, Some(&search_path)).expect("executable is found");

        assert!(resolved.is_absolute());
        assert_eq!(resolved, current);
        assert!(is_direct_executable(&resolved));
    }
}
