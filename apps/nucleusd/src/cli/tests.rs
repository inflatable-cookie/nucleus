use super::*;

#[test]
fn cli_config_parses_bootstrap_status_and_state() {
    let config = CliConfig::parse(vec![
        "--state".to_owned(),
        "target/nucleus.sqlite".to_owned(),
        "--bootstrap".to_owned(),
        "--status".to_owned(),
    ])
    .expect("parse config");

    assert_eq!(
        config,
        CliConfig {
            state_path: Some(PathBuf::from("target/nucleus.sqlite")),
            bootstrap: true,
            status: true,
            help: false,
            query: None,
            command_runner: None,
        }
    );
}

#[test]
fn cli_config_parses_query_domain() {
    let config =
        CliConfig::parse(vec!["query".to_owned(), "tasks".to_owned()]).expect("parse query");

    assert_eq!(config.query, Some(QueryDomain::Tasks));
}

#[test]
fn cli_config_parses_command_evidence_query_domain() {
    let config = CliConfig::parse(vec!["query".to_owned(), "command-evidence".to_owned()])
        .expect("parse command evidence query");

    assert_eq!(config.query, Some(QueryDomain::CommandEvidence));
}

#[test]
fn cli_config_parses_provider_read_intent_query_domain() {
    let config = CliConfig::parse(vec!["query".to_owned(), "provider-read-intent".to_owned()])
        .expect("parse provider read-intent query");

    assert_eq!(config.query, Some(QueryDomain::ProviderReadIntent));
}

#[test]
fn cli_config_parses_provider_readiness_overview_query_domain() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "provider-readiness-overview".to_owned(),
    ])
    .expect("parse provider readiness overview query");

    assert_eq!(config.query, Some(QueryDomain::ProviderReadinessOverview));
}

#[test]
fn cli_config_parses_provider_live_read_executor_query_domain() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "provider-live-read-executor".to_owned(),
    ])
    .expect("parse provider live-read executor query");

    assert_eq!(config.query, Some(QueryDomain::ProviderLiveReadExecutor));
}

#[test]
fn cli_config_parses_provider_live_read_smoke_evidence_query_domain() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "provider-live-read-smoke-evidence".to_owned(),
    ])
    .expect("parse provider live-read smoke evidence query");

    assert_eq!(
        config.query,
        Some(QueryDomain::ProviderLiveReadSmokeEvidence)
    );
}

#[test]
fn cli_config_parses_command_runner_smoke() {
    let config = CliConfig::parse(vec!["command-runner".to_owned(), "smoke".to_owned()])
        .expect("parse command-runner smoke");

    assert_eq!(config.command_runner, Some(CommandRunnerCommand::Smoke));
}

#[test]
fn cli_config_parses_command_runner_read_only_spawn_smoke() {
    let config = CliConfig::parse(vec![
        "command-runner".to_owned(),
        "read-only-spawn-smoke".to_owned(),
    ])
    .expect("parse command-runner read-only spawn smoke");

    assert_eq!(
        config.command_runner,
        Some(CommandRunnerCommand::ReadOnlySpawnSmoke)
    );
}

#[test]
fn cli_config_parses_durable_runtime_smoke_confirmation() {
    let config = CliConfig::parse(vec![
        "command-runner".to_owned(),
        "durable-runtime-smoke".to_owned(),
        "--confirm-real-write".to_owned(),
    ])
    .expect("parse durable runtime smoke");

    assert_eq!(
        config.command_runner,
        Some(CommandRunnerCommand::DurableRuntimeSmoke(
            CliDurableRuntimeSmoke {
                confirm_real_write: true,
                execute_provider_write: false,
            }
        ))
    );
}

#[test]
fn cli_config_parses_durable_runtime_smoke_execution_flag() {
    let config = CliConfig::parse(vec![
        "command-runner".to_owned(),
        "durable-runtime-smoke".to_owned(),
        "--confirm-real-write".to_owned(),
        "--execute-provider-write".to_owned(),
    ])
    .expect("parse durable runtime smoke");

    assert_eq!(
        config.command_runner,
        Some(CommandRunnerCommand::DurableRuntimeSmoke(
            CliDurableRuntimeSmoke {
                confirm_real_write: true,
                execute_provider_write: true,
            }
        ))
    );
}

#[test]
fn cli_config_parses_durable_live_provider_write_smoke_confirmation() {
    let config = CliConfig::parse(vec![
        "command-runner".to_owned(),
        "durable-live-provider-write-smoke".to_owned(),
        "--confirm-real-write".to_owned(),
    ])
    .expect("parse durable live provider-write smoke");

    assert_eq!(
        config.command_runner,
        Some(CommandRunnerCommand::DurableLiveProviderWriteSmoke(
            CliDurableLiveProviderWriteSmoke {
                confirm_real_write: true,
                confirm_real_effect: false,
                execute_provider_write: false,
            }
        ))
    );
}

#[test]
fn cli_config_parses_durable_live_provider_write_smoke_effect_confirmation() {
    let config = CliConfig::parse(vec![
        "command-runner".to_owned(),
        "durable-live-provider-write-smoke".to_owned(),
        "--confirm-real-write".to_owned(),
        "--confirm-real-effect".to_owned(),
    ])
    .expect("parse durable live provider-write smoke");

    assert_eq!(
        config.command_runner,
        Some(CommandRunnerCommand::DurableLiveProviderWriteSmoke(
            CliDurableLiveProviderWriteSmoke {
                confirm_real_write: true,
                confirm_real_effect: true,
                execute_provider_write: false,
            }
        ))
    );
}

#[test]
fn cli_config_parses_durable_live_provider_write_smoke_execution_flag() {
    let config = CliConfig::parse(vec![
        "command-runner".to_owned(),
        "durable-live-provider-write-smoke".to_owned(),
        "--confirm-real-write".to_owned(),
        "--confirm-real-effect".to_owned(),
        "--execute-provider-write".to_owned(),
    ])
    .expect("parse durable live provider-write smoke execution");

    assert_eq!(
        config.command_runner,
        Some(CommandRunnerCommand::DurableLiveProviderWriteSmoke(
            CliDurableLiveProviderWriteSmoke {
                confirm_real_write: true,
                confirm_real_effect: true,
                execute_provider_write: true,
            }
        ))
    );
}

#[test]
fn cli_config_rejects_unknown_durable_live_provider_write_smoke_flag() {
    let error = CliConfig::parse(vec![
        "command-runner".to_owned(),
        "durable-live-provider-write-smoke".to_owned(),
        "--yes".to_owned(),
    ])
    .expect_err("unknown durable live provider-write smoke flag");

    assert_eq!(
        error,
        "unsupported durable live provider-write smoke flag: --yes"
    );
}

#[test]
fn cli_config_rejects_unknown_durable_runtime_smoke_flag() {
    let error = CliConfig::parse(vec![
        "command-runner".to_owned(),
        "durable-runtime-smoke".to_owned(),
        "--yes".to_owned(),
    ])
    .expect_err("unknown durable runtime smoke flag");

    assert_eq!(error, "unsupported durable runtime smoke flag: --yes");
}

#[test]
fn cli_config_parses_codex_turn_start_real_write_smoke_confirmation() {
    let config = CliConfig::parse(vec![
        "command-runner".to_owned(),
        "codex-turn-start-real-write-smoke".to_owned(),
        "--confirm-real-write".to_owned(),
    ])
    .expect("parse codex smoke");

    assert_eq!(
        config.command_runner,
        Some(CommandRunnerCommand::CodexTurnStartRealWriteSmoke(
            CliCodexTurnStartRealWriteSmoke {
                confirm_real_write: true,
                execute_provider_write: false,
            }
        ))
    );
}

#[test]
fn cli_config_parses_codex_turn_start_real_write_smoke_execution() {
    let config = CliConfig::parse(vec![
        "command-runner".to_owned(),
        "codex-turn-start-real-write-smoke".to_owned(),
        "--confirm-real-write".to_owned(),
        "--execute-provider-write".to_owned(),
    ])
    .expect("parse codex smoke execution");

    assert_eq!(
        config.command_runner,
        Some(CommandRunnerCommand::CodexTurnStartRealWriteSmoke(
            CliCodexTurnStartRealWriteSmoke {
                confirm_real_write: true,
                execute_provider_write: true,
            }
        ))
    );
}

#[test]
fn cli_config_rejects_unknown_codex_smoke_flag() {
    let error = CliConfig::parse(vec![
        "command-runner".to_owned(),
        "codex-turn-start-real-write-smoke".to_owned(),
        "--yes".to_owned(),
    ])
    .expect_err("unknown codex smoke flag");

    assert_eq!(error, "unsupported codex turn/start smoke flag: --yes");
}

#[test]
fn cli_config_parses_command_runner_read_only_structured_command() {
    let config = CliConfig::parse(vec![
        "command-runner".to_owned(),
        "read-only".to_owned(),
        "--cwd".to_owned(),
        ".".to_owned(),
        "--timeout-ms".to_owned(),
        "1500".to_owned(),
        "--stdout-limit".to_owned(),
        "32".to_owned(),
        "--stderr-limit".to_owned(),
        "64".to_owned(),
        "--".to_owned(),
        "printf".to_owned(),
        "nucleus".to_owned(),
    ])
    .expect("parse read-only command");

    assert_eq!(
        config.command_runner,
        Some(CommandRunnerCommand::ReadOnly(CliReadOnlyCommand {
            working_directory: PathBuf::from("."),
            timeout_ms: 1500,
            stdout_limit_bytes: 32,
            stderr_limit_bytes: 64,
            executable: "printf".to_owned(),
            argv: vec!["nucleus".to_owned()],
        }))
    );
}

#[test]
fn cli_config_rejects_read_only_command_without_separator() {
    let error = CliConfig::parse(vec![
        "command-runner".to_owned(),
        "read-only".to_owned(),
        "printf".to_owned(),
    ])
    .expect_err("missing separator");

    assert_eq!(
        error,
        "read-only command requires flags before `--`, then executable and argv"
    );
}

#[test]
fn cli_config_rejects_zero_read_only_timeout() {
    let error = CliConfig::parse(vec![
        "command-runner".to_owned(),
        "read-only".to_owned(),
        "--timeout-ms".to_owned(),
        "0".to_owned(),
        "--".to_owned(),
        "printf".to_owned(),
    ])
    .expect_err("zero timeout");

    assert_eq!(error, "--timeout-ms requires a positive integer");
}

#[test]
fn cli_config_rejects_unknown_args() {
    let error = CliConfig::parse(vec!["--serve".to_owned()]).expect_err("unknown arg");

    assert_eq!(error, "unknown argument: --serve");
}

#[test]
fn cli_config_rejects_unknown_query_domain() {
    let error = CliConfig::parse(vec!["query".to_owned(), "agents".to_owned()])
        .expect_err("unknown query domain");

    assert_eq!(error, "unsupported query domain: agents");
}

#[test]
fn cli_config_rejects_unknown_command_runner_command() {
    let error = CliConfig::parse(vec!["command-runner".to_owned(), "shell".to_owned()])
        .expect_err("unknown command-runner command");

    assert_eq!(error, "unsupported command-runner command: shell");
}
