mod ensure;
mod planning;
mod t3_setup;

use std::{
    borrow::Cow,
    env,
    error::Error,
    fs::File,
    io::{self, Read},
    net::SocketAddr,
    os::fd::AsFd,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use clap::{Args, Parser, Subcommand, ValueEnum};
use nucleus_core::{Answer, Authority, Command, Head, Phase, Report};
use nucleus_forge::GitHub;
use nucleus_hosts::T3;
use nucleus_service::{
    Controller, DependencyCommand, Project, ReportTicket, Service,
    router_with_board_and_t3_callers, router_with_t3_callers,
};
use nucleus_store::{
    Hosts, SettingsFile, StoragePlacement, TaskNumberSeed, planning::legacy::read_task_number_seed,
};
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
const T3_CALLER_KEY: &str = "NUCLEUS_ENGINE_T3_CALLER_KEY";

#[derive(Parser)]
#[command(name = "nucleus", about = "Run the Nucleus task engine")]
struct Cli {
    /// The local engine API address for task commands.
    #[arg(long, default_value = "127.0.0.1:4319", global = true)]
    endpoint: SocketAddr,
    #[command(subcommand)]
    action: Action,
}

#[derive(Subcommand)]
enum Action {
    /// Serve the Nucleus ACP agent on stdio.
    Acp,
    /// Start the local engine if a verified instance is not running.
    Ensure(ensure::Args),
    /// Enable the engine and optionally set its storage placement and overrides.
    Configure(Configure),
    /// Serve the engine for the configured projects.
    Serve {
        #[arg(long)]
        home: Option<PathBuf>,
        /// Keep running a legacy single-repository pilot or fixture.
        #[arg(
            long,
            conflicts_with = "acp_provider",
            required_unless_present = "acp_provider"
        )]
        project: Option<PathBuf>,
        /// Use this T3 ACP provider for tasks in the Projects registry.
        #[arg(long)]
        acp_provider: Option<String>,
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
    /// Import legacy planning items and profiles from a TypeScript `SQLite` copy.
    #[command(name = "item.import")]
    ImportItems {
        /// A standalone `SQLite` copy under `NUCLEUS_SCRATCH_ROOT`.
        source: PathBuf,
        /// Map a legacy owner/repo to a Rust project ID.
        #[arg(long = "repository", required_unless_present = "profiles_only", value_parser = planning::repository_mapping)]
        repositories: Vec<(String, String)>,
        /// Keep the resulting scratch database. The default rolls back after rehearsal.
        #[arg(long)]
        keep: bool,
        /// Append to an existing, stopped Rust profile at this explicit home.
        #[arg(long, value_name = "PROFILE_HOME", conflicts_with = "keep")]
        apply: Option<PathBuf>,
        /// Apply profiles and pool settings without opening the planning database.
        #[arg(long, requires = "apply")]
        profiles_only: bool,
    },
    /// Import project containers and reconcile Planning from a fenced TypeScript copy.
    #[command(name = "project.import")]
    ImportProjects {
        /// A standalone `SQLite` copy under `NUCLEUS_SCRATCH_ROOT`.
        source: PathBuf,
        /// Apply to an explicit, stopped profile. Omit to rehearse in fresh scratch.
        #[arg(long, value_name = "PROFILE_HOME")]
        apply: Option<PathBuf>,
    },
    /// Import dispatch limits from a fenced TypeScript copy.
    #[command(name = "limits.import")]
    ImportLimits {
        /// A standalone `SQLite` copy under `NUCLEUS_SCRATCH_ROOT`.
        source: PathBuf,
        /// Apply once to an explicit, stopped profile. Omit to print the values.
        #[arg(long, value_name = "PROFILE_HOME")]
        apply: Option<PathBuf>,
    },
    /// Set up the Nucleus Rust provider in a local T3 environment.
    T3(t3_setup::Args),
    /// Admit a task. Read the brief from stdin.
    Admit {
        id: String,
        reference: String,
        /// Canonical GitHub repository. Required in Projects registry mode.
        #[arg(long)]
        repository: Option<String>,
    },
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
    Ui {
        /// Revoke all paired browsers and pending board links.
        #[arg(long)]
        revoke: bool,
    },
    /// Move to a phase subject to the engine's hard gates.
    Move {
        id: String,
        #[arg(value_parser = parse_phase)]
        phase: Phase,
        #[arg(long)]
        instruction: Option<String>,
    },
    /// Accept the exact delivered report.
    Complete {
        id: String,
        #[arg(long)]
        version: i64,
        #[arg(long)]
        lane: String,
        #[arg(long)]
        artifact_version: u64,
        #[arg(long)]
        digest: String,
        #[arg(long)]
        reason: String,
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
    /// Replace the prerequisites of a task before dispatch.
    SetDependencies(DependencyArgs),
    /// Wait for prerequisites after dispatch. Omit references to clear the wait.
    SetPrerequisiteWait(PrerequisiteWaitArgs),
    /// Send a run report as JSON from stdin.
    Report {
        #[arg(long)]
        ticket: PathBuf,
    },
}

#[derive(Args)]
struct DependencyArgs {
    id: String,
    #[arg(long)]
    version: i64,
    prerequisites: Vec<String>,
}

impl DependencyArgs {
    fn request(self) -> Result<(Method, String, Option<Value>)> {
        command_path(
            &self.id,
            DependencyCommand::SetDependencies {
                version: self.version,
                depends_on: self.prerequisites,
            },
        )
    }
}

#[derive(Args)]
struct PrerequisiteWaitArgs {
    #[command(flatten)]
    task: DependencyArgs,
    #[arg(long)]
    reason: String,
}

impl PrerequisiteWaitArgs {
    fn request(self) -> Result<(Method, String, Option<Value>)> {
        command_path(
            &self.task.id,
            DependencyCommand::SetPrerequisiteWait {
                version: self.task.version,
                waits_for: self.task.prerequisites,
                reason: self.reason,
            },
        )
    }
}

#[derive(Subcommand)]
enum AnswerArgs {
    Work { text: String },
    Retry,
    Extend,
    Accept { head: Head, reason: String },
}

impl From<AnswerArgs> for Answer {
    fn from(args: AnswerArgs) -> Self {
        match args {
            AnswerArgs::Work { text } => Self::Work(text),
            AnswerArgs::Retry => Self::Retry,
            AnswerArgs::Extend => Self::Extend,
            AnswerArgs::Accept { head, reason } => Self::Accept { head, reason },
        }
    }
}

#[derive(Args)]
struct Configure {
    #[arg(long)]
    home: Option<PathBuf>,
    #[arg(long)]
    enable: bool,
    /// Select the defaults for worktrees, scratch and builds.
    #[arg(long, value_enum)]
    placement: Option<Placement>,
    #[arg(long, hide = true, conflicts_with = "clear_legacy_volume")]
    volume: Option<PathBuf>,
    /// Remove the old volume pin from a copied profile during an offline move.
    #[arg(long)]
    clear_legacy_volume: bool,
    /// Clear stored root overrides before applying the options below.
    #[arg(long)]
    reset_roots: bool,
    #[arg(long)]
    work_root: Option<PathBuf>,
    #[arg(long)]
    scratch_root: Option<PathBuf>,
    #[arg(long)]
    builds_root: Option<PathBuf>,
    #[arg(long)]
    log_root: Option<PathBuf>,
}

#[derive(Clone, Copy, ValueEnum)]
enum Placement {
    Internal,
    Barge,
}

#[tokio::main]
async fn main() -> Result<()> {
    let Cli { endpoint, action } = Cli::parse();
    match action {
        Action::Acp => Ok(nucleus_acp::run().await?),
        Action::Ensure(args) => ensure::run(endpoint, args).await,
        Action::Configure(args) => configure(args),
        Action::Serve {
            home,
            project,
            acp_provider,
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
            let routing = match project.as_deref() {
                Some(file) => Routing::Legacy(file),
                None => Routing::Registry(acp_provider.ok_or("supply the T3 ACP provider")?),
            };
            serve(
                endpoint,
                home.as_deref(),
                routing,
                t3.as_deref(),
                authority,
                fixture_origin_thread,
                board_assets.as_deref(),
            )
            .await
        }
        Action::Report { ticket } => report(&ticket).await,
        Action::Planning(action) if action.uses_ticket() => action.run_ticket().await,
        Action::ImportItems {
            source,
            repositories,
            keep,
            apply,
            profiles_only,
        } => planning::import_items(&source, repositories, keep, apply.as_deref(), profiles_only),
        Action::ImportProjects { source, apply } => {
            planning::import_projects(&source, apply.as_deref())
        }
        Action::ImportLimits { source, apply } => {
            planning::import_limits(&source, apply.as_deref())
        }
        Action::T3(args) => Box::pin(t3_setup::run(endpoint, args)).await,
        other => control(endpoint, other).await,
    }
}

fn configure(args: Configure) -> Result<()> {
    let settings = open_settings(args.home.as_deref())?;
    let mut config = settings.load()?;
    config.enabled = args.enable;
    if let Some(placement) = args.placement {
        config.placement = match placement {
            Placement::Internal => StoragePlacement::Internal,
            Placement::Barge => StoragePlacement::Barge,
        };
    }
    if args.reset_roots || args.work_root.is_some() {
        config.work_root = args.work_root;
    }
    if args.reset_roots || args.scratch_root.is_some() {
        config.scratch_root = args.scratch_root;
    }
    if args.reset_roots || args.builds_root.is_some() {
        config.builds_root = args.builds_root;
    }
    if args.reset_roots || args.log_root.is_some() {
        config.log_root = args.log_root;
    }
    if args.clear_legacy_volume {
        config.work_volume = None;
    }
    if let Some(volume) = args.volume.as_deref() {
        config.work_volume = Some(settings.identify_volume(volume, &config)?);
    }
    settings.save(&config)?;
    Ok(())
}

fn open_settings(home: Option<&Path>) -> Result<SettingsFile> {
    Ok(home.map_or_else(SettingsFile::open_default, SettingsFile::open)?)
}

enum Routing<'a> {
    Legacy(&'a Path),
    Registry(String),
}

fn configured_host(settings: &SettingsFile, host: Option<&str>) -> Result<T3> {
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
    Ok(host)
}

async fn serve(
    endpoint: SocketAddr,
    home: Option<&Path>,
    routing: Routing<'_>,
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
    let host = configured_host(&settings, host)?;
    let forge = GitHub::new(&secret("NUCLEUS_ENGINE_GITHUB_TOKEN")?)?;
    let credential = control_key(CONTROL_KEY)?;
    let t3_caller_key = if matches!(routing, Routing::Registry(_)) {
        if !matches!(authority, Authority::Operator { .. }) || fixture_origin_thread.is_some() {
            return Err("use the T3 caller credential with the Projects registry".into());
        }
        let key = control_key(T3_CALLER_KEY)?;
        if key == credential {
            return Err("supply a distinct T3 caller credential".into());
        }
        Some(key)
    } else {
        None
    };
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
    let callback = endpoint;
    let command = env::current_exe()?.canonicalize()?;
    let (service, repository) = match routing {
        Routing::Legacy(file) => {
            let project: Project = from_reader(File::open(file)?)?;
            let repository = project.repository.clone();
            (
                Service::open(&settings, project, host, forge, callback, command)?,
                Some(repository),
            )
        }
        Routing::Registry(provider) => (
            Service::open_projects(&settings, provider, host, forge, callback, command)?,
            None,
        ),
    };
    let service = service.with_inbox_from_env()?;
    if let Some(seed) = legacy_number_seed(repository.as_deref())? {
        service.seed_task_numbers(&seed).await?;
    }
    let service = Arc::new(service);
    let api = match board_assets {
        Some(path) => router_with_board_and_t3_callers(
            Arc::clone(&service),
            controllers,
            path,
            t3_caller_key,
        )?,
        None => router_with_t3_callers(Arc::clone(&service), controllers, t3_caller_key),
    };
    let tcp = TcpListener::bind(endpoint).await?;
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
    let report: Report = from_reader(io::stdin().lock())?;
    let response = run_ticket_request(
        path,
        Method::POST,
        "report",
        Some(serde_json::to_value(report)?),
    )
    .await?;
    if !response.status().is_success() {
        let failure: Value = response.json().await?;
        return Err(failure["error"]
            .as_str()
            .unwrap_or("run report was refused")
            .to_owned()
            .into());
    }
    Ok(())
}

async fn run_ticket_request(
    path: &Path,
    method: Method,
    suffix: &str,
    body: Option<Value>,
) -> Result<Response> {
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
    let path = format!("/v1/runs/{task}/{instance}/{suffix}");
    request(endpoint, method, &path, &ticket.credential, body, None).await
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
    require_private_file(&fd)?;
    Ok(Some(File::from(fd)))
}

fn require_private_file(file: impl AsFd) -> Result<()> {
    let metadata = fstat(file)?;
    if FileType::from_raw_mode(metadata.st_mode) != FileType::RegularFile
        || metadata.st_uid != geteuid().as_raw()
        || Mode::from_raw_mode(metadata.st_mode).intersects(Mode::RWXG | Mode::RWXO)
    {
        return Err("expected an owner-only regular file".into());
    }
    Ok(())
}

async fn control(endpoint: SocketAddr, action: Action) -> Result<()> {
    use Action as A;
    loopback(endpoint)?;
    let (key, actor) = control_caller()?;
    let board_link = matches!(action, A::Ui { revoke: false });
    let (method, path, body) = match action {
        A::Planning(action) => action.request()?,
        A::Admit {
            id,
            reference,
            repository,
        } => (
            Method::POST,
            "/v1/tasks".into(),
            Some(
                json!({"id": id, "reference": reference, "repository": repository, "brief": stdin_text()?}),
            ),
        ),
        A::Tasks => (Method::GET, "/v1/tasks".into(), None),
        A::Task { id } => (
            Method::GET,
            format!("/v1/tasks/{}", task_segment(&id)?),
            None,
        ),
        A::Next { id } => (
            Method::GET,
            format!("/v1/tasks/{}/next", task_segment(&id)?),
            None,
        ),
        A::History { id } => (
            Method::GET,
            format!("/v1/tasks/{}/history", task_segment(&id)?),
            None,
        ),
        A::BindAcp { id, read_only } => (
            Method::POST,
            format!("/v1/tasks/{}/acp?readOnly={read_only}", task_segment(&id)?),
            None,
        ),
        A::Settings => (Method::GET, "/v1/settings".into(), None),
        A::Ui { revoke: false } => (Method::POST, "/v1/board/link".into(), None),
        A::Ui { revoke: true } => (Method::POST, "/v1/board/revoke".into(), None),
        A::Move {
            id,
            phase: Phase::Working,
            instruction: Some(instruction),
        } => command_path(&id, Command::MoveWork { instruction })?,
        A::Move {
            id,
            phase,
            instruction: None,
        } => command_path(&id, Command::Move(phase))?,
        A::Move { .. } => return Err("--instruction requires move to work".into()),
        A::Complete {
            id,
            version,
            lane,
            artifact_version,
            digest,
            reason,
        } => command_path(
            &id,
            Command::Complete {
                version,
                artifact: nucleus_core::ReportArtifact {
                    key: lane,
                    version: artifact_version,
                    digest,
                },
                reason,
            },
        )?,
        A::Answer { id, answer } => command_path(&id, Command::Answer(answer.into()))?,
        A::Cancel { id } => command_path(&id, Command::Cancel)?,
        A::Amend { id } => command_path(&id, Command::Amend(stdin_text()?))?,
        A::Hold { id, reason } => command_path(&id, Command::Hold(reason))?,
        A::Release { id } => command_path(&id, Command::Release)?,
        A::SetDependencies(args) => args.request()?,
        A::SetPrerequisiteWait(args) => args.request()?,
        _ => return Err("this command does not use the control API".into()),
    };
    let response = request(endpoint, method, &path, &key, body, actor.as_deref()).await?;
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

fn command_path(
    id: &str,
    command: impl serde::Serialize,
) -> Result<(Method, String, Option<Value>)> {
    Ok((
        Method::POST,
        format!("/v1/tasks/{}/commands", task_segment(id)?),
        Some(serde_json::to_value(command)?),
    ))
}

fn control_caller() -> Result<([u8; 32], Option<String>)> {
    let actor = env::var("T3CODE_THREAD_ID").unwrap_or_default();
    let host = env::var("T3CODE_DESKTOP_HOST_SCOPE").unwrap_or_default();
    // The legacy pilot predates the machine-local T3 caller credential.
    if env::var_os(T3_CALLER_KEY).is_none() || (actor.trim().is_empty() && host.trim().is_empty()) {
        return Ok((control_key(CONTROL_KEY)?, None));
    }
    if actor.trim().is_empty() || host.trim().is_empty() {
        return Err("T3 caller identity requires the host's thread ID and desktop scope".into());
    }
    if env::var_os("NUCLEUS_CONTINUATION_TICKET").is_some()
        || env::var_os("NUCLEUS_TICKET").is_some_and(|path| Path::new(&path).exists())
    {
        return Err("use the authenticated Nucleus task ticket for this call".into());
    }
    Ok((control_key(T3_CALLER_KEY)?, Some(actor.trim().into())))
}

async fn request(
    endpoint: SocketAddr,
    method: Method,
    path: &str,
    key: &[u8; 32],
    body: Option<Value>,
    t3_actor: Option<&str>,
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
    let request = if let Some(actor) = t3_actor {
        request.header("x-nucleus-t3-caller", actor)
    } else {
        request
    };
    let request = match body {
        Some(body) => request.json(&body),
        None => request,
    };
    Ok(request.send().await?)
}

fn parse_phase(value: &str) -> std::result::Result<Phase, String> {
    if value == "work" {
        return Ok(Phase::Working);
    }
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

fn task_segment(value: &str) -> Result<Cow<'_, str>> {
    if !value.contains('#') {
        return segment(value).map(Cow::Borrowed);
    }
    if !value.bytes().all(|byte| {
        byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'/' | b'#')
    }) {
        return Err("invalid task reference. Use repo#N.".into());
    }
    Ok(Cow::Owned(value.replace('/', "%2F").replace('#', "%23")))
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
