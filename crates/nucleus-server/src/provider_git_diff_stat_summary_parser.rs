//! Sanitized parser for `git diff --stat --no-ext-diff` output.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitDiffStatSummaryRecord {
    pub summary_id: String,
    pub status: GitDiffStatSummaryStatus,
    pub changed_path_count: usize,
    pub insertion_count: usize,
    pub deletion_count: usize,
    pub raw_path_retained: bool,
    pub raw_diff_retained: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitDiffStatSummaryStatus {
    Completed,
    Empty,
    RepairRequired,
}

pub fn git_diff_stat_summary_parser(output: &str) -> GitDiffStatSummaryRecord {
    let mut record = GitDiffStatSummaryRecord {
        summary_id: "git-diff-stat-summary".to_owned(),
        status: GitDiffStatSummaryStatus::Empty,
        changed_path_count: 0,
        insertion_count: 0,
        deletion_count: 0,
        raw_path_retained: false,
        raw_diff_retained: false,
        raw_output_retained: false,
    };

    let Some(total_line) = output
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
    else {
        return record;
    };

    if !total_line.contains(" changed") {
        record.status = GitDiffStatSummaryStatus::RepairRequired;
        return record;
    }

    for part in total_line.split(',').map(str::trim) {
        if part.contains("file") && part.contains("changed") {
            record.changed_path_count = leading_number(part).unwrap_or(0);
        } else if part.contains("insertion") {
            record.insertion_count = leading_number(part).unwrap_or(0);
        } else if part.contains("deletion") {
            record.deletion_count = leading_number(part).unwrap_or(0);
        }
    }

    if record.changed_path_count == 0 {
        record.status = GitDiffStatSummaryStatus::RepairRequired;
    } else {
        record.status = GitDiffStatSummaryStatus::Completed;
    }
    record
}

fn leading_number(part: &str) -> Option<usize> {
    part.split_whitespace().next()?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_diff_stat_summary_parser_extracts_totals() {
        let record = git_diff_stat_summary_parser(
            " src/lib.rs | 4 +++-\n 1 file changed, 3 insertions(+), 1 deletion(-)\n",
        );

        assert_eq!(record.status, GitDiffStatSummaryStatus::Completed);
        assert_eq!(record.changed_path_count, 1);
        assert_eq!(record.insertion_count, 3);
        assert_eq!(record.deletion_count, 1);
        assert!(!record.raw_path_retained);
        assert!(!record.raw_diff_retained);
    }

    #[test]
    fn git_diff_stat_summary_parser_handles_empty_output() {
        let record = git_diff_stat_summary_parser("");

        assert_eq!(record.status, GitDiffStatSummaryStatus::Empty);
        assert_eq!(record.changed_path_count, 0);
        assert!(!record.raw_output_retained);
    }

    #[test]
    fn git_diff_stat_summary_parser_rejects_malformed_output_without_paths() {
        let record = git_diff_stat_summary_parser("not a stat summary");

        assert_eq!(record.status, GitDiffStatSummaryStatus::RepairRequired);
        assert_eq!(record.changed_path_count, 0);
        assert!(!record.raw_path_retained);
    }
}
