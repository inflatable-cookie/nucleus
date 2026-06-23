use std::env;
use std::path::PathBuf;

use cli::CliConfig;
use nucleus_local_store::SqliteBackend;
use nucleus_server::{
    seed_local_project, seed_local_task, LocalControlRequestHandler, LocalProjectSeed,
    LocalTaskSeed,
};

mod cli;
mod command_runner;
mod labels;
mod provider_live_read_smoke_evidence;
mod query;

fn main() {
    if let Err(error) = run(env::args().skip(1).collect()) {
        eprintln!("nucleusd: {error}");
        std::process::exit(1);
    }
}

fn run(args: Vec<String>) -> Result<(), String> {
    let config = CliConfig::parse(args)?;
    if config.help {
        cli::print_help();
        return Ok(());
    }

    let state_path = config
        .state_path
        .unwrap_or_else(|| PathBuf::from(".nucleus/local/nucleus.sqlite"));
    if let Some(parent) = state_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create state directory: {error}"))?;
    }

    let backend = SqliteBackend::new(&state_path);
    let mut handler = LocalControlRequestHandler::new(backend, None);

    if config.bootstrap {
        seed_local_project(handler.state(), LocalProjectSeed::nucleus_local())
            .map_err(|error| format!("failed to seed local project: {error:?}"))?;
        seed_local_task(handler.state(), LocalTaskSeed::nucleus_local_bootstrap())
            .map_err(|error| format!("failed to seed local task: {error:?}"))?;
    }

    if config.status || config.bootstrap {
        query::print_status(&mut handler, &state_path)?;
    }

    if let Some(query) = config.query {
        query::print_query(&mut handler, query)?;
    }

    if let Some(command_runner) = config.command_runner {
        command_runner::print_command_runner(&mut handler, &state_path, command_runner)?;
    }

    if let Some(command) = config.provider_live_read_smoke_evidence {
        provider_live_read_smoke_evidence::print_provider_live_read_smoke_evidence(
            handler.state(),
            command,
        )?;
    }

    Ok(())
}
