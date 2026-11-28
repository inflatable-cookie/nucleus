use std::{
    collections::BTreeMap,
    path::Path,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use nucleus_core::profiles::{Capability, Effort, Profile, Provider, Weight};
use serde_json::{Value, json};

use crate::{HostError, ModelOption, RoleProfile, available};

#[derive(Debug, PartialEq)]
pub struct ProfileCatalog(Vec<Value>);

#[derive(Default)]
pub(crate) struct CatalogRevision {
    pub(crate) epoch: u64,
    last_good: Option<Arc<ProfileCatalog>>,
    read_at_ms: Option<u64>,
    current: bool,
    stale: bool,
    instances: Option<Value>,
}

impl CatalogRevision {
    pub(crate) fn apply(&mut self, event: &Value) -> bool {
        match event["type"].as_str() {
            Some("snapshot") => {
                self.instances = event.pointer("/config/settings/providerInstances").cloned();
                self.replace(ProfileCatalog::parse(event["config"].clone()).ok())
            }
            Some("providerStatuses") => self.replace(
                event
                    .pointer("/payload/providers")
                    .and_then(Value::as_array)
                    .and_then(|providers| ProfileCatalog::from_providers(providers.clone()).ok()),
            ),
            Some("settingsUpdated") => {
                if let Some(instances) = event.pointer("/payload/settings/providerInstances")
                    && self.instances.as_ref() != Some(instances)
                {
                    self.instances = Some(instances.clone());
                    return self.invalidate();
                }
                false
            }
            _ => false,
        }
    }

    pub(crate) fn current(&self) -> Option<Arc<ProfileCatalog>> {
        self.current.then(|| self.last_good.clone()).flatten()
    }

    pub(crate) fn replace(&mut self, catalog: Option<ProfileCatalog>) -> bool {
        let Some(catalog) = catalog else {
            return self.invalidate();
        };
        self.epoch += 1;
        let changed = !self.current || self.last_good.as_deref() != Some(&catalog);
        if changed {
            self.last_good = Some(Arc::new(catalog));
        }
        self.read_at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()
            .and_then(|duration| duration.as_millis().try_into().ok());
        self.current = true;
        self.stale = false;
        changed
    }

    pub(crate) fn invalidate(&mut self) -> bool {
        self.epoch += 1;
        self.current = false;
        !std::mem::replace(&mut self.stale, true)
    }

    pub(crate) fn board_view(&self) -> Value {
        let status = if self.current {
            "current"
        } else if self.stale {
            "stale"
        } else {
            "pending"
        };
        json!({
            "status": status,
            "readAtMs": self.read_at_ms,
            "providers": self.last_good.as_deref().map(ProfileCatalog::board_providers),
        })
    }
}

fn fields(value: &Value, keys: &[&str]) -> Value {
    Value::Object(
        keys.iter()
            .filter_map(|key| Some(((*key).to_owned(), value.get(key)?.clone())))
            .collect(),
    )
}

fn list(value: &Value, project: impl FnMut(&Value) -> Value) -> Value {
    value.as_array().map_or(Value::Null, |rows| {
        Value::Array(rows.iter().map(project).collect())
    })
}

fn board_provider(provider: &Value) -> Value {
    let mut view = fields(
        provider,
        &[
            "instanceId",
            "driver",
            "enabled",
            "status",
            "supportedRuntimeModes",
        ],
    );
    view["models"] = list(&provider["models"], |model| {
        let mut view = fields(model, &["slug", "name"]);
        if let Some(options) = model.pointer("/capabilities/optionDescriptors") {
            view["capabilities"] = json!({
                "optionDescriptors": list(options, |option| {
                    let mut view = fields(
                        option,
                        &["type", "id", "label", "description", "currentValue", "role"],
                    );
                    if let Some(choices) = option.get("options") {
                        view["options"] = list(choices, |choice|
                            fields(choice, &["id", "label", "description", "isDefault"])
                        );
                    }
                    view
                })
            });
        }
        view
    });
    view
}

pub struct ProfileOffer {
    native: RoleProfile,
    efforts: Vec<(Effort, ModelOption)>,
}

impl ProfileOffer {
    #[must_use]
    pub fn instance(&self) -> &str {
        &self.native.instance_id
    }

    pub fn efforts(&self) -> impl Iterator<Item = Effort> + '_ {
        self.efforts.iter().map(|(effort, _)| *effort)
    }

    /// Translate the exact effort chosen by the profile policy.
    ///
    /// # Errors
    /// Returns an error if the model did not offer the effort.
    pub fn resolve(&self, effort: Option<Effort>) -> Result<RoleProfile, HostError> {
        let mut native = self.native.clone();
        if let Some(effort) = effort {
            let (_, option) = self
                .efforts
                .iter()
                .find(|(offered, _)| *offered == effort)
                .ok_or(HostError::Configuration)?;
            native.options.push(option.clone());
        }
        Ok(native)
    }
}

impl ProfileCatalog {
    fn board_providers(&self) -> Vec<Value> {
        self.0.iter().map(board_provider).collect()
    }

    pub(super) fn parse(mut config: Value) -> Result<Self, HostError> {
        if config
            .pointer("/environment/orchestrationProtocolVersion")
            .and_then(Value::as_u64)
            != Some(2)
        {
            return Err(HostError::Protocol);
        }
        let Value::Array(providers) = config["providers"].take() else {
            return Err(HostError::Protocol);
        };
        Self::from_providers(providers)
    }

    fn from_providers(providers: Vec<Value>) -> Result<Self, HostError> {
        if !providers.is_empty()
            && !providers.iter().any(|provider| {
                provider["instanceId"].is_string()
                    && provider["enabled"].is_boolean()
                    && provider["status"].is_string()
                    && provider["models"].is_array()
            })
        {
            return Err(HostError::Protocol);
        }
        Ok(Self(providers))
    }

    /// A skill this exact provider instance advertises as available to its agents.
    #[must_use]
    pub fn discovered_skill(&self, instance: &str, name: &str) -> Option<&Path> {
        let provider = self
            .0
            .iter()
            .find(|provider| provider["instanceId"] == instance && provider["enabled"] == true)?;
        let mut matches = provider["skills"].as_array()?.iter().filter(|skill| {
            skill["name"] == name && skill["enabled"] == true && skill["userInvocationOnly"] != true
        });
        let path = Path::new(matches.next()?["path"].as_str()?);
        (matches.next().is_none() && path.is_absolute() && path.ends_with("SKILL.md"))
            .then_some(path)
    }

    pub(crate) fn exhausted_reset(&self, routing: &crate::RunRouting, ended: u64) -> Option<u64> {
        let provider = self
            .0
            .iter()
            .find(|p| p["instanceId"] == routing.provider)?;
        let usage = provider.get("usageLimits")?;
        if usage
            .get("unavailable")
            .is_some_and(|error| !error.is_null())
        {
            return None;
        }
        let model = routing.model.as_str();
        let family = model.split('/').next()?;
        usage["windows"]
            .as_array()?
            .iter()
            .filter(|window| {
                let matches = |key: &str, expected: &str| {
                    window.get(key).map(|ids| {
                        ids.as_array()
                            .is_some_and(|ids| ids.iter().any(|id| id == expected))
                    })
                };
                let model_match = matches("modelIds", model);
                let family_match = matches("providerIds", family);
                (model_match.is_some() || family_match.is_some())
                    && model_match.unwrap_or(true)
                    && family_match.unwrap_or(true)
                    && window["usedPercent"]
                        .as_f64()
                        .is_some_and(|used| used >= 100.0)
            })
            .filter_map(|w| crate::task_row::timestamp_ms(w["resetsAt"].as_str()?).ok())
            .filter(|reset| *reset > ended)
            .max()
    }

    pub(crate) fn provider_family(&self, instance: &str) -> Option<Provider> {
        let driver = self
            .0
            .iter()
            .find(|entry| entry["instanceId"] == instance)?
            .get("driver")?
            .as_str()?;
        if driver == "claudeAgent" {
            return Some(Provider::Claude);
        }
        serde_json::from_value(Value::String(driver.into())).ok()
    }

    pub(super) fn supports_parent(&self, instance: &str) -> bool {
        let profile = RoleProfile {
            instance_id: instance.into(),
            model: "nucleus".into(),
            runtime_mode: "full-access".into(),
            options: Vec::new(),
        };
        self.0
            .iter()
            .any(|provider| provider["driver"] == "acpRegistry" && available(provider, &profile))
    }

    /// T3's model selection for a canonical choice, if a ready provider offers it.
    #[must_use]
    pub fn planner_selection(
        &self,
        provider: Provider,
        model: &str,
        effort: Option<Effort>,
    ) -> Option<Value> {
        let profile = Profile {
            id: "planner".into(),
            capability: Capability::default(),
            weight: Weight::default(),
            provider,
            model: model.into(),
            effort,
        };
        let offer = self.offer(&profile, None, "full-access", &BTreeMap::new())?;
        Some(offer.resolve(effort).ok()?.selection())
    }

    #[must_use]
    pub fn offer(
        &self,
        profile: &Profile,
        instance_id: Option<&str>,
        mode: &str,
        feature_values: &BTreeMap<String, Value>,
    ) -> Option<ProfileOffer> {
        let driver = driver(profile.provider);
        let runtime_mode = match mode {
            "supervised" => "approval-required",
            "accept-edits" => "auto-accept-edits",
            mode => mode,
        };
        self.0
            .iter()
            .filter_map(|provider| {
                let instance = provider["instanceId"].as_str()?;
                if instance.trim().is_empty()
                    || provider["driver"].as_str().unwrap_or(instance) != driver
                    || instance_id.is_some_and(|required| required != instance)
                {
                    return None;
                }
                let model = provider["models"]
                    .as_array()?
                    .iter()
                    .find(|model| model["slug"] == profile.model)?;
                let native = RoleProfile {
                    instance_id: instance.into(),
                    model: profile.model.clone(),
                    runtime_mode: runtime_mode.into(),
                    options: feature_options(profile.provider, model, feature_values)?,
                };
                available(provider, &native).then(|| {
                    let efforts = offered_efforts(profile.provider, model);
                    (
                        instance != driver,
                        instance,
                        ProfileOffer { native, efforts },
                    )
                })
            })
            .min_by_key(|(custom, instance, _)| (*custom, *instance))
            .map(|(_, _, offer)| offer)
    }
}

// T3's canonical carriers also appear in hosts/t3code/vocabulary.ts.
fn feature_options(
    provider: Provider,
    model: &Value,
    values: &BTreeMap<String, Value>,
) -> Option<Vec<ModelOption>> {
    let mut options = Vec::new();
    for (key, value) in values {
        let (id, value) = match (provider, key.as_str(), value.as_str()) {
            // Canonical defaults leave the provider's settings in effect, even
            // for models that don't expose the option.
            (_, "speed", Some("default"))
            | (_, "plan-mode" | "ultracode", Some("off"))
            | (_, "cyber-access", Some("standard")) => continue,
            (_, "speed" | "plan-mode" | "ultracode" | "cyber-access", _) if value.is_null() => {
                continue;
            }
            (Provider::Codex, "speed", Some("priority")) => ("serviceTier", json!("priority")),
            (Provider::Claude, "speed", Some("priority")) => ("fastMode", json!(true)),
            (Provider::Claude, "ultracode", Some("on")) => ("ultracode", json!(true)),
            _ => return None,
        };
        let descriptor = model
            .pointer("/capabilities/optionDescriptors")?
            .as_array()?
            .iter()
            .find(|descriptor| descriptor["id"] == id)?;
        let supported = match descriptor["type"].as_str() {
            Some("boolean") => value.is_boolean(),
            Some("select") => descriptor["options"]
                .as_array()
                .is_some_and(|choices| choices.iter().any(|choice| choice["id"] == value)),
            _ => false,
        };
        if !supported {
            return None;
        }
        options.push(ModelOption {
            id: id.into(),
            value,
        });
    }
    Some(options)
}

const fn driver(provider: Provider) -> &'static str {
    match provider {
        Provider::Codex => "codex",
        Provider::Claude => "claudeAgent",
        Provider::Pi => "pi",
        Provider::Grok => "grok",
        Provider::Cursor => "cursor",
        Provider::Opencode => "opencode",
        Provider::Copilot => "copilot",
        Provider::Omp => "omp",
        Provider::Antigravity => "antigravity",
        Provider::Muse => "muse",
        Provider::Fx => "fx",
        Provider::Kiro => "kiro",
    }
}

fn offered_efforts(provider: Provider, model: &Value) -> Vec<(Effort, ModelOption)> {
    let Some(descriptors) = model
        .pointer("/capabilities/optionDescriptors")
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    let selects = descriptors
        .iter()
        .filter(|option| option["type"] == "select");
    let preferred = match provider {
        Provider::Claude | Provider::Fx => Some("effort"),
        Provider::Pi => Some("thinking"),
        _ => None,
    };
    if let Some(preferred) = preferred
        && let Some(carrier) = selects.clone().find(|option| option["id"] == preferred)
    {
        return carrier_efforts(provider, carrier);
    }

    // A recognized ID alone does not make a select a thinking control.
    for option in selects {
        let marked = option["role"] == "reasoning";
        if marked
            || matches!(
                option["id"].as_str(),
                Some(
                    "reasoningEffort"
                        | "effort"
                        | "reasoning"
                        | "variant"
                        | "reasoning_effort"
                        | "thinking_level"
                        | "thinking"
                )
            )
        {
            let efforts = carrier_efforts(provider, option);
            if marked || !efforts.is_empty() {
                return efforts;
            }
        }
    }
    Vec::new()
}

fn carrier_efforts(provider: Provider, carrier: &Value) -> Vec<(Effort, ModelOption)> {
    let (Some(id), Some(choices)) = (carrier["id"].as_str(), carrier["options"].as_array()) else {
        return Vec::new();
    };
    choices
        .iter()
        .filter_map(|choice| {
            let value = choice["id"].as_str()?;
            let effort = match (provider, value) {
                (Provider::Claude, "ultrathink") => Effort::Ultra,
                (Provider::Claude | Provider::Fx, "off" | "minimal")
                | (Provider::Claude | Provider::Pi | Provider::Fx, "ultra") => return None,
                _ => serde_json::from_value(choice["id"].clone()).ok()?,
            };
            Some((
                effort,
                ModelOption {
                    id: id.into(),
                    value: json!(value),
                },
            ))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrated_options_and_modes_resolve_against_the_exact_native_instance() {
        let model = json!({
            "slug":"fixture-model",
            "capabilities":{"optionDescriptors":[
                {"id":"fastMode","type":"boolean"},
                {"id":"ultracode","type":"boolean"},
                {"id":"reasoningEffort","type":"select","options":[{"id":"high"}]},
                {"id":"effort","type":"select","options":[{"id":"ultrathink"},{"id":"minimal"}]}
            ]}
        });
        let catalog = ProfileCatalog::parse(json!({
            "environment":{"orchestrationProtocolVersion":2},
            "providers":[
                {"instanceId":"claudeAgent","enabled":true,"status":"ready","models":[model]},
                {"instanceId":"claude-secondary","driver":"claudeAgent","enabled":true,
                 "status":"ready","supportedRuntimeModes":["auto-accept-edits"],"models":[model]}
            ]
        }))
        .expect("T3 catalog");
        let profile = Profile {
            id: "imported".into(),
            capability: Capability::default(),
            weight: Weight::default(),
            provider: Provider::Claude,
            model: "fixture-model".into(),
            effort: Some(Effort::Ultra),
        };
        let mut features = BTreeMap::from([
            ("speed".into(), json!("priority")),
            ("ultracode".into(), json!("on")),
            ("cyber-access".into(), json!("standard")),
            ("plan-mode".into(), json!("off")),
        ]);
        let instance = Some("claude-secondary");
        let offer = catalog
            .offer(&profile, instance, "accept-edits", &features)
            .expect("native offer");
        assert_eq!(offer.efforts().collect::<Vec<_>>(), [Effort::Ultra]);
        let native = offer.resolve(profile.effort).expect("native launch");
        assert_eq!(native.instance_id, "claude-secondary");
        assert_eq!(native.runtime_mode, "auto-accept-edits");
        assert_eq!(
            json!(native.options),
            json!([
                {"id":"fastMode","value":true},
                {"id":"ultracode","value":true},
                {"id":"effort","value":"ultrathink"}
            ])
        );
        assert!(
            catalog
                .offer(&profile, instance, "supervised", &features)
                .is_none()
        );
        assert!(
            catalog
                .offer(&profile, Some("missing"), "accept-edits", &features)
                .is_none()
        );
        features.insert("speed".into(), json!("default"));
        features.insert("ultracode".into(), json!("off"));
        let native = catalog
            .offer(&profile, instance, "accept-edits", &features)
            .expect("canonical defaults are supported")
            .resolve(None)
            .expect("default launch");
        assert!(native.options.is_empty());
        features.insert("plan-mode".into(), json!("on"));
        assert!(
            catalog
                .offer(&profile, instance, "accept-edits", &features)
                .is_none()
        );
    }

    #[test]
    fn generic_thinking_uses_the_first_reasoning_select_with_a_known_level_or_role() {
        let model = json!({
            "capabilities":{"optionDescriptors":[
                {"id":"variant","type":"select","options":[{"id":"plain"}]},
                {"id":"thought_level","type":"select","role":"reasoning",
                 "options":[{"id":"high"}]},
                {"id":"reasoningEffort","type":"select","options":[{"id":"medium"}]}
            ]}
        });
        let efforts = offered_efforts(Provider::Codex, &model);
        assert_eq!(
            efforts,
            [(
                Effort::High,
                ModelOption {
                    id: "thought_level".into(),
                    value: json!("high"),
                },
            )]
        );
    }
}

#[cfg(test)]
mod exhausted_window_tests {
    use super::*;

    #[test]
    fn reset_belongs_to_the_exhausted_subscription_and_observed_model() {
        let first = "2026-12-01T09:00:00Z";
        let last = "2026-12-05T17:24:37Z";
        let later = "2099-01-01T00:00:00Z";
        let catalog = ProfileCatalog(vec![
            json!({"instanceId":"own","usageLimits":{"windows":[
                {"usedPercent":100,"providerIds":["family"],"resetsAt":first},
                {"usedPercent":100,"modelIds":["family/model"],"resetsAt":last},
                {"usedPercent":100,"resetsAt":later},
                {"usedPercent":100,"modelIds":["sibling"],"providerIds":["family"],"resetsAt":later},
                {"usedPercent":99,"providerIds":["family"],"resetsAt":later}
            ]}}),
            json!({"instanceId":"other","usageLimits":{"windows":[
                {"usedPercent":100,"modelIds":["family/model"],"resetsAt":later}
            ]}}),
        ]);
        let mut selected = crate::RunRouting {
            provider: "own".into(),
            model: "family/model".into(),
        };
        let reset = crate::task_row::timestamp_ms(last).unwrap();
        assert_eq!(catalog.exhausted_reset(&selected, 0), Some(reset));
        assert_eq!(catalog.exhausted_reset(&selected, reset), None);
        selected.model = "another/model".into();
        assert_eq!(catalog.exhausted_reset(&selected, 0), None);
    }
}
