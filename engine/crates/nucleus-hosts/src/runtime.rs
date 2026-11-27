use reqwest::Url;
use rustix::{
    fs::{FileType, Mode, OFlags, fstat, open},
    process::geteuid,
};
use serde::Deserialize;
use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::Read,
    net::SocketAddr,
    path::Path,
};
use time::{
    OffsetDateTime,
    format_description::well_known::{Rfc2822, Rfc3339},
};

use crate::process::capture;

const MAX_DESCRIPTOR: u64 = 8192;

pub(crate) struct ServerRuntime {
    pub pid: u32,
    started: OffsetDateTime,
}

impl ServerRuntime {
    pub(crate) fn identity(&self) -> String {
        format!("{}:{}", self.pid, self.started.unix_timestamp_nanos())
    }

    pub(crate) fn replay_identity(&self) -> String {
        format!("socket:{}", self.identity())
    }

    pub(crate) fn read(path: &Path, endpoint: &Url) -> Option<Self> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Descriptor {
            origin: String,
            pid: u32,
            started_at: String,
        }
        if !path.is_absolute() {
            return None;
        }
        let fd = open(
            path,
            OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
            Mode::empty(),
        )
        .ok()?;
        let metadata = fstat(&fd).ok()?;
        if FileType::from_raw_mode(metadata.st_mode) != FileType::RegularFile
            || metadata.st_uid != geteuid().as_raw()
            || Mode::from_raw_mode(metadata.st_mode).intersects(Mode::WGRP | Mode::WOTH)
        {
            return None;
        }
        let mut bytes = Vec::new();
        let count = File::from(fd)
            .take(MAX_DESCRIPTOR + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        if u64::try_from(count).ok()? > MAX_DESCRIPTOR {
            return None;
        }
        let descriptor: Descriptor = serde_json::from_slice(&bytes).ok()?;
        let origin = Url::parse(&descriptor.origin).ok()?;
        let started = OffsetDateTime::parse(&descriptor.started_at, &Rfc3339).ok()?;
        if descriptor.pid == 0 || origin != *endpoint || started > OffsetDateTime::now_utc() {
            return None;
        }
        Some(Self {
            pid: descriptor.pid,
            started,
        })
    }

    pub(crate) async fn owns_connection(&self, local: SocketAddr, peer: SocketAddr) -> bool {
        let Ok((output, _)) = capture(
            "/usr/sbin/lsof",
            &[
                "-a",
                "-p",
                &self.pid.to_string(),
                "-iTCP",
                "-sTCP:ESTABLISHED",
                "-n",
                "-P",
                "-Fn",
            ],
            None,
        )
        .await
        else {
            return false;
        };
        let reverse = format!("n{peer}->{local}");
        output
            .split(|&byte| byte == b'\n')
            .any(|line| line == reverse.as_bytes())
            && self.still_current(None).await
    }

    pub(crate) async fn still_current(&self, scratch: Option<&Path>) -> bool {
        let Ok((output, _)) = capture(
            "/bin/ps",
            &["-p", &self.pid.to_string(), "-o", "lstart="],
            scratch,
        )
        .await
        else {
            return false;
        };
        self.predates_descriptor(&output)
    }

    fn predates_descriptor(&self, output: &[u8]) -> bool {
        let Ok(output) = std::str::from_utf8(output) else {
            return false;
        };
        let fields: Vec<_> = output.split_ascii_whitespace().collect();
        let [weekday, month, day, clock, year] = fields.as_slice() else {
            return false;
        };
        let started = format!("{weekday}, {day} {month} {year} {clock} +0000");
        // ps reports whole seconds. A tie cannot rule out a recycled PID.
        OffsetDateTime::parse(&started, &Rfc2822)
            .is_ok_and(|time| time.unix_timestamp() < self.started.unix_timestamp())
    }
}

pub(crate) async fn read_candidates(
    parents: HashMap<u32, u32>,
    scratch: &Path,
) -> HashMap<u32, RuntimeProcess> {
    if parents.is_empty() {
        return HashMap::new();
    }
    let pids = parents
        .keys()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let Ok((output, _)) = capture(
        "/bin/ps",
        &[
            "-E",
            "-ww",
            "-p",
            &pids,
            "-o",
            "pid=,ppid=,uid=,stat=,command=",
        ],
        Some(scratch),
    )
    .await
    else {
        return HashMap::new();
    };
    output
        .split(|&byte| byte == b'\n')
        .filter_map(|line| candidate(line, &parents))
        .collect()
}

fn candidate(line: &[u8], parents: &HashMap<u32, u32>) -> Option<(u32, RuntimeProcess)> {
    let line = std::str::from_utf8(line).ok()?.trim_start();
    let (pid, tail) = line.split_once(char::is_whitespace)?;
    let (parent, tail) = tail.trim_start().split_once(char::is_whitespace)?;
    let (user, tail) = tail.trim_start().split_once(char::is_whitespace)?;
    let (state, command) = tail.trim_start().split_once(char::is_whitespace)?;
    let pid = pid.parse::<u32>().ok()?;
    let parent = parent.parse::<u32>().ok()?;
    if parents.get(&pid) != Some(&parent)
        || user.parse::<u32>().ok()? != geteuid().as_raw()
        || state.starts_with('Z')
    {
        return None;
    }
    Some((pid, RuntimeProcess::from_command(parent, command)?))
}

/// The identification rule for a host provider app-server, T3's `codex app-server`:
/// the executable file is named `codex` and its first argument is `app-server`.
/// The caller must also prove it is a direct child of the verified T3 server.
pub(crate) fn is_provider_app_server(executable: &str, arguments: &str) -> bool {
    Path::new(executable)
        .file_name()
        .is_some_and(|name| name == "codex")
        && arguments
            .strip_prefix(executable)
            .and_then(|rest| rest.strip_prefix(' '))
            .and_then(|rest| rest.split_ascii_whitespace().next())
            == Some("app-server")
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum RuntimeShape {
    AppServer,
    Helper,
}

pub(crate) struct RuntimeProcess {
    pub parent: u32,
    pub shape: RuntimeShape,
    pub thread: Option<String>,
}

/// Find the connected provider's standing processes. Only the server's
/// direct app-server children and their own direct helpers qualify.
pub(crate) fn standing_runtime_pids(
    server: u32,
    processes: &HashMap<u32, RuntimeProcess>,
    thread: &str,
) -> HashSet<u32> {
    let matches_thread = |process: &RuntimeProcess| {
        process
            .thread
            .as_deref()
            .is_none_or(|binding| binding == thread)
    };
    let providers: HashSet<_> = processes
        .iter()
        .filter(|(_, process)| {
            process.parent == server
                && process.shape == RuntimeShape::AppServer
                && matches_thread(process)
        })
        .map(|(&pid, _)| pid)
        .collect();
    let helpers = processes.iter().filter_map(|(&pid, process)| {
        (providers.contains(&process.parent)
            && process.shape == RuntimeShape::Helper
            && matches_thread(process))
        .then_some(pid)
    });
    providers.iter().copied().chain(helpers).collect()
}

impl RuntimeProcess {
    pub(crate) fn from_command(parent: u32, command: &str) -> Option<Self> {
        let mut words = command.split_ascii_whitespace();
        let program = words.next()?;
        let base = Path::new(program).file_name()?.to_str()?;
        if program.starts_with('(')
            || matches!(
                base,
                "sh" | "bash" | "zsh" | "dash" | "ksh" | "fish" | "csh" | "tcsh"
            )
        {
            return None;
        }
        let mode = words.clone().next();
        let shape = if mode == Some("app-server") {
            RuntimeShape::AppServer
        } else if Path::new(program).is_absolute()
            && (matches!(mode, Some("mcp" | "mcp-server" | "mcp_server"))
                || base.ends_with("_repl")
                || base.ends_with("-host"))
        {
            RuntimeShape::Helper
        } else {
            return None;
        };
        let mut thread = None;
        for word in words {
            if let Some(id) = word.strip_prefix("T3CODE_THREAD_ID=") {
                if id.is_empty() || thread.replace(id.to_owned()).is_some() {
                    return None;
                }
            } else if [
                "NUCLEUS_ACP_SESSION=",
                "NUCLEUS_TICKET=",
                "NUCLEUS_CONTINUATION_TICKET=",
            ]
            .iter()
            .any(|key| word.starts_with(key))
            {
                return None;
            }
        }
        Some(Self {
            parent,
            shape,
            thread,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_connected_servers_direct_runtime_chain_is_exempt() {
        let processes = [
            (20, 10, "codex app-server"),
            (
                21,
                20,
                "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl",
            ),
            (22, 20, "/plugins/node_repl"),
            (
                23,
                20,
                "/plugins/cua-driver mcp T3CODE_THREAD_ID=fixture-thread",
            ),
            (24, 21, "/bin/sh -c work"),
            (25, 22, "/plugins/node_repl mcp"),
            (
                26,
                20,
                "/plugins/cua-driver mcp T3CODE_THREAD_ID=other-thread",
            ),
            (27, 20, "(node_repl)"),
            (28, 20, "/bin/zsh mcp"),
            (30, 11, "/other/codex app-server"),
            (31, 30, "/other/node_repl"),
            (
                32,
                21,
                "/opt/bin/node /scratch/kernel.js --session-id=fixture",
            ),
        ]
        .into_iter()
        .filter_map(|(pid, parent, command)| {
            RuntimeProcess::from_command(parent, command).map(|process| (pid, process))
        })
        .collect();
        assert_eq!(
            standing_runtime_pids(10, &processes, "fixture-thread"),
            HashSet::from([20, 21, 22, 23])
        );
    }

    #[test]
    fn only_a_codex_app_server_is_a_provider_app_server() {
        assert!(is_provider_app_server(
            "codex",
            "codex app-server -c thread_unload_delay_secs=0"
        ));
        assert!(is_provider_app_server(
            "/opt/My Tools/codex",
            "/opt/My Tools/codex app-server"
        ));
        for (executable, arguments) in [
            ("codex", "codex exec app-server"),
            ("codex", "codex app-server-proxy"),
            ("node", "node app-server"),
            ("codex-code-mode-host", "codex-code-mode-host app-server"),
        ] {
            assert!(!is_provider_app_server(executable, arguments));
        }
    }

    #[test]
    fn a_recycled_server_pid_cannot_validate_the_descriptor() {
        let server = ServerRuntime {
            pid: 10,
            started: OffsetDateTime::parse("2025-11-24T12:50:51.153Z", &Rfc3339)
                .expect("descriptor time"),
        };
        assert!(server.predates_descriptor(b"Mon Nov 24 12:50:45 2025\n"));
        assert!(!server.predates_descriptor(b"Mon Nov 24 12:50:51 2025\n"));
        assert!(!server.predates_descriptor(b"Mon Nov 24 12:51:00 2025\n"));
        assert!(!server.predates_descriptor(b"unreadable"));
    }
}
