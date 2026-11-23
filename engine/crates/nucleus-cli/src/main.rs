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
use nucleus_service::{Controller, Project, ReportTicket, Service, router};
use nucleus_store::{EngineSettings, PinnedVolume, SettingsFile};
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
    /// Set the engine's opt-in flag and pinned storage roots.
    Configure {
        #[arg(long)]
        home: PathBuf,
        #[arg(long)]
        enable: bool,
        #[arg(long)]
        work_root: Option<PathBuf>,
        #[arg(long)]
        scratch_root: Option<PathBuf>,
    },
    /// Serve one isolated engine profile.
    Serve {
        #[arg(long)]
        home: PathBuf,
        #[arg(long)]
        project: PathBuf,
        #[arg(long)]
        t3: String,
        #[arg(long)]
        actor: String,
        /// Bind the controller to the authenticated T3 planner's thread ID.
        #[arg(long)]
        planner: bool,
        /// Give the fixture origin thread its own planner credential.
        #[arg(long)]
        fixture_origin_thread: Option<String>,
    },
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
    /// Read the active storage roots and role profiles.
    Settings,
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
            work_root,
            scratch_root,
        } => configure(&home, enable, work_root, scratch_root),
        Action::Serve {
            home,
            project,
            t3,
            actor,
            planner,
            fixture_origin_thread,
        } => {
            let authority = if planner {
                Authority::Planner { actor }
            } else {
                Authority::Operator { actor }
            };
            serve(
                endpoint,
                &home,
                &project,
                &t3,
                authority,
                fixture_origin_thread,
            )
            .await
        }
        Action::Report { ticket } => report(&ticket).await,
        other => control(endpoint, other).await,
    }
}

fn configure(
    home: &Path,
    enabled: bool,
    work_root: Option<PathBuf>,
    scratch_root: Option<PathBuf>,
) -> Result<()> {
    let home = home.canonicalize()?;
    let settings = SettingsFile::open(&home)?;
    settings.save(&EngineSettings {
        enabled,
        work_volume: Some(PinnedVolume::detect(&home)?),
        work_root,
        scratch_root,
    })?;
    Ok(())
}

async fn serve(
    endpoint: SocketAddr,
    home: &Path,
    project: &Path,
    host: &str,
    authority: Authority,
    fixture_origin_thread: Option<String>,
) -> Result<()> {
    loopback(endpoint)?;
    let actor = match &authority {
        Authority::Operator { actor } | Authority::Planner { actor } => actor,
    };
    if actor.trim().is_empty() {
        return Err("supply the controller identity".into());
    }
    let settings = SettingsFile::open(&home.canonicalize()?)?;
    let project: Project = from_reader(File::open(project)?)?;
    let mut host = T3::new(host, &secret("NUCLEUS_ENGINE_T3_BEARER")?)?;
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
    let tcp = TcpListener::bind(endpoint).await?;
    let service = Arc::new(Service::open(
        &settings,
        project,
        host,
        forge,
        tcp.local_addr()?,
        env::current_exe()?.canonicalize()?,
    )?);
    let api = router(Arc::clone(&service), controllers);
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

async fn report(path: &Path) -> Result<()> {
    let fd = open(
        path,
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
        Mode::empty(),
    )?;
    let metadata = fstat(&fd)?;
    if FileType::from_raw_mode(metadata.st_mode) != FileType::RegularFile
        || metadata.st_uid != geteuid().as_raw()
        || Mode::from_raw_mode(metadata.st_mode).intersects(Mode::RWXG | Mode::RWXO)
    {
        return Err("report ticket must be an owner-only regular file".into());
    }
    let ticket: ReportTicket = from_reader(File::from(fd)).map_err(|_| "invalid report ticket")?;
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

async fn control(endpoint: SocketAddr, action: Action) -> Result<()> {
    use Action as A;
    loopback(endpoint)?;
    let key = control_key(CONTROL_KEY)?;
    let (method, path, body) = match action {
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
    let result: Value = response.json().await?;
    if !status.is_success() {
        return Err(result["error"]
            .as_str()
            .unwrap_or("engine command failed")
            .to_owned()
            .into());
    }
    println!("{}", serde_json::to_string_pretty(&result)?);
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
    let mut bytes = Vec::new();
    source.take(MAX_INPUT + 1).read_to_end(&mut bytes)?;
    if u64::try_from(bytes.len())? > MAX_INPUT {
        return Err("input exceeds the size limit".into());
    }
    Ok(bytes)
}
