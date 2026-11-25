//! Operator-owned GitHub accounts. Settings contain identity metadata and role selections.

#[cfg(test)]
mod tests;
mod transport;

use std::{
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant, SystemTime},
};

use longhorn_core::{CredentialSlot, CredentialStore};
use longhorn_credential_keyring::KeyringCredentialStore;
use longhorn_git_workspace::{
    ACCESS_REFRESH_SKEW, CredentialScope, CredentialStoreReading, GithubAuthFailure,
    MAX_DEVICE_WAIT, TokenGrant, force_refresh_token, fresh_access_token, read_credential_presence,
    read_grant, sign_out, write_grant,
};
use nucleus_store::{
    GitHubAccount, GitHubAccountSettings, SettingsFile, SettingsSnapshot, StorageError,
};
use secrecy::{ExposeSecret as _, SecretString};
use serde::Serialize;
use sha2::{Digest as _, Sha256};
use thiserror::Error;
use transport::Transport;

const CONFIRM_WINDOW: Duration = Duration::from_secs(300);
const FLOW_WINDOW: Duration = Duration::from_secs(MAX_DEVICE_WAIT.as_secs() + 30);
const SERVICE_NAME: &str = "nucleus.github-accounts";
// Public registration for inflatable-cookie-nucleus. Device-issued grants refresh without a client secret.
const GITHUB_APP_CLIENT_ID: &str = "Iv23liRsqJ59EsNDdtiu";
type LegacyReader = fn(&str) -> Result<SecretString, AccountError>;

#[derive(Debug, Error)]
pub enum AccountError {
    #[error("GitHub account settings changed. Reload and try again.")]
    Conflict,
    #[error("GitHub account settings are unavailable.")]
    Settings,
    #[error("This GitHub account is no longer saved.")]
    MissingAccount,
    #[error("This GitHub sign-in is no longer available. Start again.")]
    MissingFlow,
    #[error("A GitHub sign-in is already in progress. Cancel it first.")]
    FlowActive,
    #[error("This GitHub sign-in is waiting for identity verification.")]
    NotReady,
    #[error("GitHub confirmation is already saving. Wait for it to finish.")]
    Saving,
    #[error("Unlock the operating-system keychain, then retry.")]
    Keychain,
    #[error("GitHub account storage is unavailable on this platform. Use installed gh.")]
    Unsupported,
    #[error("This build has no GitHub App registration. Contact the operator.")]
    Registration,
    #[error("GitHub could not verify the account identity. Sign in again.")]
    Identity,
    #[error("The selected GitHub account needs sign-in.")]
    NoGrant,
    #[error("GitHub sign-in expired. Sign in again.")]
    Expired,
    #[error("GitHub could not be reached. Retry when it is available.")]
    Offline,
    #[error("GitHub sign-in was declined.")]
    Denied,
    #[error("GitHub sign-in did not finish. Start again.")]
    Failed,
    #[error("Choose a valid GitHub organisation.")]
    Organisation,
    #[error("That organisation has no legacy reviewer credential.")]
    NoLegacyGrant,
    #[error("The worker role still selects this account.")]
    WorkerUsesAccount,
}

impl From<StorageError> for AccountError {
    fn from(error: StorageError) -> Self {
        match error {
            StorageError::SettingsConflict => Self::Conflict,
            _ => Self::Settings,
        }
    }
}

impl From<GithubAuthFailure> for AccountError {
    fn from(error: GithubAuthFailure) -> Self {
        match error {
            GithubAuthFailure::NotConfigured => Self::Registration,
            GithubAuthFailure::NotSignedIn => Self::NoGrant,
            GithubAuthFailure::CredentialStoreUnavailable => Self::Keychain,
            GithubAuthFailure::Offline => Self::Offline,
            GithubAuthFailure::Denied => Self::Denied,
            GithubAuthFailure::TimedOut | GithubAuthFailure::SignInExpired => Self::Expired,
            _ => Self::Failed,
        }
    }
}

/// A role's authenticated identity and access credential for one engine invocation.
pub struct ReviewerCredential {
    account: GitHubAccount,
    user_id: u64,
    access: SecretString,
}

impl ReviewerCredential {
    #[must_use]
    pub fn host(&self) -> &str {
        &self.account.host
    }

    #[must_use]
    pub fn user_id(&self) -> u64 {
        self.user_id
    }

    #[must_use]
    pub fn login(&self) -> &str {
        &self.account.login
    }

    #[must_use]
    pub fn access_token(&self) -> &str {
        self.access.expose_secret()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountView {
    #[serde(flatten)]
    account: GitHubAccount,
    presence: Presence,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
enum Presence {
    Present,
    Missing,
    Unavailable,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SettingsView {
    revision: String,
    accounts: Vec<AccountView>,
    worker_account_id: Option<String>,
    reviewer_account_id: Option<String>,
    can_sign_in: bool,
    can_import_reviewer: bool,
}

#[derive(Serialize)]
pub(crate) struct FlowView {
    id: String,
    #[serde(flatten)]
    status: PublicFlow,
}

#[derive(Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum PublicFlow {
    Starting,
    Waiting {
        verification_uri: String,
        user_code: String,
    },
    Confirm {
        account: GitHubAccount,
    },
    Failed {
        message: String,
    },
}

enum FlowStatus {
    Pending(PublicFlow),
    Verified {
        account: GitHubAccount,
        grant: TokenGrant,
        legacy: bool,
    },
    Saving(GitHubAccount),
    Failed(AccountError),
}

struct Flow {
    id: String,
    cancel: Arc<AtomicBool>,
    until: Instant,
    status: FlowStatus,
}

impl Flow {
    fn expired(&self) -> bool {
        Instant::now() >= self.until && !matches!(self.status, FlowStatus::Saving(_))
    }

    fn expire(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
        self.status = FlowStatus::Failed(AccountError::Expired);
    }

    fn view(&self) -> FlowView {
        let status = match &self.status {
            FlowStatus::Pending(PublicFlow::Waiting {
                verification_uri,
                user_code,
            }) => PublicFlow::Waiting {
                verification_uri: verification_uri.clone(),
                user_code: user_code.clone(),
            },
            FlowStatus::Pending(_) => PublicFlow::Starting,
            FlowStatus::Verified { account, .. } | FlowStatus::Saving(account) => {
                PublicFlow::Confirm {
                    account: account.clone(),
                }
            }
            FlowStatus::Failed(error) => PublicFlow::Failed {
                message: error.to_string(),
            },
        };
        FlowView {
            id: self.id.clone(),
            status,
        }
    }
}

/// Owns account grants and the one active sign-in for a profile.
pub struct GitHubAccounts {
    settings: SettingsFile,
    profile: String,
    store: Arc<dyn CredentialStore + Send + Sync>,
    storage_available: bool,
    client_id: Option<String>,
    legacy: Option<LegacyReader>,
    transport: Transport,
    mutations: Mutex<()>,
    flow: Mutex<Option<Flow>>,
}

impl GitHubAccounts {
    pub(crate) fn new(settings: SettingsFile) -> Self {
        Self {
            profile: profile_key(&settings),
            settings,
            store: Arc::new(KeyringCredentialStore::new(SERVICE_NAME)),
            storage_available: cfg!(any(target_os = "macos", target_os = "windows")),
            client_id: Some(GITHUB_APP_CLIENT_ID.to_owned()),
            legacy: legacy_reader(),
            transport: Transport::github(),
            mutations: Mutex::new(()),
            flow: Mutex::new(None),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_fixture(settings: SettingsFile, origin: &str) -> Self {
        Self {
            profile: profile_key(&settings),
            settings,
            store: Arc::new(longhorn_core::MemoryCredentialStore::new()),
            storage_available: true,
            client_id: Some("fixture-app".to_owned()),
            legacy: None,
            transport: Transport::loopback(origin),
            mutations: Mutex::new(()),
            flow: Mutex::new(None),
        }
    }

    #[cfg(test)]
    pub(crate) fn seed_reviewer_fixture(
        &self,
        account: &GitHubAccount,
        access: &str,
    ) -> Result<(), AccountError> {
        let revision = self.settings.read::<GitHubAccountSettings>()?.revision;
        self.save_verified(
            &revision,
            account,
            &TokenGrant {
                access_token: SecretString::from(access.to_owned()),
                access_expires_at: None,
                refresh_token: None,
                refresh_expires_at: None,
            },
            false,
        )?;
        Ok(())
    }

    /// Resolve the review identity. An unset role is the sole installed-gh fallback.
    ///
    /// # Errors
    /// Returns an actionable refusal for a configured account that cannot be used.
    pub async fn reviewer_credential(
        self: &Arc<Self>,
    ) -> Result<Option<ReviewerCredential>, AccountError> {
        self.blocking(|accounts| {
            let _guard = lock(&accounts.mutations);
            let saved = accounts.settings.read::<GitHubAccountSettings>()?.value;
            saved
                .reviewer_account_id
                .as_deref()
                .map(|id| accounts.resolve(&saved, id, None))
                .transpose()
        })
        .await
    }

    /// Refresh the same reviewer after a definite authentication rejection.
    ///
    /// # Errors
    /// Returns a refusal when that exact saved account no longer has a usable grant.
    pub async fn refresh_rejected(
        self: &Arc<Self>,
        credential: &ReviewerCredential,
    ) -> Result<ReviewerCredential, AccountError> {
        let id = credential.account.id();
        let rejected = credential.access.clone();
        self.blocking(move |accounts| {
            let _guard = lock(&accounts.mutations);
            let saved = accounts.settings.read::<GitHubAccountSettings>()?.value;
            accounts.resolve(&saved, &id, Some(&rejected))
        })
        .await
    }

    fn resolve(
        &self,
        saved: &GitHubAccountSettings,
        id: &str,
        rejected: Option<&SecretString>,
    ) -> Result<ReviewerCredential, AccountError> {
        let account = find_account(saved, id)?.clone();
        let user_id = account.numeric_id().ok_or(AccountError::Identity)?;
        let slot = self.slot(user_id)?;
        let scope = self.scope(&slot);
        let access = if let Some(client_id) = &self.client_id {
            let client = self.transport.token_client()?;
            match rejected {
                Some(rejected) => force_refresh_token(&scope, client_id, &client, rejected)?,
                None => {
                    fresh_access_token(&scope, client_id, &client, SystemTime::now(), false, None)?
                }
            }
            .ok_or(AccountError::NoGrant)?
        } else {
            let grant = read_grant(&scope)?.ok_or(AccountError::NoGrant)?;
            let usable = rejected.is_none()
                && grant
                    .access_expires_at
                    .is_none_or(|expiry| expiry > SystemTime::now() + ACCESS_REFRESH_SKEW);
            if !usable {
                return Err(if grant.refresh_token.is_some() {
                    AccountError::Registration
                } else {
                    AccountError::Expired
                });
            }
            grant.access_token
        };
        Ok(ReviewerCredential {
            account,
            user_id,
            access,
        })
    }

    pub(crate) async fn view(self: &Arc<Self>) -> Result<SettingsView, AccountError> {
        self.blocking(|accounts| {
            let _guard = lock(&accounts.mutations);
            accounts.settings_view(accounts.settings.read()?)
        })
        .await
    }

    fn settings_view(
        &self,
        snapshot: SettingsSnapshot<GitHubAccountSettings>,
    ) -> Result<SettingsView, AccountError> {
        let mut accounts = Vec::new();
        for account in snapshot.value.accounts {
            let slot = self.slot(account.numeric_id().ok_or(AccountError::Identity)?)?;
            let presence = match read_credential_presence(&self.scope(&slot)) {
                CredentialStoreReading::Present => Presence::Present,
                CredentialStoreReading::Missing => Presence::Missing,
                CredentialStoreReading::Unavailable(_) => Presence::Unavailable,
            };
            accounts.push(AccountView { account, presence });
        }
        Ok(SettingsView {
            revision: snapshot.revision,
            accounts,
            worker_account_id: snapshot.value.worker_account_id,
            reviewer_account_id: snapshot.value.reviewer_account_id,
            can_sign_in: self.storage_available && self.client_id.is_some(),
            can_import_reviewer: self.legacy.is_some(),
        })
    }

    pub(crate) async fn select(
        self: &Arc<Self>,
        revision: String,
        id: Option<String>,
    ) -> Result<SettingsView, AccountError> {
        self.blocking(move |accounts| {
            let _guard = lock(&accounts.mutations);
            let saved = accounts.at_revision(&revision)?;
            if let Some(id) = &id {
                find_account(&saved, id)?;
            }
            let (snapshot, _) =
                accounts
                    .settings
                    .edit::<GitHubAccountSettings>(&revision, |saved| {
                        saved.reviewer_account_id = id;
                        Ok(())
                    })?;
            accounts.settings_view(snapshot)
        })
        .await
    }

    pub(crate) async fn sign_out(
        self: &Arc<Self>,
        revision: String,
        id: String,
    ) -> Result<SettingsView, AccountError> {
        self.blocking(move |accounts| {
            let _guard = lock(&accounts.mutations);
            let saved = accounts.at_revision(&revision)?;
            let account = find_account(&saved, &id)?;
            if saved.worker_account_id.as_deref() == Some(id.as_str()) {
                return Err(AccountError::WorkerUsesAccount);
            }
            let slot = accounts.slot(account.numeric_id().ok_or(AccountError::Identity)?)?;
            sign_out(&accounts.scope(&slot))?;
            let (snapshot, _) =
                accounts
                    .settings
                    .edit::<GitHubAccountSettings>(&revision, |saved| {
                        if saved.reviewer_account_id.as_deref() == Some(id.as_str()) {
                            saved.reviewer_account_id = None;
                        }
                        saved.accounts.retain(|account| account.id() != id);
                        Ok(())
                    })?;
            accounts.settings_view(snapshot)
        })
        .await
    }

    pub(crate) fn start_device(self: &Arc<Self>) -> Result<FlowView, AccountError> {
        if !self.storage_available {
            return Err(AccountError::Unsupported);
        }
        let client_id = self.client_id.clone().ok_or(AccountError::Registration)?;
        self.start(move |accounts, id, cancel| {
            let grant = accounts.transport.device_flow(
                &client_id,
                cancel,
                |verification_uri, user_code| {
                    if let Some(flow) = lock(&accounts.flow).as_mut().filter(|flow| flow.id == id) {
                        flow.status = FlowStatus::Pending(PublicFlow::Waiting {
                            verification_uri,
                            user_code,
                        });
                    }
                },
            )?;
            accounts.verify_grant(grant, false, cancel)
        })
    }

    pub(crate) fn start_import(
        self: &Arc<Self>,
        organisation: String,
    ) -> Result<FlowView, AccountError> {
        let reader = self.legacy.ok_or(AccountError::Unsupported)?;
        if !(1..=39).contains(&organisation.len())
            || !organisation.as_bytes()[0].is_ascii_alphanumeric()
            || !organisation.as_bytes()[organisation.len() - 1].is_ascii_alphanumeric()
            || !organisation
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err(AccountError::Organisation);
        }
        self.start(move |accounts, _, cancel| {
            let grant = TokenGrant {
                access_token: reader(&organisation)?,
                access_expires_at: None,
                refresh_token: None,
                refresh_expires_at: None,
            };
            accounts.verify_grant(grant, true, cancel)
        })
    }

    fn verify_grant(
        &self,
        grant: TokenGrant,
        legacy: bool,
        cancel: &AtomicBool,
    ) -> Result<FlowStatus, AccountError> {
        if cancel.load(Ordering::Relaxed) {
            return Err(AccountError::MissingFlow);
        }
        let account = self.transport.validate_account(&grant.access_token)?;
        Ok(FlowStatus::Verified {
            account,
            grant,
            legacy,
        })
    }

    fn start(
        self: &Arc<Self>,
        run: impl FnOnce(&Self, &str, &AtomicBool) -> Result<FlowStatus, AccountError> + Send + 'static,
    ) -> Result<FlowView, AccountError> {
        let mut current = lock(&self.flow);
        if let Some(flow) = current.as_mut() {
            if flow.expired() {
                flow.expire();
            }
            if !matches!(flow.status, FlowStatus::Failed(_)) {
                return Err(AccountError::FlowActive);
            }
        }
        let mut random = [0; 16];
        getrandom::fill(&mut random).map_err(|_| AccountError::Failed)?;
        let id = hex::encode(random);
        let cancel = Arc::new(AtomicBool::new(false));
        let flow = Flow {
            id: id.clone(),
            cancel: Arc::clone(&cancel),
            until: Instant::now() + FLOW_WINDOW,
            status: FlowStatus::Pending(PublicFlow::Starting),
        };
        let view = flow.view();
        *current = Some(flow);

        let this = Arc::clone(self);
        let complete = id.clone();
        let job = tokio::task::spawn_blocking(move || run(&this, &id, &cancel));
        let this = Arc::clone(self);
        tokio::spawn(async move {
            let result = job.await.unwrap_or(Err(AccountError::Failed));
            {
                let mut guard = lock(&this.flow);
                let Some(flow) = guard.as_mut().filter(|flow| flow.id == complete) else {
                    return;
                };
                if flow.expired() {
                    flow.expire();
                    return;
                }
                match result {
                    Ok(status) => flow.status = status,
                    Err(error) => {
                        flow.status = FlowStatus::Failed(error);
                        return;
                    }
                }
                flow.until = Instant::now() + CONFIRM_WINDOW;
            }
            tokio::time::sleep(CONFIRM_WINDOW).await;
            if let Some(flow) = lock(&this.flow)
                .as_mut()
                .filter(|flow| flow.id == complete && flow.expired())
            {
                flow.expire();
            }
        });
        Ok(view)
    }

    pub(crate) fn flow_view(&self, id: &str) -> Result<FlowView, AccountError> {
        let mut guard = lock(&self.flow);
        let flow = guard
            .as_mut()
            .filter(|flow| flow.id == id)
            .ok_or(AccountError::MissingFlow)?;
        if flow.expired() && !matches!(flow.status, FlowStatus::Failed(_)) {
            flow.expire();
        }
        Ok(flow.view())
    }

    pub(crate) fn cancel(&self, id: &str) -> Result<(), AccountError> {
        let mut guard = lock(&self.flow);
        let flow = guard
            .as_ref()
            .filter(|flow| flow.id == id)
            .ok_or(AccountError::MissingFlow)?;
        if matches!(flow.status, FlowStatus::Saving(_)) {
            return Err(AccountError::Saving);
        }
        flow.cancel.store(true, Ordering::Relaxed);
        *guard = None;
        Ok(())
    }

    pub(crate) async fn confirm(
        self: &Arc<Self>,
        id: String,
        revision: String,
    ) -> Result<SettingsView, AccountError> {
        self.blocking(move |accounts| {
            let (account, grant, legacy) = accounts.claim_confirmation(&id)?;
            let result = accounts.save_verified(&revision, &account, &grant, legacy);
            let mut guard = lock(&accounts.flow);
            if let Some(flow) = guard.as_mut().filter(|flow| flow.id == id) {
                if result.is_ok() {
                    *guard = None;
                } else if Instant::now() >= flow.until {
                    flow.expire();
                } else {
                    flow.status = FlowStatus::Verified {
                        account,
                        grant,
                        legacy,
                    };
                }
            }
            result
        })
        .await
    }

    fn claim_confirmation(
        &self,
        id: &str,
    ) -> Result<(GitHubAccount, TokenGrant, bool), AccountError> {
        let mut guard = lock(&self.flow);
        let flow = guard
            .as_mut()
            .filter(|flow| flow.id == id)
            .ok_or(AccountError::MissingFlow)?;
        if flow.expired() {
            flow.expire();
            return Err(AccountError::Expired);
        }
        let account = match &flow.status {
            FlowStatus::Verified { account, .. } => account.clone(),
            FlowStatus::Saving(_) => return Err(AccountError::Saving),
            _ => return Err(AccountError::NotReady),
        };
        match std::mem::replace(&mut flow.status, FlowStatus::Saving(account)) {
            FlowStatus::Verified {
                account,
                grant,
                legacy,
            } => Ok((account, grant, legacy)),
            _ => Err(AccountError::NotReady),
        }
    }

    fn save_verified(
        &self,
        revision: &str,
        account: &GitHubAccount,
        grant: &TokenGrant,
        legacy: bool,
    ) -> Result<SettingsView, AccountError> {
        let _guard = lock(&self.mutations);
        let mut saved = self.at_revision(revision)?;
        let id = account.id();
        let slot = self.slot(account.numeric_id().ok_or(AccountError::Identity)?)?;
        let scope = self.scope(&slot);
        let previous = read_grant(&scope)?;
        let replace = !legacy || previous.is_none();
        if replace {
            write_grant(&scope, grant)?;
        }
        let result = (|| {
            if legacy {
                let stored = read_grant(&scope)?.ok_or(AccountError::NoGrant)?;
                if self.transport.validate_account(&stored.access_token)?.id() != id {
                    return Err(AccountError::Identity);
                }
            }
            saved.accounts.retain(|existing| existing.id() != id);
            saved.accounts.push(account.clone());
            saved.reviewer_account_id = Some(id);
            let (snapshot, _) = self
                .settings
                .edit::<GitHubAccountSettings>(revision, |value| {
                    *value = saved;
                    Ok(())
                })?;
            Ok(snapshot)
        })();
        if result.is_err() && replace {
            if let Some(previous) = previous {
                write_grant(&scope, &previous)?;
            } else {
                sign_out(&scope)?;
            }
        }
        self.settings_view(result?)
    }

    fn at_revision(&self, revision: &str) -> Result<GitHubAccountSettings, AccountError> {
        let snapshot = self.settings.read::<GitHubAccountSettings>()?;
        if snapshot.revision != revision {
            return Err(AccountError::Conflict);
        }
        Ok(snapshot.value)
    }

    fn slot(&self, user_id: u64) -> Result<CredentialSlot, AccountError> {
        CredentialSlot::consumer_scoped("nucleus", &self.profile, &format!("github-com-{user_id}"))
            .map_err(|_| AccountError::Identity)
    }

    fn scope<'a>(&'a self, slot: &'a CredentialSlot) -> CredentialScope<'a> {
        CredentialScope {
            store: &*self.store,
            slot,
        }
    }

    async fn blocking<T: Send + 'static>(
        self: &Arc<Self>,
        run: impl FnOnce(&Self) -> Result<T, AccountError> + Send + 'static,
    ) -> Result<T, AccountError> {
        let this = Arc::clone(self);
        tokio::task::spawn_blocking(move || run(&this))
            .await
            .map_err(|_| AccountError::Failed)?
    }
}

fn lock<T>(value: &Mutex<T>) -> MutexGuard<'_, T> {
    value
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn profile_key(settings: &SettingsFile) -> String {
    hex::encode(Sha256::digest(
        settings.home().as_os_str().as_encoded_bytes(),
    ))
}

fn find_account<'a>(
    saved: &'a GitHubAccountSettings,
    id: &str,
) -> Result<&'a GitHubAccount, AccountError> {
    saved
        .accounts
        .iter()
        .find(|account| account.id() == id)
        .ok_or(AccountError::MissingAccount)
}

fn legacy_reader() -> Option<LegacyReader> {
    #[cfg(target_os = "macos")]
    {
        Some(read_macos_legacy)
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

#[cfg(target_os = "macos")]
fn read_macos_legacy(organisation: &str) -> Result<SecretString, AccountError> {
    // Longhorn's consumer slots cannot address the historical bare organisation key.
    // Only this legacy read uses macOS security. New grants use Longhorn for every operation.
    for service in ["nucleus.github-reviewer", "paseo-queue.github-reviewer"] {
        let output = std::process::Command::new("/usr/bin/security")
            .env_clear()
            .args([
                "find-generic-password",
                "-s",
                service,
                "-a",
                organisation,
                "-w",
            ])
            .output()
            .map_err(|_| AccountError::Keychain)?;
        match output.status.code() {
            Some(0) => {
                let token = String::from_utf8(output.stdout).map_err(|_| AccountError::Identity)?;
                let secret = SecretString::from(token.trim().to_owned());
                if secret.expose_secret().is_empty() {
                    return Err(AccountError::Identity);
                }
                return Ok(secret);
            }
            // The command returns errSecItemNotFound (-25300) as an 8-bit status.
            Some(44) => {}
            _ => return Err(AccountError::Keychain),
        }
    }
    Err(AccountError::NoLegacyGrant)
}
