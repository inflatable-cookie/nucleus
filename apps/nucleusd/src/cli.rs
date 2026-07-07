use std::path::PathBuf;

mod command_runner;
mod provider_live_read_smoke_evidence;
mod query_domain;

pub(crate) use command_runner::{
    CliCodexTurnStartRealWriteSmoke, CliDurableLiveProviderWriteSmoke, CliDurableRuntimeSmoke,
    CliReadOnlyCommand, CommandRunnerCommand,
};
pub(crate) use provider_live_read_smoke_evidence::ProviderLiveReadSmokeEvidenceCommand;
pub(crate) use query_domain::QueryDomain;

#[derive(Debug, Default, Eq, PartialEq)]
pub(crate) struct CliConfig {
    pub(crate) state_path: Option<PathBuf>,
    pub(crate) bootstrap: bool,
    pub(crate) status: bool,
    pub(crate) help: bool,
    pub(crate) query: Option<QueryDomain>,
    pub(crate) command_runner: Option<CommandRunnerCommand>,
    pub(crate) provider_live_read_smoke_evidence: Option<ProviderLiveReadSmokeEvidenceCommand>,
}

impl CliConfig {
    pub(crate) fn parse(args: Vec<String>) -> Result<Self, String> {
        let mut config = Self::default();
        let mut iter = args.into_iter();

        while let Some(arg) = iter.next() {
            match arg.as_str() {
                "--state" => {
                    let path = iter
                        .next()
                        .ok_or_else(|| "--state requires a path".to_owned())?;
                    config.state_path = Some(PathBuf::from(path));
                }
                "--bootstrap" => config.bootstrap = true,
                "--status" => config.status = true,
                "--help" | "-h" => config.help = true,
                "query" => {
                    let domain = iter
                        .next()
                        .ok_or_else(|| "query requires a domain".to_owned())?;
                    config.query = Some(QueryDomain::parse_from_iter(&domain, &mut iter)?);
                }
                "command-runner" => {
                    let command = iter
                        .next()
                        .ok_or_else(|| "command-runner requires a command".to_owned())?;
                    config.command_runner =
                        Some(CommandRunnerCommand::parse_from_iter(command, &mut iter)?);
                }
                "provider-live-read-smoke-evidence" => {
                    let command = iter.next().ok_or_else(|| {
                        "provider-live-read-smoke-evidence requires a command".to_owned()
                    })?;
                    config.provider_live_read_smoke_evidence =
                        Some(ProviderLiveReadSmokeEvidenceCommand::parse(&command)?);
                }
                unknown => return Err(format!("unknown argument: {unknown}")),
            }
        }

        Ok(config)
    }
}

pub(crate) fn print_help() {
    println!("nucleusd");
    println!();
    println!("Usage:");
    println!("  nucleusd [--state <path>] [--bootstrap] [--status]");
    println!("  nucleusd [--state <path>] query <projects|tasks|workspaces|command-evidence|provider-read-intent|provider-readiness-overview|provider-live-read-executor|provider-live-read-smoke-evidence>");
    println!("  nucleusd [--state <path>] query task-timeline --task <task-id>");
    println!("  nucleusd [--state <path>] query task-readiness --project <project-id>");
    println!("  nucleusd [--state <path>] query planning-task-seeds --project <project-id>");
    println!("  nucleusd [--state <path>] query planning-sessions --project <project-id>");
    println!("  nucleusd [--state <path>] query accepted-memory --project <project-id>");
    println!("  nucleusd [--state <path>] query accepted-memory-projection --project <project-id>");
    println!("  nucleusd [--state <path>] query accepted-memory-projection-writes --project <project-id>");
    println!("  nucleusd [--state <path>] query accepted-memory-projection-import --project <project-id>");
    println!("  nucleusd [--state <path>] query accepted-memory-projection-import-apply --project <project-id>");
    println!("  nucleusd [--state <path>] query accepted-memory-import-apply-review-diagnostics --project <project-id>");
    println!("  nucleusd [--state <path>] query accepted-memory-review-receipt-storage-diagnostics --project <project-id>");
    println!(
        "  nucleusd [--state <path>] query accepted-memory-active-apply-diagnostics --project <project-id>"
    );
    println!(
        "  nucleusd [--state <path>] query accepted-memory-review-readiness --project <project-id>"
    );
    println!("  nucleusd [--state <path>] query memory-proposals --project <project-id>");
    println!(
        "  nucleusd [--state <path>] query memory-proposal-review-diagnostics --project <project-id>"
    );
    println!("  nucleusd [--state <path>] query research-run-briefs --project <project-id>");
    println!(
        "  nucleusd [--state <path>] query task-seed-promotion-diagnostics --project <project-id>"
    );
    println!("  nucleusd [--state <path>] query planning-projection-file-write-diagnostics --project <project-id>");
    println!("  nucleusd [--state <path>] query planning-projection-import-diagnostics --project <project-id>");
    println!("  nucleusd [--state <path>] query planning-projection-import-apply-diagnostics --project <project-id>");
    println!("  nucleusd [--state <path>] query planning-projection-import-active-apply-diagnostics --project <project-id>");
    println!("  nucleusd [--state <path>] query planning-capture-publication-diagnostics --project <project-id>");
    println!("  nucleusd [--state <path>] query product-workflow-summary --project <project-id>");
    println!("  nucleusd [--state <path>] query task-workflow-drilldown --project <project-id> --task <task-id>");
    println!("  nucleusd [--state <path>] query selected-task-action-readiness --project <project-id> --task <task-id>");
    println!("  nucleusd [--state <path>] query selected-task-operator-action-gate --project <project-id> --task <task-id>");
    println!("  nucleusd [--state <path>] query selected-task-review-next --project <project-id> --task <task-id>");
    println!("  nucleusd [--state <path>] query selected-task-scm-handoff --project <project-id> --task <task-id>");
    println!("  nucleusd [--state <path>] query selected-task-command-admission --project <project-id> --task <task-id> --family <action-family> [--expected-revision <revision-id>] [--reason <reason>] [--operator <operator-ref>]");
    println!("  nucleusd [--state <path>] query project-authority-map --project <project-id>");
    println!("  nucleusd command-runner smoke");
    println!("  nucleusd command-runner read-only-spawn-smoke");
    println!("  nucleusd command-runner durable-runtime-smoke [--confirm-real-write] [--execute-provider-write]");
    println!("  nucleusd command-runner durable-live-provider-write-smoke [--confirm-real-write] [--confirm-real-effect] [--execute-provider-write]");
    println!("  nucleusd command-runner codex-turn-start-real-write-smoke [--confirm-real-write] [--execute-provider-write]");
    println!("  nucleusd command-runner read-only [--cwd <dir>] [--timeout-ms <ms>] [--stdout-limit <bytes>] [--stderr-limit <bytes>] -- <executable> [args...]");
    println!("  nucleusd provider-live-read-smoke-evidence replay-approved");
    println!();
    println!("Options:");
    println!("  --state <path>  SQLite state path, default .nucleus/local/nucleus.sqlite");
    println!("  --bootstrap     Seed local project, task, and planning records before status");
    println!("  --status        Print local state summary");
    println!("  --help          Print this help");
}

#[cfg(test)]
mod tests;
