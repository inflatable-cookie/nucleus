use std::path::PathBuf;

use nucleus_local_store::SqliteBackend;
use nucleus_server::{read_native_proof_evidence, ServerStateService};

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(2);
    }
}

fn run() -> Result<(), String> {
    let mut arguments = std::env::args_os().skip(1);
    let data_root = arguments
        .next()
        .map(PathBuf::from)
        .ok_or_else(|| "native proof evidence requires one explicit data root".to_owned())?;
    if arguments.next().is_some() {
        return Err("native proof evidence accepts exactly one data root".to_owned());
    }
    if !data_root.is_absolute() {
        return Err("native proof evidence data root must be absolute".to_owned());
    }
    if !data_root.is_dir() {
        return Err("native proof evidence data root must already exist".to_owned());
    }
    let database_path = data_root
        .join("data")
        .join("databases")
        .join("nucleus.sqlite");
    if !database_path.is_file() {
        return Err("native proof evidence database does not exist".to_owned());
    }

    let state = ServerStateService::new(SqliteBackend::new_read_only(database_path));
    let summary = read_native_proof_evidence(&state)?;
    println!(
        "{}",
        serde_json::to_string_pretty(&summary)
            .map_err(|_| "native proof evidence encoding failed".to_owned())?
    );
    Ok(())
}
