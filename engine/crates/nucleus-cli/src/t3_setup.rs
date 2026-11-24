use std::{
    collections::BTreeSet,
    env,
    fs::{self, File},
    io::Write,
    net::{Ipv4Addr, SocketAddr},
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use clap::Subcommand;
use nucleus_hosts::{
    INBOX_THREAD, InboxStatus, InboxTarget, NUCLEUS_RUST_PROVIDER, ProviderRegistration,
    ProviderSetup, ProviderSetupError, T3,
};
use nucleus_service::native_inbox_directory;
use nucleus_store::{EngineStorage, Hosts, SettingsFile};
use reqwest::{Method, Url};
use rustix::fs::{FlockOperation, Mode, OFlags, flock, open};
use serde_json::{Value, json};

use crate::{
    CONTROL_KEY, MAX_INPUT, Result, control_key, loopback, open_settings, private_file, read,
    request, secret,
};

const INSTALL_BEARER: &str = "NUCLEUS_ENGINE_T3_INSTALL_BEARER";
const LAUNCHER: &str = "nucleus-rust-acp";
const MARKER: &str = "#!/bin/sh\n# nucleus-rust-acp-launcher-v1\n";
const INBOX_ICON: &[u8] = include_bytes!("../../../assets/nucleus-icon.svg");

#[derive(clap::Args)]
pub(crate) struct Args {
    /// Use an existing portable Rust engine profile.
    #[arg(long, global = true)]
    home: Option<PathBuf>,
    /// Use this T3 loopback origin instead of the saved Hosts endpoint.
    #[arg(long, global = true)]
    t3: Option<String>,
    /// Read the engine's controller key from an owner-only file.
    #[arg(long, global = true)]
    control_key_file: Option<PathBuf>,
    #[command(subcommand)]
    action: Action,
}

#[derive(Subcommand)]
enum Action {
    /// Register nucleus-rust and set up the pinned Rust Inbox.
    Install {
        /// Absolute path to the owner-only engine serve launcher.
        #[arg(long)]
        serve_launcher: PathBuf,
        /// Adopt the existing local nucleus-rust registration.
        #[arg(long)]
        adopt: bool,
    },
    /// Retire the Rust Inbox and remove this profile's verified registration.
    Uninstall,
    /// Read provider, launcher, engine and Inbox status.
    Status,
}

struct Target {
    endpoint: Url,
    runtime_credential: String,
}

impl Target {
    fn resolve(settings: &SettingsFile, endpoint: Option<String>) -> Result<Self> {
        if let Some(endpoint) = endpoint {
            return Ok(Self {
                endpoint: Url::parse(&endpoint)?,
                runtime_credential: "NUCLEUS_ENGINE_T3_BEARER".into(),
            });
        }
        let saved = settings
            .read::<Hosts>()?
            .value
            .t3
            .ok_or("set --t3 or configure this Rust profile's T3 endpoint")?;
        Ok(Self {
            endpoint: saved.endpoint,
            runtime_credential: saved.credential_ref,
        })
    }

    fn provider(&self, launcher: &Path, write: bool) -> Result<ProviderSetup> {
        let credential = if write {
            secret(INSTALL_BEARER)?
        } else {
            secret(&self.runtime_credential).or_else(|_| secret(INSTALL_BEARER))?
        };
        Ok(ProviderSetup::new(
            self.endpoint.as_str(),
            &credential,
            path_string(launcher)?,
        )?)
    }

    fn inbox(&self) -> Result<T3> {
        Ok(T3::new(
            self.endpoint.as_str(),
            &secret(&self.runtime_credential)?,
        )?)
    }
}

pub(crate) async fn run(endpoint: SocketAddr, args: Args) -> Result<()> {
    loopback(endpoint)?;
    let settings = open_settings(args.home.as_deref())?;
    let storage = if matches!(&args.action, Action::Install { .. }) {
        settings.storage()?
    } else {
        settings.configured_storage()?
    };
    let launcher = storage.bin().path().join(LAUNCHER);
    let target = Target::resolve(&settings, args.t3);
    let inbox_root = native_inbox_directory(&storage);
    let inbox = InboxTarget {
        root: path_string(&inbox_root)?,
        provider: NUCLEUS_RUST_PROVIDER,
    };

    match args.action {
        Action::Status => {
            Box::pin(status(
                endpoint,
                &storage,
                &launcher,
                target.ok().as_ref(),
                &inbox,
                args.control_key_file.as_deref(),
            ))
            .await?;
        }
        Action::Install {
            serve_launcher,
            adopt,
        } => {
            let target = target?;
            let provider = target.provider(&launcher, true)?;
            let host = target.inbox()?;
            let registration = verify_registration(&provider).await?;
            match registration {
                ProviderRegistration::Removing => {
                    return Err(ProviderSetupError::Unconfirmed.to_string().into());
                }
                ProviderRegistration::Adoptable if !adopt => {
                    return Err(ProviderSetupError::AdoptionRequired.to_string().into());
                }
                _ => {}
            }
            let key_file = args
                .control_key_file
                .ok_or("install requires --control-key-file")?;
            let _setup_lock = install_launcher(
                &storage,
                endpoint,
                &launcher,
                &key_file,
                &serve_launcher,
                &env::current_exe()?.canonicalize()?,
                adopt
                    && matches!(
                        registration,
                        ProviderRegistration::Ready | ProviderRegistration::Registered
                    ),
            )?;
            ensure(&launcher).await?;
            let key = read_key_file(&key_file)?;
            let health = engine_health(endpoint, &key).await?;
            if !same_engine(&health, &storage) || health["engine"]["t3Endpoint"] != host.endpoint()
            {
                return Err(
                    "the local engine is serving a different Storage profile or T3 origin".into(),
                );
            }
            if inbox_health(&health).is_none() {
                return Err("enable the native Rust Inbox in the engine serve launcher".into());
            }
            provider
                .install(adopt)
                .await
                .map_err(|error| error.to_string())?;
            let favicon = storage.home().join("nucleus-icon.svg");
            let mut staged = tempfile::NamedTempFile::new_in(storage.home())?;
            staged.write_all(INBOX_ICON)?;
            staged.as_file().sync_all()?;
            staged.persist(&favicon)?;
            reconcile_inbox(&host, &inbox, Some(path_string(&favicon)?)).await?;
            wait_for_inbox(endpoint, &key).await?;
            println!("Verified {NUCLEUS_RUST_PROVIDER} and the pinned Rust Inbox.");
        }
        Action::Uninstall => {
            Box::pin(uninstall(&target?, &launcher, &inbox)).await?;
        }
    }
    Ok(())
}

async fn uninstall(target: &Target, launcher: &Path, inbox: &InboxTarget<'_>) -> Result<()> {
    let provider = target.provider(launcher, true)?;
    let setup_dir = open_setup_directory(launcher)?;
    if let Some(directory) = &setup_dir {
        lock_setup(directory)?;
    }
    match verify_registration(&provider).await? {
        ProviderRegistration::Adoptable => {
            return Err(ProviderSetupError::Conflict.to_string().into());
        }
        ProviderRegistration::Ready | ProviderRegistration::Registered
            if local_launcher(launcher)?.is_none() =>
        {
            return Err("the owner-only nucleus-rust launcher could not be verified".into());
        }
        _ => {}
    }
    reconcile_inbox(&target.inbox()?, inbox, None).await?;
    provider
        .uninstall()
        .await
        .map_err(|error| error.to_string())?;
    println!("Retired the Rust Inbox. {NUCLEUS_RUST_PROVIDER} is absent.");
    Ok(())
}

async fn verify_registration(provider: &ProviderSetup) -> Result<ProviderRegistration> {
    match provider
        .observe()
        .await
        .map_err(|error| error.to_string())?
    {
        ProviderRegistration::Conflict => Err(ProviderSetupError::Conflict.to_string().into()),
        observed => Ok(observed),
    }
}

async fn reconcile_inbox(host: &T3, target: &InboxTarget<'_>, favicon: Option<&str>) -> Result<()> {
    tokio::time::timeout(Duration::from_mins(1), async {
        let mut sent = BTreeSet::new();
        let mut delay = Duration::from_millis(500);
        loop {
            if let Some(write) = host.prepare_inbox_setup(target, favicon).await? {
                if sent.insert(write.command_id().to_owned()) {
                    host.write_inbox(write).await?;
                    delay = Duration::from_millis(500);
                }
            } else {
                return Ok(());
            }
            tokio::time::sleep(delay).await;
            delay = (delay * 2).min(Duration::from_secs(8));
        }
    })
    .await
    .map_err(|_| "T3 did not confirm the Rust Inbox change; run t3 status")?
}

fn inbox_health(health: &Value) -> Option<bool> {
    let inbox = &health["inbox"];
    if inbox["threadId"] != INBOX_THREAD || inbox["enabled"] != true {
        return None;
    }
    inbox["observed"].as_bool()
}

pub(super) fn same_engine(health: &Value, storage: &EngineStorage) -> bool {
    health["engine"]["databaseRoot"]
        .as_str()
        .is_some_and(|path| Path::new(path) == storage.database().path())
}

async fn wait_for_inbox(endpoint: SocketAddr, key: &[u8; 32]) -> Result<()> {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            if inbox_health(&engine_health(endpoint, key).await?) == Some(true) {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    })
    .await
    .map_err(|_| "the Inbox is pinned; the engine has not observed its session yet")?
}

fn install_launcher(
    storage: &EngineStorage,
    endpoint: SocketAddr,
    launcher: &Path,
    key_file: &Path,
    serve: &Path,
    acp: &Path,
    replace_registered: bool,
) -> Result<File> {
    if endpoint.ip() != Ipv4Addr::LOCALHOST {
        return Err("the local service helper requires an engine endpoint on 127.0.0.1".into());
    }
    let key_file = canonical_file(key_file)?;
    let _ = read_key_file(&key_file)?;
    let serve = canonical_file(serve)?;
    let serve_file = private_file(&serve)?.ok_or("serve launcher is missing")?;
    let acp = canonical_file(acp)?;
    if serve_file.metadata()?.mode() & 0o100 == 0 || fs::metadata(&acp)?.mode() & 0o111 == 0 {
        return Err("the serve launcher and ACP command must be executable".into());
    }

    let directory = launcher.parent().ok_or("invalid launcher directory")?;
    let script = launcher_script(storage, endpoint.port(), directory, &key_file, &serve, &acp)?;
    storage.bin().ensure()?;
    storage.log().ensure()?;
    let setup_directory = open_setup_directory(launcher)?.ok_or("provider directory is missing")?;
    lock_setup(&setup_directory)?;
    let prior = private_launcher(launcher)?;
    if prior.as_deref() != Some(script.as_bytes()) {
        if prior.is_some() && !replace_registered {
            return Err(
                "existing launcher differs; --adopt requires a matching T3 registration".into(),
            );
        }
        let mut staged = tempfile::NamedTempFile::new_in(directory)?;
        staged.write_all(script.as_bytes())?;
        staged
            .as_file()
            .set_permissions(fs::Permissions::from_mode(0o700))?;
        staged.as_file().sync_all()?;
        let published = if prior.is_some() {
            staged.persist(launcher)
        } else {
            staged.persist_noclobber(launcher)
        };
        match published {
            Ok(_) => setup_directory.sync_all()?,
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.error.into()),
        }
    }
    if local_launcher(launcher)?.as_deref() != Some(script.as_bytes()) {
        return Err("the existing nucleus-rust launcher differs from this install".into());
    }
    Ok(setup_directory)
}

fn launcher_script(
    storage: &EngineStorage,
    port: u16,
    directory: &Path,
    key_file: &Path,
    serve: &Path,
    acp: &Path,
) -> Result<String> {
    let key_file = quote(key_file)?;
    let home = directory.parent().ok_or("invalid engine home")?;
    let home = quote(home)?;
    let serve = quote(serve)?;
    let acp = quote(acp)?;
    let bindings = quote(&storage.database().path().join("acp-bindings"))?;
    let scratch = quote(storage.scratch().path())?;
    let log = quote(&storage.log().path().join("acp.log"))?;
    Ok(format!(
        r#"{MARKER}set -eu
umask 077
unset {INSTALL_BEARER} NUCLEUS_ACP_SESSION
export TMPDIR={scratch} TMP={scratch} TEMP={scratch}
export PATH={home}/bin:"${{PATH:-/usr/bin:/bin}}"
exec 2>>{log}
{acp} --endpoint 127.0.0.1:{port} ensure --home {home} --control-key-file {key_file} --serve-launcher {serve}
if [ "${{1-}}" = --ensure-only ]; then exit 0; fi
export NUCLEUS_ACP_BINDINGS={bindings}
exec {acp} acp "$@"
"#
    ))
}

pub(super) fn canonical_file(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() || path.canonicalize()? != path || !path.is_file() {
        return Err("use a canonical absolute path to a regular file".into());
    }
    Ok(path.into())
}

fn path_string(path: &Path) -> Result<&str> {
    path.to_str()
        .filter(|path| !path.chars().any(char::is_control))
        .ok_or_else(|| "launcher paths must be UTF-8 without control characters".into())
}

fn quote(path: &Path) -> Result<String> {
    Ok(format!("'{}'", path_string(path)?.replace('\'', "'\\''")))
}

fn open_setup_directory(path: &Path) -> Result<Option<File>> {
    let directory = path.parent().ok_or("invalid launcher directory")?;
    let file = match open(
        directory,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    ) {
        Err(rustix::io::Errno::NOENT) => return Ok(None),
        result => File::from(result?),
    };
    let metadata = file.metadata()?;
    if metadata.uid() != rustix::process::geteuid().as_raw() || metadata.mode() & 0o777 != 0o700 {
        return Err("the provider directory must be owner-only".into());
    }
    Ok(Some(file))
}

fn lock_setup(directory: &File) -> Result<()> {
    flock(directory, FlockOperation::NonBlockingLockExclusive)
        .map_err(|_| "another T3 setup command holds the provider directory lock".into())
}

fn private_launcher(path: &Path) -> Result<Option<Vec<u8>>> {
    if open_setup_directory(path)?.is_none() {
        return Ok(None);
    }
    let Some(file) = private_file(path)? else {
        return Ok(None);
    };
    if file.metadata()?.mode() & 0o777 != 0o700 {
        return Err("the nucleus-rust launcher must have mode 0700".into());
    }
    Ok(Some(read(file)?))
}

fn local_launcher(path: &Path) -> Result<Option<Vec<u8>>> {
    let bytes = private_launcher(path)?;
    if bytes
        .as_ref()
        .is_some_and(|bytes| !bytes.starts_with(MARKER.as_bytes()))
    {
        return Err("the nucleus-rust launcher does not have the expected ownership marker".into());
    }
    Ok(bytes)
}

pub(super) fn read_key_file(path: &Path) -> Result<[u8; 32]> {
    let file = private_file(path)?.ok_or("engine health credential file is missing")?;
    let bytes = read(file)?;
    let digits = bytes.strip_suffix(b"\n").unwrap_or(&bytes);
    let mut key = [0; 32];
    if digits.iter().any(u8::is_ascii_uppercase) || hex::decode_to_slice(digits, &mut key).is_err()
    {
        return Err("engine health credential must contain 64 lowercase hex digits".into());
    }
    Ok(key)
}

async fn ensure(launcher: &Path) -> Result<()> {
    let running = tokio::process::Command::new(launcher)
        .arg("--ensure-only")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .kill_on_drop(true)
        .status();
    if !tokio::time::timeout(Duration::from_secs(30), running)
        .await??
        .success()
    {
        return Err(
            "the local engine did not report healthy; check the serve launcher and log".into(),
        );
    }
    Ok(())
}

pub(super) async fn engine_health(endpoint: SocketAddr, key: &[u8; 32]) -> Result<Value> {
    tokio::time::timeout(Duration::from_secs(3), async {
        let mut response = request(endpoint, Method::GET, "/v1/health", key, None, None)?
            .send()
            .await?
            .error_for_status()?;
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            if u64::try_from(body.len() + chunk.len())? > MAX_INPUT {
                return Err("invalid engine health response".into());
            }
            body.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&body)?;
        if !value["lanes"].is_object() {
            return Err("invalid engine health response".into());
        }
        Ok(value)
    })
    .await?
}

async fn status(
    endpoint: SocketAddr,
    storage: &EngineStorage,
    launcher: &Path,
    target: Option<&Target>,
    inbox: &InboxTarget<'_>,
    key_file: Option<&Path>,
) -> Result<()> {
    let key = key_file.map_or_else(|| control_key(CONTROL_KEY), read_key_file);
    let host = target.and_then(|target| target.inbox().ok());
    let (observed, inbox_status, health) = tokio::join!(
        async {
            if let Some(host) = &host {
                host.provider_registration(path_string(launcher).ok()?)
                    .await
                    .ok()
            } else {
                target?.provider(launcher, false).ok()?.observe().await.ok()
            }
        },
        async { host.as_ref()?.inbox_status_with_favicon(inbox).await.ok() },
        async {
            match &key {
                Ok(key) => engine_health(endpoint, key)
                    .await
                    .ok()
                    .filter(|health| same_engine(health, storage)),
                Err(_) => None,
            }
        },
    );
    let (native_inbox, favicon) =
        inbox_status.map_or((None, None), |(state, icon)| (Some(state), icon));
    let engine_status = match key {
        Ok(_) if health.is_some() => "healthy",
        Ok(_) => "unverified",
        Err(_) => "credential unavailable",
    };
    let output = json!({
        "provider": NUCLEUS_RUST_PROVIDER,
        "registered": observed.map(|state| !matches!(state, ProviderRegistration::Absent | ProviderRegistration::Removing)),
        "registrationMatches": observed.map(|state| matches!(state, ProviderRegistration::Ready | ProviderRegistration::Registered)),
        "ready": observed.map(|state| state == ProviderRegistration::Ready),
        "launcher": launcher,
        "launcherVerified": local_launcher(launcher).is_ok_and(|launcher| launcher.is_some()),
        "engineHealth": engine_status,
        "inbox": {
            "threadId": INBOX_THREAD,
            "faviconPath": favicon,
            "state": native_inbox,
            "present": native_inbox.map(|state| state != InboxStatus::Missing),
            "pinned": native_inbox.map(|state| state == InboxStatus::Pinned),
            "sessionHealthy": health.as_ref().and_then(|health| {
                (health["engine"]["t3Endpoint"] == target?.endpoint.as_str())
                    .then(|| inbox_health(health))
                    .flatten()
                    .map(|healthy| healthy && native_inbox == Some(InboxStatus::Pinned))
            }),
        },
        "version": env!("CARGO_PKG_VERSION"),
        "storage": {
            "home": storage.home(),
            "placement": storage.placement(),
            "bargePaths": storage.barge_paths(),
            "database": storage.database().path(),
            "work": storage.work().path(),
            "scratch": storage.scratch().path(),
            "builds": storage.builds().path(),
            "backup": storage.backup().path(),
            "log": storage.log().path(),
        },
    });
    println!("{}", serde_json::to_string_pretty(&output)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn executable(path: &Path) {
        fs::write(path, "#!/bin/sh\nexit 0\n").expect("write fixture executable");
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).expect("fixture mode");
    }

    #[test]
    fn launcher_publication_is_private_idempotent_and_refuses_a_changed_file() {
        let directory = tempfile::tempdir().expect("profile");
        let home = directory.path().canonicalize().expect("canonical profile");
        let settings = SettingsFile::open(&home).expect("settings");
        let storage = settings.configured_storage().expect("storage");
        let launcher = storage.bin().path().join(LAUNCHER);
        let key = home.join("controller.key");
        fs::write(&key, "ab".repeat(32)).expect("key fixture");
        fs::set_permissions(&key, fs::Permissions::from_mode(0o600)).expect("key mode");
        let serve = home.join("serve 'engine'");
        let acp = home.join("nucleus-acp");
        executable(&serve);
        executable(&acp);
        let endpoint = SocketAddr::from((Ipv4Addr::LOCALHOST, 4319));

        let lock = install_launcher(&storage, endpoint, &launcher, &key, &serve, &acp, false)
            .expect("publish");
        assert!(
            install_launcher(&storage, endpoint, &launcher, &key, &serve, &acp, false).is_err()
        );
        drop(lock);
        let installed = local_launcher(&launcher)
            .expect("private launcher")
            .expect("present");
        let inode = fs::metadata(&launcher).expect("metadata").ino();
        install_launcher(&storage, endpoint, &launcher, &key, &serve, &acp, false).expect("repeat");
        assert_eq!(fs::metadata(&launcher).expect("metadata").ino(), inode);
        let script = String::from_utf8(installed).expect("script");
        assert!(script.contains("serve '\\''engine'\\''"));
        assert!(!script.contains(&"ab".repeat(32)));

        executable(&launcher);
        assert!(
            install_launcher(&storage, endpoint, &launcher, &key, &serve, &acp, false).is_err()
        );
        assert_eq!(
            fs::read_to_string(&launcher).expect("untouched"),
            "#!/bin/sh\nexit 0\n"
        );
        install_launcher(&storage, endpoint, &launcher, &key, &serve, &acp, true)
            .expect("adopt verified registration's launcher");
        assert_eq!(
            local_launcher(&launcher).unwrap().as_deref(),
            Some(script.as_bytes())
        );
    }

    #[tokio::test]
    async fn health_requires_local_authentication_and_the_exact_inbox() {
        use axum::{
            Json, Router,
            http::{HeaderMap, StatusCode},
            routing::get,
        };

        let router = Router::new().route(
            "/v1/health",
            get(|headers: HeaderMap| async move {
                let expected = format!("Bearer {}", "ab".repeat(32));
                if headers
                    .get("authorization")
                    .is_none_or(|key| key.as_bytes() != expected.as_bytes())
                {
                    return Err(StatusCode::UNAUTHORIZED);
                }
                Ok(Json(json!({
                    "lanes": {},
                    "inbox": {"enabled":true,"observed":true,"threadId":INBOX_THREAD},
                })))
            }),
        );
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("listen");
        let endpoint = listener.local_addr().expect("endpoint");
        let server = tokio::spawn(async {
            axum::serve(listener, router).await.expect("fixture");
        });
        assert!(engine_health(endpoint, &[0; 32]).await.is_err());
        let health = engine_health(endpoint, &[0xab; 32])
            .await
            .expect("authenticated health");
        assert_eq!(inbox_health(&health), Some(true));
        assert_eq!(
            inbox_health(&json!({"inbox":{"enabled":true,"observed":true,"threadId":"foreign"}})),
            None
        );
        server.abort();
    }
}
