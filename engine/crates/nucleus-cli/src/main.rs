mod ensure;
mod planning;
mod serve_log;
mod t3_setup;

use std::{
    borrow::Cow,
    env,
    error::Error,
    fs::File,
    future::Future,
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
    Controller, DependencyCommand, MAX_BRIEF_BYTES, ReportTicket, Service, check_brief_size,
    router_with_board_and_t3_callers, router_with_t3_callers,
};
use nucleus_store::{EngineSettings, Hosts, SettingsFile, StoragePlacement};
use reqwest::{Client, Method, RequestBuilder, header};
use rustix::{
    fs::{FileType, Mode, OFlags, fstat, open},
    process::geteuid,
};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio::{
    net::TcpListener,
    signal::unix::{Signal, SignalKind, signal},
    time::{self, Instant},
};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

const MAX_INPUT: u64 = 64 * 1024;
const REPORT_RETRY_DELAY: Duration = Duration::from_millis(500);
const CONTROL_KEY: &str = "NUCLEUS_ENGINE_CONTROL_KEY";
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
    Acp {
        /// The installed provider launcher for this engine endpoint.
        #[arg(long, hide = true)]
        ensure_launcher: Option<PathBuf>,
    },
    /// Start the local engine if a verified instance is not running.
    Ensure(ensure::Args),
    /// Enable the engine and optionally set its storage placement and overrides.
    Configure(Configure),
    /// Serve the engine for the configured projects.
    Serve {
        #[arg(long)]
        home: Option<PathBuf>,
        /// Use this T3 ACP provider for tasks in the Projects registry.
        #[arg(long)]
        acp_provider: Option<String>,
        /// Override the saved T3 connection for this serve process.
        #[arg(long)]
        t3: Option<String>,
        #[arg(long)]
        actor: String,
        /// Directory containing the built standalone board.
        #[arg(long)]
        board_assets: Option<PathBuf>,
    },
    #[command(flatten)]
    Planning(planning::Action),
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
    /// Recheck a repaired task at the version shown by Next.
    Recheck {
        id: String,
        #[arg(long)]
        version: i64,
    },
    /// Promote a queued or capacity-waiting task ahead of normal queue order.
    Promote {
        id: String,
        #[arg(long)]
        version: i64,
    },
    /// Return a promoted task to normal queue order.
    Demote {
        id: String,
        #[arg(long)]
        version: i64,
    },
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
    /// Enable the profile, or use --enable=false to disable it.
    #[arg(long, num_args = 0..=1, require_equals = true, default_missing_value = "true")]
    enable: Option<bool>,
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
        Action::Acp { ensure_launcher } => {
            if let Err(error) = nucleus_acp::run(endpoint, ensure_launcher).await {
                // Runtime shutdown can wait indefinitely for Tokio's blocking stdin read.
                eprintln!("Error: {error:?}");
                std::process::exit(1);
            }
            Ok(())
        }
        Action::Ensure(args) => ensure::run(endpoint, args).await,
        Action::Configure(args) => configure(&args),
        Action::Serve {
            home,
            acp_provider,
            t3,
            actor,
            board_assets,
        } => {
            std::panic::set_hook(Box::new(|info| {
                serve_log::line(format_args!(
                    "{}",
                    info.to_string().replace(['\r', '\n'], " ")
                ));
            }));
            if let Err(error) = serve(
                endpoint,
                home.as_deref(),
                acp_provider,
                t3.as_deref(),
                actor,
                board_assets.as_deref(),
            )
            .await
            {
                serve_log::line(format_args!(
                    "{}",
                    error.to_string().replace(['\r', '\n'], " ")
                ));
                std::process::exit(1);
            }
            Ok(())
        }
        Action::Report { ticket } => report(&ticket).await,
        Action::Planning(action) if action.uses_ticket() => action.run_ticket().await,
        Action::T3(args) => Box::pin(t3_setup::run(endpoint, args)).await,
        other => control(endpoint, other).await,
    }
}

fn configure(args: &Configure) -> Result<()> {
    let settings = open_settings(args.home.as_deref())?;
    let snapshot = settings.read::<EngineSettings>()?;
    let scratch_root = if args.scratch_root.is_some() || args.reset_roots {
        args.scratch_root.clone()
    } else {
        snapshot.value.scratch_root.clone()
    };
    let volume = args
        .volume
        .as_deref()
        .map(|path| {
            let mut probe = snapshot.value.clone();
            probe.scratch_root.clone_from(&scratch_root);
            settings.identify_volume(path, &probe)
        })
        .transpose()?;
    settings.configure(&snapshot, |config| {
        if let Some(enabled) = args.enable {
            config.enabled = enabled;
        }
        if let Some(placement) = &args.placement {
            config.placement = match placement {
                Placement::Internal => StoragePlacement::Internal,
                Placement::Barge => StoragePlacement::Barge,
            };
        }
        for (current, requested) in [
            (&mut config.work_root, &args.work_root),
            (&mut config.scratch_root, &args.scratch_root),
            (&mut config.builds_root, &args.builds_root),
            (&mut config.log_root, &args.log_root),
        ] {
            if args.reset_roots || requested.is_some() {
                current.clone_from(requested);
            }
        }
        if args.clear_legacy_volume || volume.is_some() {
            config.work_volume.clone_from(&volume);
        }
    })?;
    Ok(())
}

fn open_settings(home: Option<&Path>) -> Result<SettingsFile> {
    Ok(home.map_or_else(SettingsFile::open_default, SettingsFile::open)?)
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
    provider: Option<String>,
    host: Option<&str>,
    actor: String,
    board_assets: Option<&Path>,
) -> Result<()> {
    let started = Instant::now();
    let signals = ShutdownSignals::new()?;
    loopback(endpoint)?;
    let settings = open_settings(home)?;
    let profile = settings.lock_profile()?;
    // Initialization can drop the service before there is an exit to record.
    let _profile_lock = profile.retain_lock();
    serve_log::start(settings.home())?;
    let result = async {
        let provider = provider.ok_or("supply the T3 ACP provider")?;
        if actor.trim().is_empty() {
            return Err("supply the controller identity".into());
        }
        let host = configured_host(&settings, host)?;
        let forge = GitHub::new(&secret("NUCLEUS_ENGINE_GITHUB_TOKEN")?)?;
        let credential = control_key(CONTROL_KEY)?;
        let t3_caller_key = control_key(T3_CALLER_KEY)?;
        if t3_caller_key == credential {
            return Err("supply a distinct T3 caller credential".into());
        }
        let controllers = vec![Controller {
            credential,
            authority: Authority::Operator { actor },
        }];
        let command = env::current_exe()?.canonicalize()?;
        let service = Arc::new(
            Service::open_projects(profile, provider, host, forge, endpoint, command)?
                .with_inbox_from_env()?,
        );
        let api = match board_assets {
            Some(path) => router_with_board_and_t3_callers(
                Arc::clone(&service),
                controllers,
                path,
                Some(t3_caller_key),
            )?,
            None => router_with_t3_callers(Arc::clone(&service), controllers, Some(t3_caller_key)),
        };
        let tcp = TcpListener::bind(endpoint).await?;
        let watch = Arc::clone(&service);
        let watcher = tokio::spawn(async move { watch.watch_host().await });
        let result = serve_http(tcp, api, schedule(service), signals, started).await;
        watcher.abort();
        let _ = watcher.await;
        result
    }
    .await;
    finish_serve(started, &result)
}

fn finish_serve(started: Instant, result: &Result<()>) -> Result<()> {
    if let Err(error) = result {
        serve_log::line(format_args!(
            "Nucleus engine exited with an error after {:.3}s: {}",
            started.elapsed().as_secs_f64(),
            error.to_string().replace(['\r', '\n'], " ")
        ));
    }
    serve_log::finish(result.is_ok())?;
    if result.is_err() {
        std::process::exit(1);
    }
    Ok(())
}

struct ShutdownSignals {
    interrupt: Signal,
    terminate: Signal,
    hangup: Signal,
}

impl ShutdownSignals {
    fn new() -> io::Result<Self> {
        Ok(Self {
            interrupt: signal(SignalKind::interrupt())?,
            terminate: signal(SignalKind::terminate())?,
            hangup: signal(SignalKind::hangup())?,
        })
    }

    async fn next(&mut self) -> &'static str {
        tokio::select! {
            _ = self.interrupt.recv() => "SIGINT",
            _ = self.terminate.recv() => "SIGTERM",
            _ = self.hangup.recv() => "SIGHUP",
        }
    }
}

async fn serve_http(
    tcp: TcpListener,
    api: axum::Router,
    scheduler: impl Future<Output = ()> + Send + 'static,
    mut signals: ShutdownSignals,
    started: Instant,
) -> Result<()> {
    let address = tcp.local_addr()?;
    let mut cycle = tokio::spawn(scheduler);
    serve_log::listening(address);
    let result = tokio::select! {
        biased;
        stopped = &mut cycle => {
            stopped.map_err(|error| format!("scheduler stopped: {error}"))?;
            return Err("scheduler stopped unexpectedly".into());
        },
        result = axum::serve(tcp, api) => result,
        signal = signals.next() => {
            serve_log::line(format_args!(
                "Nucleus engine shutting down on {signal} after {:.3}s",
                started.elapsed().as_secs_f64()
            ));
            Ok(())
        },
    };
    cycle.abort();
    let _ = cycle.await;
    Ok(result?)
}

async fn schedule(service: Arc<Service>) {
    loop {
        match service.pass().await {
            Ok(outcomes) => {
                for outcome in outcomes {
                    if let Err(error) = outcome.result
                        && !error.is_held_call()
                    {
                        serve_log::line(format_args!("{}: {error}", outcome.task));
                    }
                }
            }
            Err(error) => {
                serve_log::line(format_args!("{error}"));
                time::sleep(Duration::from_secs(3)).await;
            }
        }
    }
}

async fn report(path: &Path) -> Result<()> {
    let report: Report = from_reader(io::stdin().lock())?;
    let (client, request) = run_ticket_request(
        path,
        Method::POST,
        "report",
        Some(serde_json::to_value(report)?),
    )?
    .build_split();
    let request = request?;
    let deadline = Instant::now() + Duration::from_mins(1);
    let response = time::timeout_at(deadline, async {
        loop {
            // The service accepts exact replay for the same authenticated report.
            let attempt = request.try_clone().ok_or("report body is not replayable")?;
            match client.execute(attempt).await {
                Err(error) if error.is_request() => time::sleep(REPORT_RETRY_DELAY).await,
                result => return result.map_err(Box::<dyn Error>::from),
            }
        }
    })
    .await
    .map_err(
        |_| "run report endpoint did not answer within 60 seconds; retry the same report JSON",
    )??;

    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    if let Ok(Ok(failure)) = time::timeout_at(deadline, response.json::<Value>()).await
        && let Some(detail) = failure["error"].as_str()
    {
        let bearer = request
            .headers()
            .get(header::AUTHORIZATION)
            .ok_or("missing report authorization")?
            .to_str()?;
        return Err(detail
            .replace(bearer.trim_start_matches("Bearer "), "[redacted]")
            .into());
    }
    Err(format!("run report was refused ({status})").into())
}

fn run_ticket_request(
    path: &Path,
    method: Method,
    suffix: &str,
    body: Option<Value>,
) -> Result<RequestBuilder> {
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
    request(endpoint, method, &path, &ticket.credential, body, None)
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
                json!({"id": id, "reference": reference, "repository": repository, "brief": stdin_brief()?}),
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
        A::Amend { id } => command_path(&id, Command::Amend(stdin_brief()?))?,
        A::Hold { id, reason } => command_path(&id, Command::Hold(reason))?,
        A::Recheck { id, version } => command_path(&id, json!({ "recheck": version }))?,
        A::Promote { id, version } => command_path(&id, json!({ "promote": version }))?,
        A::Demote { id, version } => command_path(&id, json!({ "demote": version }))?,
        A::Release { id } => command_path(&id, Command::Release)?,
        A::SetDependencies(args) => args.request()?,
        A::SetPrerequisiteWait(args) => args.request()?,
        _ => return Err("this command does not use the control API".into()),
    };
    let response = request(endpoint, method, &path, &key, body, actor.as_deref())?
        .send()
        .await?;
    print_control_response(response, board_link).await
}

async fn print_control_response(response: reqwest::Response, board_link: bool) -> Result<()> {
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
    // Without the machine-local T3 caller credential, the control key identifies the caller.
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

fn request(
    endpoint: SocketAddr,
    method: Method,
    path: &str,
    key: &[u8; 32],
    body: Option<Value>,
    t3_actor: Option<&str>,
) -> Result<RequestBuilder> {
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
    Ok(request)
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

fn stdin_brief() -> Result<String> {
    read_brief(io::stdin().lock())
}

fn read_brief(mut source: impl Read) -> Result<String> {
    let mut bytes = Vec::new();
    source
        .by_ref()
        .take(u64::try_from(MAX_BRIEF_BYTES)?)
        .read_to_end(&mut bytes)?;
    // Count remaining input without retaining it, so the refusal gives the actual size.
    let tail = usize::try_from(io::copy(&mut source, &mut io::sink())?)?;
    check_brief_size(bytes.len() + tail)?;
    Ok(String::from_utf8(bytes)?)
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

#[cfg(test)]
mod tests {
    use super::{
        Instant, MAX_BRIEF_BYTES, ShutdownSignals, TcpListener, finish_serve, read_brief,
        serve_http, serve_log,
    };

    #[tokio::test]
    async fn a_scheduler_panic_exits_the_process_and_records_the_cause() {
        const CHILD_HOME: &str = "NUCLEUS_TEST_SCHEDULER_PANIC_HOME";
        if let Some(home) = std::env::var_os(CHILD_HOME) {
            let started = Instant::now();
            serve_log::start(std::path::Path::new(&home)).unwrap();
            let tcp = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let result = serve_http(
                tcp,
                axum::Router::new(),
                async { panic!("fixture scheduler panic") },
                ShutdownSignals::new().unwrap(),
                started,
            )
            .await;
            finish_serve(started, &result).unwrap();
            panic!("serve returned after losing its scheduler");
        }

        let home = tempfile::tempdir().unwrap();
        let output = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            tokio::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "tests::a_scheduler_panic_exits_the_process_and_records_the_cause",
                ])
                .env(CHILD_HOME, home.path())
                .kill_on_drop(true)
                .output(),
        )
        .await
        .expect("the process exits after its scheduler panics")
        .unwrap();
        assert_eq!(output.status.code(), Some(1));
        let log = String::from_utf8_lossy(&output.stderr);
        assert!(log.contains("scheduler stopped"), "{log}");
        assert!(log.contains("fixture scheduler panic"), "{log}");
        assert_eq!(
            std::fs::read(home.path().join("serve.last-run")).unwrap()[0],
            b'F'
        );
    }

    #[test]
    fn brief_stdin_preserves_the_limit_and_counts_the_entire_oversized_input() {
        let exact = "é".repeat(MAX_BRIEF_BYTES / 2);
        assert_eq!(read_brief(exact.as_bytes()).unwrap(), exact);
        let oversized = format!("{exact} 🦀\n");
        assert_eq!(
            read_brief(oversized.as_bytes()).unwrap_err().to_string(),
            "brief is 65542 UTF-8 bytes and exceeds the 65536-byte limit"
        );
    }
}
