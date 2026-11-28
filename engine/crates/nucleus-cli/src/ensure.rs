use std::{
    env,
    fs::File,
    net::{Ipv4Addr, SocketAddr},
    os::unix::{fs::MetadataExt, process::CommandExt},
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::Duration,
};

use rustix::{
    fs::{FlockOperation, Mode, OFlags, flock, open},
    io::{Errno, FdFlags, fcntl_setfd},
    process::setsid,
};
use tokio::time::{Instant, sleep};

use crate::{
    Result, open_settings, private_file, require_private_file,
    t3_setup::{canonical_file, engine_health, read_key_file, refresh_launcher, same_engine},
};

#[derive(clap::Args)]
pub(super) struct Args {
    /// The engine profile to start.
    #[arg(long)]
    home: Option<PathBuf>,
    /// Owner-only file with the local engine's controller credential.
    #[arg(long)]
    control_key_file: PathBuf,
    /// Owner-only executable that starts the engine for this profile.
    #[arg(long)]
    serve_launcher: PathBuf,
    /// Enter a new process session before executing the verified launcher.
    #[arg(long, hide = true)]
    detached: bool,
}

#[derive(PartialEq, Eq)]
enum Health {
    Ready,
    Absent,
    Waiting,
}

pub(super) async fn run(endpoint: SocketAddr, args: Args) -> Result<()> {
    if endpoint.ip() != Ipv4Addr::LOCALHOST || endpoint.port() == 0 {
        return Err("use an explicit engine address on 127.0.0.1".into());
    }
    let launcher = canonical_file(&args.serve_launcher)?;
    let file = private_file(&launcher)?.ok_or("the serve launcher is missing")?;
    if file.metadata()?.mode() & 0o100 == 0 {
        return Err("the serve launcher must be owner-executable".into());
    }
    if args.detached {
        setsid()?;
        return Err(Command::new(launcher).exec().into());
    }
    let storage = open_settings(args.home.as_deref())?.storage()?;
    let key = read_key_file(&args.control_key_file)?;
    refresh_launcher(&storage, endpoint);
    if probe(endpoint, &key, &storage).await? == Health::Ready {
        return Ok(());
    }
    let lock = File::from(open(
        storage.home().join("serve.lock"),
        OFlags::RDONLY | OFlags::CREATE | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::RUSR | Mode::WUSR,
    )?);
    require_private_file(&lock)?;
    let deadline = Instant::now() + Duration::from_secs(25);
    let mut child: Option<Child> = None;
    while Instant::now() < deadline {
        match probe(endpoint, &key, &storage).await? {
            Health::Ready => return Ok(()),
            Health::Absent if child.is_none() && take_lock(&lock)? => {
                match probe(endpoint, &key, &storage).await? {
                    Health::Ready => return Ok(()),
                    Health::Absent => child = Some(start(endpoint, &args, &lock)?),
                    Health::Waiting => {}
                }
            }
            Health::Absent | Health::Waiting => {}
        }
        if let Some(child) = child.as_mut()
            && child.try_wait()?.is_some()
        {
            return Err("the local engine exited during startup; check its service log".into());
        }
        sleep(Duration::from_millis(250)).await;
    }
    Err("the local engine did not report healthy before the startup deadline".into())
}

fn take_lock(lock: &File) -> Result<bool> {
    match flock(lock, FlockOperation::NonBlockingLockExclusive) {
        Ok(()) => Ok(true),
        Err(Errno::WOULDBLOCK) => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn start(endpoint: SocketAddr, args: &Args, lock: &File) -> Result<Child> {
    // This CLI invocation spawns only the detached launcher. Give that process
    // a copy of the startup lock so it survives this coordinator exiting.
    let inherited = lock.try_clone()?;
    fcntl_setfd(&inherited, FdFlags::empty())?;
    let mut command = Command::new(env::current_exe()?);
    command
        .args(["--endpoint", &endpoint.to_string(), "ensure", "--detached"])
        .arg("--control-key-file")
        .arg(&args.control_key_file)
        .arg("--serve-launcher")
        .arg(&args.serve_launcher)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let child = command.spawn()?;
    drop(inherited);
    Ok(child)
}

async fn probe(
    endpoint: SocketAddr,
    key: &[u8; 32],
    storage: &nucleus_store::EngineStorage,
) -> Result<Health> {
    match engine_health(endpoint, key).await {
        Ok(view) if same_engine(&view, storage) => Ok(Health::Ready),
        Err(error) if error.is::<tokio::time::error::Elapsed>() => Ok(Health::Waiting),
        Err(error)
            if error
                .downcast_ref::<reqwest::Error>()
                .is_some_and(nucleus_acp::connection_refused) =>
        {
            Ok(Health::Absent)
        }
        _ => Err("the loopback port did not confirm this engine's identity".into()),
    }
}
