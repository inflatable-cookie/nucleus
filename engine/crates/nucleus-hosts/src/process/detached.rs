//! Alternate retirement evidence for a live Darwin process with no cwd vnode path.

use std::{collections::HashMap, path::PathBuf};

use libproc::{
    bsd_info::BSDInfo,
    proc_pid::{PIDInfo, PidInfoFlavor, pidinfo},
};
use tokio::{task::JoinSet, time};

use super::{DEADLINE, decode_lsof_path};

pub(super) const MISSING_DIRECTORY: &[u8] = b"ncwd|rtd info error: No such file or directory";

// Darwin's sys/proc.h, sys/acct.h and sys/proc_info.h, respectively.
const P_TRACED_EXEC_OR_THCWD: u32 = 0x0100_4800;
const FORKED_WITHOUT_EXEC: u32 = 0x01;
const USED_SUPERUSER: u32 = 0x02;
const PROC_TRACED_EXEC_OR_THCWD: u32 = 0x4102;
const PROC_INEXIT: u32 = 0x04;

pub(super) fn inherits_root(flags: Option<&str>, accounting: Option<&str>) -> bool {
    let hex = |field| u32::from_str_radix(field, 16).ok();
    flags
        .and_then(hex)
        .is_some_and(|flags| flags & P_TRACED_EXEC_OR_THCWD == 0)
        && accounting.and_then(hex).is_some_and(|flags| {
            flags & (FORKED_WITHOUT_EXEC | USED_SUPERUSER) == FORKED_WITHOUT_EXEC
        })
}

pub(super) struct Ancestry {
    pub pid: u32,
    pub started: i64,
    pub parent: u32,
    pub parent_started: i64,
}

#[repr(transparent)]
struct Directories(libc::proc_vnodepathinfo);

impl PIDInfo for Directories {
    fn flavor() -> PidInfoFlavor {
        PidInfoFlavor::VNodePathInfo
    }
}

pub(super) async fn default_root_children(candidates: Vec<Ancestry>) -> Vec<u32> {
    let mut reads = JoinSet::new();
    for lineage in candidates {
        reads.spawn_blocking(move || default_root_child(&lineage).then_some(lineage.pid));
    }
    let deadline = time::Instant::now() + DEADLINE;
    let mut proved = Vec::new();
    while let Ok(Some(result)) = time::timeout_at(deadline, reads.join_next()).await {
        if let Ok(Some(pid)) = result {
            proved.push(pid);
        }
    }
    proved
}

fn default_root_child(lineage: &Ancestry) -> bool {
    let birth = |pid, started| {
        let info = pidinfo::<BSDInfo>(i32::try_from(pid).ok()?, 0).ok()?;
        (info.pbi_uid == rustix::process::geteuid().as_raw()
            && info.pbi_flags & PROC_INEXIT == 0
            && i64::try_from(info.pbi_start_tvsec).ok()? == started)
            .then_some(info)
    };
    let Some(parent) = birth(lineage.parent, lineage.parent_started) else {
        return false;
    };
    let Ok(parent_pid) = i32::try_from(lineage.parent) else {
        return false;
    };
    // The kernel leaves this slot zero for the default root. chroot cannot
    // restore that empty slot. The child inherited it and has not called chroot.
    pidinfo::<Directories>(parent_pid, 0).is_ok_and(|dirs| dirs.0.pvi_rdir.vip_vi.vi_type == 0)
        && birth(lineage.parent, lineage.parent_started)
            .is_some_and(|current| current.pbi_start_tvusec == parent.pbi_start_tvusec)
        && birth(lineage.pid, lineage.started).is_some_and(|child| {
            child.pbi_ppid == lineage.parent
                && child.pbi_flags & PROC_TRACED_EXEC_OR_THCWD == 0
                && (parent.pbi_start_tvsec, parent.pbi_start_tvusec)
                    < (child.pbi_start_tvsec, child.pbi_start_tvusec)
        })
}

#[derive(Default)]
struct FileTable {
    missing_cwd: bool,
    executable: bool,
    incomplete: bool,
    paths: Vec<PathBuf>,
}

// This is a selected-PID listing with a successful exit. A missing file row
// or an unreadable filesystem reference cannot establish a disjoint scope.
pub(super) fn file_references(stdout: &[u8]) -> Option<HashMap<u32, Vec<PathBuf>>> {
    let mut tables = HashMap::<_, FileTable>::new();
    let mut pid = None;
    for record in stdout
        .split(|&byte| byte == b'\n')
        .filter(|row| !row.is_empty())
    {
        let mut fields = record.split(|&byte| byte == 0);
        let head = fields.next()?;
        if let Some(id) = head.strip_prefix(b"p") {
            pid = Some(std::str::from_utf8(id).ok()?.parse::<u32>().ok()?);
            continue;
        }
        let table = tables.entry(pid?).or_default();
        let file = head.strip_prefix(b"f")?;
        let mut kind = None;
        let mut name = None;
        for field in fields {
            match field {
                [b't', value @ ..] => kind = Some(value),
                [b'n', value @ ..] => name = Some(value),
                _ => {}
            }
        }
        if file == b"cwd" {
            table.missing_cwd = name == MISSING_DIRECTORY.strip_prefix(b"n");
            continue;
        }
        if let Some(path) = name
            .filter(|path| path.starts_with(b"/"))
            .and_then(decode_lsof_path)
        {
            table.paths.push(path);
            table.executable |= file == b"txt";
        } else if file == b"txt"
            || !matches!(
                kind,
                Some(b"PIPE" | b"KQUEUE" | b"unix" | b"IPv4" | b"IPv6" | b"NPOLICY")
            )
        {
            table.incomplete = true;
        }
        table.incomplete |= matches!(file, b"rtd" | b"twd" | b"err");
    }
    Some(
        tables
            .into_iter()
            .filter_map(|(pid, table)| {
                (table.missing_cwd && table.executable && !table.incomplete)
                    .then_some((pid, table.paths))
            })
            .collect(),
    )
}
