use std::{
    collections::BTreeMap,
    fmt::Write as _,
    fs,
    path::{Path, PathBuf},
};

use nucleus_core::{Brief, Head, Launch, PullRequest, ReportTask, Review, Role, Verdict};
use nucleus_store::{TaskRow, planning::Lane};
use serde::Serialize;

use crate::DependencyStatus;

const SKILL: &str = include_str!("../../../../skills/nucleus/SKILL.md");
const REPORTING: &str = "Reporting and contact";

#[derive(Default)]
pub(super) struct LaneContext {
    pub(super) memberships: Vec<(String, String)>,
    pub(super) pins: Vec<Lane>,
    pub(super) missing: Vec<String>,
}

#[derive(Serialize)]
pub(super) struct PromptSize {
    pub(super) total: usize,
    sections: BTreeMap<&'static str, usize>,
}

pub(super) struct Assignment {
    pub(super) text: String,
    pub(super) size: PromptSize,
}

impl Assignment {
    pub(super) fn too_large(&self) -> Option<serde_json::Value> {
        let expanded = nucleus_hosts::assignment_units(&self.text);
        let limit = nucleus_hosts::T3_ASSIGNMENT_LIMIT;
        if expanded <= limit {
            return None;
        }
        let mut largest: Vec<_> = self.size.sections.iter().collect();
        largest.sort_unstable_by_key(|(_, units)| std::cmp::Reverse(**units));
        let largest: Vec<_> = largest
            .into_iter()
            .take(3)
            .map(|(section, units)| serde_json::json!({"section":section,"characters":units}))
            .collect();
        Some(serde_json::json!({
            "cause":"assignment_too_large", "characters":expanded,"limit":limit,"largest":largest
        }))
    }
}

pub(super) fn lane_document_path(key: &str) -> PathBuf {
    let mut file = String::new();
    for byte in key.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            file.push(char::from(byte));
        } else {
            let _ = write!(file, "%{byte:02X}");
        }
    }
    file.push_str(".md");
    Path::new("lane-documents").join(file)
}

fn section(
    sections: &mut BTreeMap<&'static str, usize>,
    name: &'static str,
    text: &mut String,
    write: impl FnOnce(&mut String),
) {
    let before = text.len();
    write(text);
    if text.len() > before {
        sections.insert(name, text[before..].encode_utf16().count());
    }
}

pub(super) struct Prompt<'a> {
    pub(super) row: &'a TaskRow,
    pub(super) role: Role,
    pub(super) via: &'a Launch,
    pub(super) replaced_thread: Option<&'a str>,
    pub(super) instance: &'a str,
    pub(super) checkout: &'a Path,
    pub(super) scratch: &'a Path,
    pub(super) branch: &'a str,
    pub(super) checkout_head: Option<&'a Head>,
    pub(super) pr: Option<&'a PullRequest>,
    pub(super) discovered_skill: Option<&'a Path>,
    pub(super) model: &'a str,
    pub(super) lanes: &'a LaneContext,
    pub(super) dependencies: &'a DependencyStatus,
    pub(super) command: &'a Path,
    pub(super) ticket: &'a Path,
}

impl Prompt<'_> {
    pub(super) fn render(&self) -> Assignment {
        let role = match self.role {
            Role::Worker => "Worker",
            Role::Reviewer => "Reviewer",
        };
        let mut text = self.identity(role);
        let mut sections = BTreeMap::from([("identity", text.encode_utf16().count())]);
        let task = &self.row.task;
        section(&mut sections, "history", &mut text, |text| {
            self.write_history(text);
        });
        section(&mut sections, "lane", &mut text, |text| {
            self.write_lane_context(text);
        });
        section(&mut sections, "laneDocuments", &mut text, |text| {
            self.write_lane_documents(text);
        });
        section(&mut sections, "brief", &mut text, |text| {
            Self::write_brief(text, task.brief());
        });
        section(&mut sections, "standingRules", &mut text, |text| {
            text.push_str("\nKeep the Nucleus-held brief unchanged. Stay on the assigned branch. Never push to another branch or repository. Report only through this run's binding.\n");
        });
        section(&mut sections, "report", &mut text, |text| {
            self.write_report(text, task.report_task());
        });
        section(&mut sections, "roleInstructions", &mut text, |text| {
            self.write_skill(text, role);
        });
        let size = PromptSize {
            total: sections.values().sum(),
            sections,
        };
        Assignment { text, size }
    }

    fn identity(&self, section: &str) -> String {
        let task = &self.row.task;
        let identity = task.identity();
        let reference = self.row.reference();
        let title = crate::titles::brief_title(task);
        let report_only = task.report_task();
        let assignment = match (&self.role, self.pr, self.replaced_thread, self.via) {
            (Role::Reviewer, ..) => "Independent review",
            (Role::Worker, ..) if report_only.is_some() => "Report-only delivery",
            (Role::Worker, Some(_), ..) => "Continue work in the existing checkout and PR",
            (Role::Worker, None, Some(_), _) => "Replacement worker in the existing checkout",
            (Role::Worker, None, _, Launch::Continue { .. }) => {
                "Continue work in the existing checkout"
            }
            (Role::Worker, ..) => "Implementation",
        };
        let mut text = format!(
            "Nucleus {section} assignment\n\n{reference}: {title}\n             Assignment: {assignment}\nTask ID: {}\nRun ID: {}\nRepository: {}\n             Checkout: {}\nBranch: {}\nBase: {}\nRun scratch: {}\n",
            identity.id,
            self.instance,
            identity.repository,
            self.checkout.display(),
            self.branch,
            identity.base,
            self.scratch.display(),
        );
        if let Some(head) = self.checkout_head {
            let _ = writeln!(text, "Checkout head: {head}");
        }
        if let Some(pr) = self.pr {
            let _ = writeln!(text, "PR: {}\nPR head: {}", pr.url, pr.head);
        }
        if let Some(thread) = self.replaced_thread {
            let _ = writeln!(text, "Replaced worker thread: {thread}");
        }
        if self.role == Role::Worker
            && report_only.is_none()
            && let Some(number) = self.row.number
        {
            let _ = writeln!(text, "PR title: {number:03}: {title}");
        }
        text
    }

    fn write_history(&self, text: &mut String) {
        let task = &self.row.task;
        if self.role == Role::Worker
            && let Some(Verdict::Reviewed {
                head,
                decision,
                summary,
            }) = task.verdict()
        {
            let decision = match decision {
                Review::Approve => "approve",
                Review::Changes => "changes",
            };
            let _ = writeln!(
                text,
                "Recorded review at {head} ({decision})\n----- BEGIN REVIEW -----\n{summary}\n----- END REVIEW -----"
            );
        }
        if self.role == Role::Reviewer {
            let worker = task.threads();
            let author = worker.profile(Role::Worker);
            let _ = writeln!(
                text,
                "Reviewer model: {}\nPrior worker thread: {}\nPrior worker model: {}",
                self.model,
                worker.get(Role::Worker).unwrap_or("not recorded"),
                author.map_or("not recorded", |profile| profile.model.as_str()),
            );
        }
        if let Some(report) = task.report_task() {
            let _ = writeln!(text, "Planning commit: {}", report.planning_base);
            if let Some(instruction) = &report.instruction {
                let _ = writeln!(
                    text,
                    "\nBound planner instruction\n----- BEGIN INSTRUCTION -----\n{instruction}\n----- END INSTRUCTION -----"
                );
            }
        }
        self.write_dependencies(text);
    }

    fn write_lane_context(&self, text: &mut String) {
        for (title, aim) in &self.lanes.memberships {
            let _ = writeln!(text, "Lane context — not scope authority: {title}\n{aim}");
        }
    }

    fn write_lane_documents(&self, text: &mut String) {
        if !self.lanes.pins.is_empty() {
            text.push_str("Read-only lane document copies for this run:\n");
        }
        for pin in &self.lanes.pins {
            let path = self.scratch.join(lane_document_path(&pin.key));
            let _ = writeln!(text, "- {}: {}", pin.key, path.display());
        }
        if !self.lanes.missing.is_empty() {
            let _ = writeln!(
                text,
                "Lane document references not found in the current plan: {}",
                self.lanes.missing.join(", ")
            );
        }
        for pin in &self.lanes.pins {
            let artifact = pin.artifact();
            let _ = writeln!(
                text,
                "Lane document — context, not scope authority: {key} version {version}, {digest}\n----- BEGIN LANE DOCUMENT {key} -----\n{body}\n----- END LANE DOCUMENT {key} -----",
                key = artifact.key,
                version = artifact.version,
                digest = artifact.digest,
                body = pin.document.document,
            );
        }
    }

    fn write_skill(&self, text: &mut String, section: &str) {
        if let Some(path) = self
            .discovered_skill
            .filter(|path| has_installed_protocol(path, section))
        {
            let _ = writeln!(
                text,
                "\nFollow the {section} and {REPORTING} sections of the Nucleus skill at {}.",
                path.display(),
            );
        } else {
            let _ = writeln!(
                text,
                "\nFollow these {section} and {REPORTING} sections of the Nucleus skill.\n"
            );
            let shared = skill_section(SKILL, REPORTING).expect("shipped reporting protocol");
            let role = skill_section(SKILL, section).expect("shipped role protocol");
            let _ = writeln!(text, "{}\n\n{}", shared.trim_end(), role.trim_end());
        }
    }

    fn write_dependencies(&self, text: &mut String) {
        if self.dependencies.dependencies.is_empty() {
            return;
        }
        let _ = writeln!(text, "\nRecorded prerequisites");
        for fact in &self.dependencies.dependencies {
            let _ = writeln!(text, "- {} ({})", fact.reference, fact.task_id);
        }
    }

    fn write_brief(text: &mut String, brief: &Brief) {
        let _ = writeln!(text, "\nNucleus-held brief, version {}", brief.version);
        let _ = write!(text, "Digest: ");
        for byte in brief.digest {
            let _ = write!(text, "{byte:02x}");
        }
        let _ = writeln!(
            text,
            "\n----- BEGIN NUCLEUS-HELD BRIEF -----\n{}\n----- END NUCLEUS-HELD BRIEF -----",
            brief.text
        );
    }

    fn write_report(&self, text: &mut String, report_only: Option<&ReportTask>) {
        let command = self.bound_command("report");
        let _ = writeln!(
            text,
            "\nSend actual JSON on stdin to `{command}`. Exit status zero means accepted."
        );
        if let Some(report) = report_only {
            self.write_report_only(text, report);
            return;
        }
        match self.role {
            Role::Worker => {
                let example = serde_json::json!({"work": {
                    "url": self.pr.map_or("https://github.com/OWNER/REPO/pull/NUMBER", |pr| &pr.url),
                    "head": "FULL_SHA",
                    "summary": "ONE_SENTENCE_DESCRIBING_THE_CHANGE",
                }});
                let _ = writeln!(text, "Ready for review: {example}");
            }
            Role::Reviewer => {
                // The launcher already requires an observed open PR for a review.
                let head = self.pr.map_or("FULL_SHA", |pr| pr.head.as_str());
                for (label, decision) in [
                    ("Approve", Review::Approve),
                    ("Request changes", Review::Changes),
                ] {
                    let example = serde_json::json!({"review": {
                        "head": head, "decision": decision, "summary": "FULL_FINDINGS",
                        "finding_titles": if decision == Review::Changes { vec!["SHORT_TITLE_FOR_EACH_FINDING"] } else { vec![] },
                    }});
                    let _ = writeln!(text, "{label}: {example}");
                }
            }
        }
        text.push_str(
            "Planner question: {\"question\":{\"prompt\":\"CONTEXT AND RECOMMENDATION\",             \"options\":[\"FIRST CHOICE AND CONSEQUENCE\",\"SECOND CHOICE AND CONSEQUENCE\"]}}\n",
        );
    }

    fn write_report_only(&self, text: &mut String, report: &ReportTask) {
        let project = shell_quote(&report.project);
        let lane = shell_quote(&report.lane);
        let read = self.bound_command(&format!("lane.get {project} {lane}"));
        let write = self.bound_command(&format!("lane.put {project} {lane} VERSION"));
        let example = serde_json::json!({"report_ready": {
            "artifact": {"key": report.lane, "version": 1, "digest": "DIGEST"},
            "headline": "HEADLINE",
            "summary": "SUMMARY",
            "head": "FULL_SHA",
        }});
        let _ = writeln!(
            text,
            "Read the delivery lane with `{read}`. Feed updated Markdown on stdin to `{write}`, +             using the version you last read.\n+             Report ready: {example} (replace the example version with the returned version)."
        );
        text.push_str(
            "Blocked: {\"blocked\":{\"summary\":\"REASON\"}}\n+             Error: {\"error\":{\"summary\":\"REASON\"}}\n",
        );
    }

    fn bound_command(&self, verb: &str) -> String {
        format!(
            "{} {verb} --ticket {}",
            shell_path(self.command),
            shell_path(self.ticket)
        )
    }
}

fn shell_path(path: &Path) -> String {
    shell_quote(&path.to_string_lossy())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn skill_section<'a>(skill: &'a str, section: &str) -> Option<&'a str> {
    let (_, protocol) = skill.split_once("\n## Run protocol\n")?;
    let protocol = protocol
        .split_once("\n## ")
        .map_or(protocol, |(body, _)| body);
    let heading = format!("\n### {section}\n");
    let (before, body) = protocol.split_once(&heading)?;
    let start = before.len() + 1;
    let end = body
        .find("\n### ")
        .map_or(protocol.len(), |end| before.len() + heading.len() + end);
    protocol.get(start..end)
}

fn has_installed_protocol(path: &Path, section: &str) -> bool {
    // The installer link can still resolve to a release predating this protocol.
    fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.len() <= 1_000_000)
        && fs::read_to_string(path).is_ok_and(|installed| matches_protocol(&installed, section))
}

fn matches_protocol(installed: &str, section: &str) -> bool {
    [REPORTING, section].into_iter().all(|name| {
        skill_section(SKILL, name).is_some_and(|text| {
            skill_section(installed, name).is_some_and(|installed| installed.trim() == text.trim())
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_core::{Entry, Identity, Report, Task};

    const HEAD: &str = "1111111111111111111111111111111111111111";
    const PR: &str = "https://github.com/fixture/repository/pull/17";

    fn fixture() -> TaskRow {
        TaskRow {
            task: Task::new(
                Identity {
                    id: "test".into(),
                    reference: "test".into(),
                    repository: "fixture/repository".into(),
                    base: "trunk".into(),
                    entry: Entry::Brief,
                    origin_thread: None,
                },
                "# Repair delivery worker\n\nDeliver the exact result.".into(),
                None,
            ),
            version: 1,
            number: Some(42),
        }
    }

    static EMPTY_DEPENDENCIES: DependencyStatus = DependencyStatus {
        dependencies: Vec::new(),
        prerequisite_wait: None,
        blocking: false,
    };
    static EMPTY_LANES: LaneContext = LaneContext {
        memberships: Vec::new(),
        pins: Vec::new(),
        missing: Vec::new(),
    };

    fn assignment(row: &TaskRow, role: Role) -> Prompt<'_> {
        Prompt {
            row,
            role,
            via: &Launch::Create,
            replaced_thread: None,
            instance: "task-test-run-1",
            checkout: Path::new("/work/task-test"),
            scratch: Path::new("/scratch/task-test-run-1"),
            branch: "ns-test",
            checkout_head: None,
            pr: None,
            discovered_skill: None,
            model: "fixture",
            lanes: &EMPTY_LANES,
            dependencies: &EMPTY_DEPENDENCIES,
            command: Path::new("/bin/nucleus engine"),
            ticket: Path::new("/scratch/a quote's ticket"),
        }
    }

    fn example(prompt: &str, prefix: &str) -> String {
        let line = prompt
            .lines()
            .find_map(|line| line.strip_prefix(prefix))
            .expect("result example");
        line.split_once(" (")
            .map_or(line, |(json, _)| json)
            .replace("FULL_SHA", HEAD)
            .replace("https://github.com/OWNER/REPO/pull/NUMBER", PR)
    }

    #[test]
    fn worker_has_bound_facts_and_only_the_worker_policy() {
        let row = fixture();
        let text = assignment(&row, Role::Worker).render().text;
        for fact in [
            "repository#42",
            "Run ID: task-test-run-1",
            "Branch: ns-test",
            "Base: trunk",
            "Run scratch: /scratch/task-test-run-1",
            "PR title: 042: Repair delivery worker",
            "Deliver the exact result.",
            "'/bin/nucleus engine' report --ticket '/scratch/a quote'\\''s ticket'",
            "### Worker",
            "### Reporting and contact",
        ] {
            assert!(text.contains(fact), "missing {fact}");
        }
        assert!(!text.contains("### Reviewer"));
        assert!(!text.contains("effigy test:affected"));
        assert!(!text.contains("changelog.d/"));
        assert!(matches!(
            serde_json::from_str::<Report>(&example(&text, "Ready for review: ")).unwrap(),
            Report::Work(_),
        ));
        assert!(matches!(
            serde_json::from_str::<Report>(&example(&text, "Planner question: ")).unwrap(),
            Report::Question { .. },
        ));
    }

    #[test]
    fn reviewer_gets_the_pinned_public_pr_and_independent_policy() {
        let row = fixture();
        let pr = PullRequest {
            url: PR.into(),
            head: HEAD.parse().unwrap(),
        };
        let text = Prompt {
            pr: Some(&pr),
            ..assignment(&row, Role::Reviewer)
        }
        .render()
        .text;
        assert!(text.contains(&format!("PR: {PR}\nPR head: {HEAD}")));
        assert!(text.contains("Never read the\nworker's private transcript."));
        assert!(!text.contains("### Worker"));
        assert!(!text.contains("Ready for review:"));
        for (label, expected) in [
            ("Approve: ", Review::Approve),
            ("Request changes: ", Review::Changes),
        ] {
            let payload = text
                .lines()
                .find_map(|line| line.strip_prefix(label))
                .expect("rendered review example");
            assert!(matches!(
                serde_json::from_str::<Report>(payload).unwrap(),
                Report::Review { head, decision, .. } if head == pr.head && decision == expected,
            ));
        }
    }

    #[test]
    fn newer_renderer_inlines_on_missing_or_stale_discovery() {
        let row = fixture();
        let folder = tempfile::tempdir().unwrap();
        let skill = folder.path().join("SKILL.md");
        let prompt = Prompt {
            discovered_skill: Some(&skill),
            ..assignment(&row, Role::Worker)
        };
        assert!(prompt.render().text.contains("### Worker"));
        // Alter a line in the exact shared policy, not unrelated legacy text.
        fs::write(
            &skill,
            SKILL.replace("Require acceptance", "Acceptance is optional"),
        )
        .unwrap();
        assert!(prompt.render().text.contains("### Worker"));
        fs::write(&skill, SKILL).unwrap();
        let text = prompt.render().text;
        assert!(text.contains("sections of the Nucleus skill at"));
        assert!(!text.contains("### Worker"));
        assert!(!text.contains("### Reporting and contact"));
    }

    #[test]
    fn a_large_level_up_lane_is_context_only_until_the_brief_pins_it() {
        let row = fixture();
        let lane = Lane {
            key: "level-up".into(),
            version: 8,
            document: nucleus_store::planning::LaneDocument {
                title: "Level-up".into(),
                aim: "Run a focused quality pass.".into(),
                document: "## Round re-read\nFull evaluation and receipts.\n".repeat(3_500),
            },
            disposition: nucleus_store::planning::LaneDisposition::default(),
        };
        let mut lanes = LaneContext {
            memberships: vec![(lane.document.title.clone(), lane.document.aim.clone())],
            ..LaneContext::default()
        };
        let render = |lanes: &LaneContext| {
            Prompt {
                lanes,
                ..assignment(&row, Role::Worker)
            }
            .render()
        };
        let small = render(&lanes);
        assert!(
            small.text.contains(
                "Lane context — not scope authority: Level-up\nRun a focused quality pass."
            )
        );
        assert!(!small.text.contains("Full evaluation and receipts."));
        assert!(small.too_large().is_none());
        assert_eq!(small.size.total, small.text.encode_utf16().count());
        assert!(small.size.total < 10_000);
        lanes.pins.push(lane);
        let large = render(&lanes);
        assert!(
            large
                .text
                .contains("/scratch/task-test-run-1/lane-documents/level-up.md")
        );
        let cause = large.too_large().expect("oversize assignment is refused");
        assert_eq!(cause["largest"][0]["section"], "laneDocuments");
    }
}
