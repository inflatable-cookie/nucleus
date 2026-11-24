use std::time::Duration;

use serde_json::{Value, json};
use tokio::time::{sleep, timeout};

use crate::{HostError, ProfileCatalog, Read, Reply, Rpc, T3};

pub const NUCLEUS_RUST_PROVIDER: &str = "nucleus-rust";
const DRIVER: &str = "acpRegistry";
const READBACK_TIMEOUT: Duration = Duration::from_mins(1);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderRegistration {
    Absent,
    /// Settings no longer contain the instance, but the runtime row remains.
    Removing,
    Adoptable,
    Conflict,
    Registered,
    Ready,
}

#[derive(Debug, thiserror::Error)]
pub enum ProviderSetupError {
    #[error(transparent)]
    Host(#[from] HostError),
    #[error("the nucleus-rust provider does not match this profile's registration")]
    Conflict,
    #[error("nucleus-rust uses another local launcher; pass --adopt to change it")]
    AdoptionRequired,
    #[error("T3 did not confirm the provider change; run t3 status to inspect it")]
    Unconfirmed,
}

/// Operator-only provider registration. The service's runtime adapter has no
/// access to this credential or to the settings mutation.
pub struct ProviderSetup {
    rpc: Rpc,
    instance: Value,
}

impl ProviderSetup {
    /// Connect to T3 with a provider-management credential.
    ///
    /// # Errors
    /// Returns an error for an invalid endpoint, credential or launcher.
    pub fn new(endpoint: &str, bearer: &str, launcher: &str) -> Result<Self, HostError> {
        Ok(Self {
            rpc: Rpc::new(endpoint, bearer)?,
            instance: wanted(launcher)?,
        })
    }

    /// Read the saved registration and the runtime readiness of this exact ID.
    ///
    /// # Errors
    /// Returns an error if T3 cannot provide an authoritative config.
    pub async fn observe(&self) -> Result<ProviderRegistration, ProviderSetupError> {
        observe_registration(&self.rpc, &self.instance)
            .await
            .map_err(Into::into)
    }

    /// Create an absent instance or explicitly adopt its existing local launcher.
    ///
    /// # Errors
    /// Returns an error on a conflict, unreadable config or unconfirmed readiness.
    pub async fn install(&self, adopt: bool) -> Result<(), ProviderSetupError> {
        match self.observe().await? {
            ProviderRegistration::Ready => return Ok(()),
            ProviderRegistration::Conflict => return Err(ProviderSetupError::Conflict),
            ProviderRegistration::Adoptable if !adopt => {
                return Err(ProviderSetupError::AdoptionRequired);
            }
            ProviderRegistration::Adoptable => {
                self.mutate(json!({
                    "operation": "upsert", "instanceId": NUCLEUS_RUST_PROVIDER,
                    "instance": self.instance,
                }))
                .await?;
            }
            ProviderRegistration::Removing => return Err(ProviderSetupError::Unconfirmed),
            ProviderRegistration::Registered => {}
            ProviderRegistration::Absent => {
                self.mutate(json!({
                    "operation": "create", "instanceId": NUCLEUS_RUST_PROVIDER,
                    "instance": self.instance,
                }))
                .await?;
            }
        }
        self.wait_for(ProviderRegistration::Ready).await
    }

    /// Recheck this exact registration immediately before removing it.
    ///
    /// # Errors
    /// Returns an error on a conflict, unreadable config or unconfirmed removal.
    pub async fn uninstall(&self) -> Result<(), ProviderSetupError> {
        match self.observe().await? {
            ProviderRegistration::Absent => return Ok(()),
            ProviderRegistration::Removing => {
                return self.wait_for(ProviderRegistration::Absent).await;
            }
            ProviderRegistration::Conflict | ProviderRegistration::Adoptable => {
                return Err(ProviderSetupError::Conflict);
            }
            ProviderRegistration::Registered | ProviderRegistration::Ready => {}
        }
        // T3 has no compare-and-remove operation. An independent settings
        // writer can still change the instance between these two calls.
        self.mutate(json!({"operation": "remove", "instanceId": NUCLEUS_RUST_PROVIDER}))
            .await?;
        self.wait_for(ProviderRegistration::Absent).await
    }

    async fn mutate(&self, mutation: Value) -> Result<(), ProviderSetupError> {
        // A create racing another installer can be rejected. Readback decides
        // whether the desired state was reached; never resend the mutation.
        let _ = self
            .rpc
            .call(
                "server.updateSettings",
                json!({"patch": {}, "providerInstanceMutation": mutation}),
                Read::One,
            )
            .await
            .map_err(|_| ProviderSetupError::Unconfirmed)?;
        Ok(())
    }

    async fn wait_for(&self, expected: ProviderRegistration) -> Result<(), ProviderSetupError> {
        timeout(READBACK_TIMEOUT, async {
            let mut delay = Duration::from_millis(500);
            for _ in 0..8 {
                let observed = self.observe().await?;
                if observed == expected {
                    return Ok(());
                }
                match observed {
                    ProviderRegistration::Conflict => return Err(ProviderSetupError::Conflict),
                    ProviderRegistration::Adoptable => return Err(ProviderSetupError::Unconfirmed),
                    _ => {}
                }
                sleep(delay).await;
                delay = (delay * 2).min(Duration::from_secs(8));
            }
            Err(ProviderSetupError::Unconfirmed)
        })
        .await
        .map_err(|_| ProviderSetupError::Unconfirmed)?
    }
}

impl T3 {
    /// Observe the exact local ACP registration using the existing RPC client.
    ///
    /// # Errors
    /// Returns an error for an invalid launcher or unavailable config.
    pub async fn provider_registration(
        &self,
        launcher: &str,
    ) -> Result<ProviderRegistration, HostError> {
        observe_registration(&self.rpc, &wanted(launcher)?).await
    }
}

fn wanted(launcher: &str) -> Result<Value, HostError> {
    if !std::path::Path::new(launcher).is_absolute() {
        return Err(HostError::Configuration);
    }
    Ok(json!({
        "driver": DRIVER,
        "displayName": "Nucleus Rust",
        "enabled": true,
        "config": {"source": "local", "commandPath": launcher},
    }))
}

async fn observe_registration(
    rpc: &Rpc,
    instance: &Value,
) -> Result<ProviderRegistration, HostError> {
    let Reply::Value(config) = rpc.call("server.getConfig", json!({}), Read::One).await? else {
        return Err(HostError::Protocol);
    };
    registration(config, instance)
}

fn registration(config: Value, instance: &Value) -> Result<ProviderRegistration, HostError> {
    use ProviderRegistration::{Absent, Adoptable, Conflict, Ready, Registered, Removing};
    let instances = config
        .pointer("/settings/providerInstances")
        .and_then(Value::as_object)
        .ok_or(HostError::Protocol)?;
    let providers = config["providers"].as_array().ok_or(HostError::Protocol)?;
    let mut matching = providers
        .iter()
        .filter(|provider| provider["instanceId"] == NUCLEUS_RUST_PROVIDER);
    let row = matching.next();
    let exact_row = row.is_none_or(|row| row["driver"] == DRIVER) && matching.next().is_none();
    let saved = instances.get(NUCLEUS_RUST_PROVIDER);
    let missing = saved.is_none();
    let row_missing = row.is_none();
    let exact_saved = saved == Some(instance);
    let adoptable = exact_row
        && !exact_saved
        && saved.is_some_and(|saved| {
            let Some(path) = saved["config"]["commandPath"].as_str() else {
                return false;
            };
            if !std::path::Path::new(path).is_absolute() {
                return false;
            }
            let mut with_launcher = instance.clone();
            with_launcher["config"]["commandPath"] = json!(path);
            saved == &with_launcher
        });
    let catalog = ProfileCatalog::parse(config)?;
    if missing && exact_row {
        return Ok(if row_missing { Absent } else { Removing });
    }
    if adoptable {
        return Ok(Adoptable);
    }
    if !exact_saved || !exact_row {
        return Ok(Conflict);
    }
    Ok(if catalog.supports_parent(NUCLEUS_RUST_PROVIDER) {
        Ready
    } else {
        Registered
    })
}
