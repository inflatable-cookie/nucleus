mod planning;
mod t3_setup;

use std::{
    env,
    error::Error,
    fs::File,
    io::{self, Read},
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use clap::{Parser, Subcommand};
use nucleus_core::{Answer, Authority, Command, Head, Phase, Report};
use nucleus_forge::GitHub;
use nucleus_hosts::T3;
use nucleus_service::{Controller, Project, ReportTicket, Service, router, router_with_board};
use nucleus_store::{Hosts, SettingsFile, TaskNumberSeed, planning::legacy::read_task_number_seed};
use reqwest::{Client, Method, Response, header};
use rustix::{
    fs::{FileType, Mode, OFlags, fstat, open},
    process::geteuid,
};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio::net::TcpListener;

type Result<T> = std::result::Result<T, Box<dyn Error>>;

const MAX_INPUT: u64 = 64 * 1024;
const CONTROL_KEY: &str = "NUCLEUS_ENGINE_CONTROL_KEY";
const FIXTURE_ORIGIN_KEY: &str = "NUCLEUS_ENGINE_FIXTURE_ORIGIN_KEY";

#[derive(Parser)]
#[command(about = "Run the isolated Nucleus task engine")]
struct Cli {
    /// The local engine API address for task commands.
    #[arg(long, default_value = "127.0.0.1:4319", global = true)]
    endpoint: SocketAddr,
    #[command(subcommand)]
    action: Action,
}

#[derive(Subcommand)]
enum Action {
    /// Enable the engine and optionally set its storage roots or pin a volume.
    Configure {
        #[arg(long)]
        home: Option<PathBuf>,
        #[arg(long)]
        enable: bool,
        #[arg(long)]
        volume: Option<PathBuf>,
        #[arg(long)]
        work_root: Option<PathBuf>,
        #[arg(long)]
        scratch_root: Option<PathBuf>,
        #[arg(long)]
        log_root: Option<PathBuf>,
    },
    /// Serve one isolated engine profile.
    Serve {
        #[arg(long)]
        home: Option<PathBuf>,
        #[arg(long)]
        project: PathBuf,
        /// Override the saved T3 connection for this serve process.
        #[arg(long)]
        t3: Option<String>,
        #[arg(long)]
        actor: String,
        /// Bind the controller to the authenticated T3 planner's thread ID.
        #[arg(long)]
        planner: bool,
        /// Give the fixture origin thread its own planner credential.
        #[arg(long)]
        fixture_origin_thread: Option<String>,
        /// Directory containing the built standalone board.
        #[arg(long)]
        board_assets: Option<PathBuf>,
    },
    #[command(flatten)]
    Planning(planning::Action),
    /// Rehearse or apply a legacy planning import from a TypeScript `SQLite` copy.
    #[command(name = "item.import")]
    ImportItems {
        /// A standalone `SQLite` copy under `NUCLEUS_SCRATCH_ROOT`.
        source: PathBuf,
        /// Map a legacy owner/repo to a Rust project ID.
        #[arg(long = "repository", required = true, value_parser = planning::repository_mapping)]
        repositories: Vec<(String, String)>,
        /// Keep the resulting scratch database. The default rolls back after rehearsal.
        #[arg(long)]
        keep: bool,
        /// Append to an existing, stopped Rust profile at this explicit home.
        #[arg(long, value_name = "PROFILE_HOME", conflicts_with = "keep")]
        apply: Option<PathBuf>,
    },
    /// Set up the Nucleus Rust provider in a local T3 environment.
    T3(t3_setup::Args),
    /// Admit a fixture task. Read the brief from stdin.
    Admit { id: String, reference: String },
    /// List task summaries.
    Tasks,
    /// Read the task detail.
    Task { id: String },
    /// Read the task's next commands and current wait.
    Next { id: String },
    /// Read the task's recent activity.
    History { id: String },
    /// Mint an owner-only ACP binding for a task.
    BindAcp {
        id: String,
        #[arg(long)]
        read_only: bool,
    },
    /// Read the isolated engine settings.
    Settings,
    /// Print a one-use link to the local board.
    Ui,
    /// Move to a phase subject to the engine's hard gates.
    Move {
        id: String,
        #[arg(value_parser = parse_phase)]
        phase: Phase,
    },
    /// Answer the current question.
    Answer {
        id: String,
        #[command(subcommand)]
        answer: AnswerArgs,
    },
    /// Cancel the task and revoke its current run.
    Cancel { id: String },
    /// Replace the brief. Read the text from stdin.
    Amend { id: String },
    /// Hold the task for a reason.
    Hold { id: String, reason: String },
    /// Release the task hold.
    Release { id: String },
    /// Send a run report as JSON from stdin.
    Report {
        #[arg(long)]
        ticket: PathBuf,
    },
}

#[derive(Subcommand)]
enum AnswerArgs {
    Work { text: String },
    Retry,
    Accept { head: Head, reason: String },
}

impl From<AnswerArgs> for Answer {
    fn from(args: AnswerArgs) -> Self {
        match args {
            AnswerArgs::Work { text } => Self::Work(text),
            AnswerArgs::Retry => Self::Retry,
            AnswerArgs::Accept { head, reason } => Self::Accept { head, reason },
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let Cli { endpoint, action } = Cli::parse();
    match action {
        Action::Configure {
            home,
            enable,
            volume,
            work_root,
            scratch_root,
            log_root,
        } => configure(
            home.as_deref(),
            enable,
            volume.as_deref(),
            work_root,
            scratch_root,
            log_root,
        ),
        Action::Serve {
            home,
            project,
            t3,
            actor,
            planner,
            fixture_origin_thread,
            board_assets,
        } => {
            let authority = if planner {
                Authority::Planner { actor }
            } else {
                Authority::Operator { actor }
            };
            serve(
                endpoint,
                home.as_deref(),
                &project,
                t3.as_deref(),
                authority,
                fixture_origin_thread,
                board_assets.as_deref(),
            )
            .await
        }
        Action::Report { ticket } => report(&ticket).await,
        Action::ImportItems {
            source,
            repositories,
            keep,
            apply,
        } => planning::import_items(&source, repositories, keep, apply.as_deref()),
        Action::T3(args) => Box::pin(t3_setup::run(endpoint, args)).await,
        other => control(endpoint, other).await,
    }
}

fn configure(
    home: Option<&Path>,
    enabled: bool,
    volume: Option<&Path>,
    work_root: Option<PathBuf>,
    scratch_root: Option<PathBuf>,
    log_root: Option<PathBuf>,
) -> Result<()> {
    let settings = open_settings(home)?;
    let mut config = settings.load()?;
    config.enabled = enabled;
    if work_root.is_some() {
        config.work_root = work_root;
    }
    if scratch_root.is_some() {
        config.scratch_root = scratch_root;
    }
    if log_root.is_some() {
        config.log_root = log_root;
    }
    if let Some(volume) = volume {
        config.work_volume = Some(settings.identify_volume(volume, &config)?);
    }
    settings.save(&config)?;
    Ok(())
}

fn open_settings(home: Option<&Path>) -> Result<SettingsFile> {
    Ok(home.map_or_else(SettingsFile::open_default, SettingsFile::open)?)
}

async fn serve(
    endpoint: SocketAddr,
    home: Option<&Path>,
    project: &Path,
    host: Option<&str>,
    authority: Authority,
    fixture_origin_thread: Option<String>,
    board_assets: Option<&Path>,
) -> Result<()> {
    loopback(endpoint)?;
    let actor = match &authority {
        Authority::Operator { actor } | Authority::Planner { actor } => actor,
    };
    if actor.trim().is_empty() {
        return Err("supply the controller identity".into());
    }
    let settings = open_settings(home)?;
    let project: Project = from_reader(File::open(project)?)?;
    let saved_host = if host.is_none() {
        settings.read::<Hosts>()?.value.t3
    } else {
        None
    };
    let (host_endpoint, credential_ref) = match (host, saved_host.as_ref()) {
        (Some(endpoint), _) => (endpoint, "NUCLEUS_ENGINE_T3_BEARER"),
        (None, Some(saved)) => (saved.endpoint.as_str(), saved.credential_ref.as_str()),
        (None, None) => return Err("set --t3 or configure a T3 endpoint for this profile".into()),
    };
    let mut host = T3::new(host_endpoint, &secret(credential_ref)?)?;
    if let Some(path) = env::var_os("NUCLEUS_ENGINE_T3_RUNTIME_DESCRIPTOR") {
        host = host.with_runtime_descriptor(path.into());
    }
    let forge = GitHub::new(&secret("NUCLEUS_ENGINE_GITHUB_TOKEN")?)?;
    let credential = control_key(CONTROL_KEY)?;
    let mut controllers = vec![Controller {
        credential,
        authority,
    }];
    if let Some(actor) = fixture_origin_thread {
        let origin = control_key(FIXTURE_ORIGIN_KEY)?;
        if origin == credential || actor.trim().is_empty() {
            return Err("supply a distinct key and identity for the fixture origin".into());
        }
        controllers.push(Controller {
            credential: origin,
            authority: Authority::Planner { actor },
        });
    }
    let repository = project.repository.clone();
    let tcp = TcpListener::bind(endpoint).await?;
    let service = Service::open(
        &settings,
        project,
        host,
        forge,
        tcp.local_addr()?,
        env::current_exe()?.canonicalize()?,
    )?
    .with_inbox_from_env()?;
    if let Some(seed) = legacy_number_seed(Some(&repository))? {
        service.seed_task_numbers(&seed).await?;
    }
    let service = Arc::new(service);
    let api = match board_assets {
        Some(path) => router_with_board(Arc::clone(&service), controllers, path)?,
        None => router(Arc::clone(&service), controllers),
    };
    let watch = Arc::clone(&service);
    let watcher = tokio::spawn(async move {
        watch.watch_host().await;
    });
    let cycle = tokio::spawn(async move {
        loop {
            match service.pass().await {
                Ok(outcomes) => {
                    for outcome in outcomes {
                        if let Err(error) = outcome.result {
                            eprintln!("{}: {error}", outcome.task);
                        }
                    }
                }
                Err(error) => {
                    eprintln!("{error}");
                    tokio::time::sleep(Duration::from_secs(3)).await;
                }
            }
        }
    });
    println!("Nucleus engine listening on http://{}", tcp.local_addr()?);
    let result = tokio::select! {
        result = axum::serve(tcp, api) => result,
        result = tokio::signal::ctrl_c() => result,
    };
    watcher.abort();
    cycle.abort();
    Ok(result?)
}

fn legacy_number_seed(repository: Option<&str>) -> Result<Option<TaskNumberSeed>> {
    let Some(source) = env::var_os("NUCLEUS_ENGINE_LEGACY_NUMBERS_COPY") else {
        return Ok(None);
    };
    let scratch = env::var_os("NUCLEUS_SCRATCH_ROOT")
        .ok_or("set NUCLEUS_SCRATCH_ROOT for the fenced legacy number snapshot")?;
    Ok(Some(read_task_number_seed(
        Path::new(&scratch),
        Path::new(&source),
        repository,
    )?))
}

async fn report(path: &Path) -> Result<()> {
    let file = private_file(path)?.ok_or("report ticket is missing")?;
    let ticket: ReportTicket = from_reader(file).map_err(|_| "invalid report ticket")?;
    let endpoint = ticket
        .endpoint
        .strip_prefix("http://")
        .and_then(|address| address.parse().ok())
        .ok_or("invalid report ticket")?;
    loopback(endpoint).map_err(|_| "invalid report ticket")?;
    let task = segment(&ticket.task).map_err(|_| "invalid report ticket")?;
    let instance = segment(&ticket.instance).map_err(|_| "invalid report ticket")?;
    let report: Report = from_reader(io::stdin().lock())?;
    let path = format!("/v1/runs/{task}/{instance}/report");
    let response = request(
        endpoint,
        Method::POST,
        &path,
        &ticket.credential,
        Some(serde_json::to_value(report)?),
    )
    .await?;
    let _ = response.error_for_status()?;
    Ok(())
}

fn private_file(path: &Path) -> Result<Option<File>> {
    let fd = match open(
        path,
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
        Mode::empty(),
    ) {
        Err(rustix::io::Errno::NOENT) => return Ok(None),
        result => result?,
    };
    let metadata = fstat(&fd)?;
    if FileType::from_raw_mode(metadata.st_mode) != FileType::RegularFile
        || metadata.st_uid != geteuid().as_raw()
        || Mode::from_raw_mode(metadata.st_mode).intersects(Mode::RWXG | Mode::RWXO)
    {
        return Err("expected an owner-only regular file".into());
    }
    Ok(Some(File::from(fd)))
}

async fn control(endpoint: SocketAddr, action: Action) -> Result<()> {
    use Action as A;
    loopback(endpoint)?;
    let key = control_key(CONTROL_KEY)?;
    let board_link = matches!(action, A::Ui);
    let (method, path, body) = match action {
        A::Planning(action) => action.request()?,
        A::Admit { id, reference } => (
            Method::POST,
            "/v1/tasks".into(),
            Some(json!({"id": id, "reference": reference, "brief": stdin_text()?})),
        ),
        A::Tasks => (Method::GET, "/v1/tasks".into(), None),
        A::Task { id } => (Method::GET, format!("/v1/tasks/{}", segment(&id)?), None),
        A::Next { id } => (
            Method::GET,
            format!("/v1/tasks/{}/next", segment(&id)?),
            None,
        ),
        A::History { id } => (
            Method::GET,
            format!("/v1/tasks/{}/history", segment(&id)?),
            None,
        ),
        A::BindAcp { id, read_only } => (
            Method::POST,
            format!("/v1/tasks/{}/acp?readOnly={read_only}", segment(&id)?),
            None,
        ),
        A::Settings => (Method::GET, "/v1/settings".into(), None),
        A::Ui => (Method::POST, "/v1/board/link".into(), None),
        A::Move { id, phase } => command_path(&id, Command::Move(phase))?,
        A::Answer { id, answer } => command_path(&id, Command::Answer(answer.into()))?,
        A::Cancel { id } => command_path(&id, Command::Cancel)?,
        A::Amend { id } => command_path(&id, Command::Amend(stdin_text()?))?,
        A::Hold { id, reason } => command_path(&id, Command::Hold(reason))?,
        A::Release { id } => command_path(&id, Command::Release)?,
        _ => return Err("this command does not use the control API".into()),
    };
    let response = request(endpoint, method, &path, &key, body).await?;
    let status = response.status();
    if board_link && status == reqwest::StatusCode::NOT_FOUND {
        return Err("the engine is running without board assets".into());
    }
    let result: Value = response.json().await?;
    if !status.is_success() {
        return Err(result["error"]
            .as_str()
            .unwrap_or("engine command failed")
            .to_owned()
            .into());
    }
    if board_link {
        println!("{}", result["url"].as_str().ok_or("invalid board link")?);
    } else {
        println!("{}", serde_json::to_string_pretty(&result)?);
    }
    Ok(())
}

fn command_path(id: &str, command: Command) -> Result<(Method, String, Option<Value>)> {
    Ok((
        Method::POST,
        format!("/v1/tasks/{}/commands", segment(id)?),
        Some(serde_json::to_value(command)?),
    ))
}

async fn request(
    endpoint: SocketAddr,
    method: Method,
    path: &str,
    key: &[u8; 32],
    body: Option<Value>,
) -> Result<Response> {
    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .timeout(Duration::from_mins(1))
        .build()?;
    let mut credential = header::HeaderValue::from_str(&format!("Bearer {}", hex::encode(key)))?;
    credential.set_sensitive(true);
    let request = client
        .request(method, format!("http://{endpoint}{path}"))
        .header(header::AUTHORIZATION, credential);
    let request = match body {
        Some(body) => request.json(&body),
        None => request,
    };
    Ok(request.send().await?)
}

fn parse_phase(value: &str) -> std::result::Result<Phase, String> {
    serde_json::from_value(Value::String(value.into())).map_err(|_| "expected a task phase".into())
}

fn secret(name: &str) -> Result<String> {
    env::var(name).map_err(|_| format!("set {name}").into())
}

fn control_key(name: &str) -> Result<[u8; 32]> {
    let mut key = [0; 32];
    hex::decode_to_slice(secret(name)?, &mut key)
        .map_err(|_| format!("{name} must contain 64 hex digits"))?;
    Ok(key)
}

fn loopback(address: SocketAddr) -> Result<()> {
    if address.ip().is_loopback() && address.port() != 0 {
        Ok(())
    } else {
        Err("use an explicit local loopback address and port".into())
    }
}

fn segment(value: &str) -> Result<&str> {
    if !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        Ok(value)
    } else {
        Err("invalid task or run ID".into())
    }
}

fn stdin_text() -> Result<String> {
    Ok(String::from_utf8(read(io::stdin().lock())?)?)
}

fn from_reader<T: DeserializeOwned>(source: impl Read) -> Result<T> {
    Ok(serde_json::from_slice(&read(source)?)?)
}

fn read(source: impl Read) -> Result<Vec<u8>> {
    read_with_limit(source, MAX_INPUT)
}

fn read_with_limit(source: impl Read, limit: u64) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    source.take(limit + 1).read_to_end(&mut bytes)?;
    if u64::try_from(bytes.len())? > limit {
        return Err("input exceeds the size limit".into());
    }
    Ok(bytes)
}
