//! Sanitized parser for `git status --porcelain=v1 -z` output.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitStatusSummaryRecord {
    pub summary_id: String,
    pub status: GitStatusSummaryStatus,
    pub changed_path_count: usize,
    pub staged_path_count: usize,
    pub unstaged_path_count: usize,
    pub untracked_path_count: usize,
    pub malformed_entry_count: usize,
    pub raw_path_retained: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitStatusSummaryStatus {
    Completed,
    RepairRequired,
}

pub fn git_status_summary_parser(output: &[u8]) -> GitStatusSummaryRecord {
    let mut changed_path_count = 0;
    let mut staged_path_count = 0;
    let mut unstaged_path_count = 0;
    let mut untracked_path_count = 0;
    let mut malformed_entry_count = 0;

    for entry in output
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
    {
        if entry.len() < 4 {
            malformed_entry_count += 1;
            continue;
        }
        let x = entry[0];
        let y = entry[1];
        if entry[2] != b' ' {
            malformed_entry_count += 1;
            continue;
        }
        changed_path_count += 1;
        if x == b'?' && y == b'?' {
            untracked_path_count += 1;
            continue;
        }
        if x != b' ' {
            staged_path_count += 1;
        }
        if y != b' ' {
            unstaged_path_count += 1;
        }
    }

    GitStatusSummaryRecord {
        summary_id: "git-status-summary".to_owned(),
        status: if malformed_entry_count == 0 {
            GitStatusSummaryStatus::Completed
        } else {
            GitStatusSummaryStatus::RepairRequired
        },
        changed_path_count,
        staged_path_count,
        unstaged_path_count,
        untracked_path_count,
        malformed_entry_count,
        raw_path_retained: false,
        raw_output_retained: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_status_summary_parser_counts_porcelain_entries() {
        let record = git_status_summary_parser(b"M  src/lib.rs\0 M README.md\0?? new.txt\0");

        assert_eq!(record.status, GitStatusSummaryStatus::Completed);
        assert_eq!(record.changed_path_count, 3);
        assert_eq!(record.staged_path_count, 1);
        assert_eq!(record.unstaged_path_count, 1);
        assert_eq!(record.untracked_path_count, 1);
        assert!(!record.raw_path_retained);
        assert!(!record.raw_output_retained);
    }

    #[test]
    fn git_status_summary_parser_handles_empty_output() {
        let record = git_status_summary_parser(b"");

        assert_eq!(record.status, GitStatusSummaryStatus::Completed);
        assert_eq!(record.changed_path_count, 0);
        assert!(!record.raw_path_retained);
    }

    #[test]
    fn git_status_summary_parser_rejects_malformed_entries_without_paths() {
        let record = git_status_summary_parser(b"M malformed\0x\0");

        assert_eq!(record.status, GitStatusSummaryStatus::RepairRequired);
        assert_eq!(record.changed_path_count, 0);
        assert_eq!(record.malformed_entry_count, 2);
        assert!(!record.raw_path_retained);
    }
}
