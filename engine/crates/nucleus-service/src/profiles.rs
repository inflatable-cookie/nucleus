use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

use nucleus_core::{
    Action, Observation, Role, Run, Task, WaitReason,
    profiles::{
        Candidate, LaunchPolicy, ProfileLaunch, ProfileLaunchError, RotationCounts, UsageLevel,
        decide_profile_launch, decide_weighted_launch,
    },
};
use nucleus_hosts::{
    HostError, ProfileCatalog, ProfileOffer, ProviderLimit, RoleProfile, TaskHost,
    launch_provider_instance, snooze_deadline,
};
use nucleus_store::{DispatchMode, NamedProfile, Profiles, SubscriptionPause, TaskRow};

use crate::{Service, ServiceError, State, now_ms};

#[cfg(test)]
mod tests;

pub(super) struct SelectedLaunch {
    pub(super) intent: ProfileLaunch,
    pub(super) native: RoleProfile,
    pub(super) group: String,
    profiles: Arc<Profiles>,
    usage: UsageLevel,
}

pub(super) enum LaunchSelection {
    Fixture,
    Profile(Box<SelectedLaunch>),
    Paused,
}

/// Why a subscription group cannot launch, kept with the group that paused.
#[derive(Clone)]
pub(super) enum GroupPause {
    Manual { group: String },
    Until { group: String, reset: u64 },
}

impl GroupPause {
    pub(super) fn remaining(&self, now: u64) -> bool {
        match self {
            Self::Manual { .. } => true,
            Self::Until { reset, .. } => *reset > now,
        }
    }

    fn group(&self) -> &str {
        match self {
            Self::Manual { group } | Self::Until { group, .. } => group,
        }
    }

    fn reset(&self) -> Option<u64> {
        match self {
            Self::Manual { .. } => None,
            Self::Until { reset, .. } => Some(*reset),
        }
    }

    /// The task's wait cause: the paused group and when it resets.
    pub(super) fn cause(&self) -> String {
        match self.reset() {
            Some(reset) => format!(
                "Paused: subscription group {} resets at {}.",
                self.group(),
                snooze_deadline(reset)
            ),
            None => format!(
                "Paused: subscription group {}. Resume it in Profiles.",
                self.group()
            ),
        }
    }
}

impl SelectedLaunch {
    pub(super) fn is_current(&self, state: &State) -> bool {
        state
            .settings
            .profiles
            .as_ref()
            .is_some_and(|profiles| Arc::ptr_eq(profiles, &self.profiles))
            && usage(state) == self.usage
    }
}

impl Service {
    pub(super) fn launch_profile<'a>(
        &'a self,
        role: Role,
        selection: Option<&'a SelectedLaunch>,
    ) -> Result<&'a RoleProfile, ServiceError> {
        selection
            .map(|selected| &selected.native)
            .or_else(|| self.project.as_ref().map(|project| project.profile(role)))
            .ok_or(ServiceError::ProfileConfiguration)
    }

    pub(super) async fn select_launch(
        &self,
        task: &Task,
        observation: &Observation,
        role: Role,
        host: &impl TaskHost,
    ) -> Result<LaunchSelection, ServiceError> {
        {
            let mut state = self.state.lock().await;
            let mode = state
                .settings
                .dispatch
                .as_ref()
                .map_or(DispatchMode::Running, |dispatch| dispatch.mode);
            if !mode.allows_launch(task.first_launch()) {
                return Ok(LaunchSelection::Paused);
            }
            if state.settings.profiles.is_none() {
                let project = self
                    .project
                    .as_ref()
                    .ok_or(ServiceError::ProfileConfiguration)?;
                let group = &project.profile(role).instance_id;
                if let Some(pause) = state.group_pause(group, now_ms())? {
                    state.group_waits.insert(task.identity().id.clone(), pause);
                    return Ok(LaunchSelection::Paused);
                }
                state.group_waits.remove(&task.identity().id);
                return Ok(LaunchSelection::Fixture);
            }
        }
        if role == Role::Reviewer && task.threads().profile(Role::Worker).is_none() {
            return Err(ProfileLaunchError::OpaqueAuthor.into());
        }
        let catalog = host.profile_catalog().await?;
        let mut state = self.state.lock().await;
        select_profile(
            &mut state,
            task,
            observation,
            role,
            catalog,
            self.profile_runtime_mode(role),
        )
    }

    fn profile_runtime_mode(&self, role: Role) -> &str {
        self.project.as_ref().map_or("full-access", |project| {
            project.profile(role).runtime_mode.as_str()
        })
    }

    pub(super) fn effective_profile_groups<'a>(
        &self,
        profiles: &'a Profiles,
    ) -> BTreeMap<&'a str, String> {
        let catalog = self.host.cached_profile_catalog();
        let modes = [Role::Worker, Role::Reviewer].map(|role| self.profile_runtime_mode(role));
        profiles
            .profiles
            .iter()
            .filter_map(|profile| {
                let group = profile
                    .group
                    .as_deref()
                    .or(profile.provider_instance_id.as_deref())
                    .map(str::to_owned)
                    .or_else(|| {
                        let catalog = catalog.as_deref()?;
                        // Registry launches share one default mode. A legacy project can use
                        // different modes by role, so only present a single unambiguous group.
                        let mut groups = modes.into_iter().filter_map(|mode| {
                            profile_offer(catalog, profile, mode).map(|(_, group)| group)
                        });
                        let group = groups.next()?;
                        groups.all(|other| other == group).then_some(group)
                    })?;
                Some((profile.selection.id.as_str(), group))
            })
            .collect()
    }
}

fn profile_offer(
    catalog: &ProfileCatalog,
    profile: &NamedProfile,
    runtime_mode: &str,
) -> Option<(ProfileOffer, String)> {
    let offer = catalog.offer(
        &profile.selection,
        profile.provider_instance_id.as_deref(),
        profile.mode_id.as_deref().unwrap_or(runtime_mode),
        &profile.feature_values,
    )?;
    let group = profile
        .group
        .as_deref()
        .unwrap_or_else(|| offer.instance())
        .to_owned();
    Some((offer, group))
}

fn select_profile(
    state: &mut State,
    task: &Task,
    observation: &Observation,
    role: Role,
    catalog: &ProfileCatalog,
    runtime_mode: &str,
) -> Result<LaunchSelection, ServiceError> {
    let profiles = state
        .settings
        .profiles
        .as_ref()
        .ok_or(HostError::Configuration)?;
    let usage = usage(state);
    let resets = state.store.active_provider_pauses(now_ms())?;
    let mut offers = Vec::new();
    for profile in &profiles.profiles {
        if !profile.enabled || profile.selection.model.is_empty() {
            continue;
        }
        let Some((offer, group)) = profile_offer(catalog, profile, runtime_mode) else {
            continue;
        };
        let counts = state
            .store
            .rotation_counts(role, &profile.selection.id, &group);
        let efforts: Vec<_> = offer.efforts().collect();
        let pause = if profiles.paused_groups.contains(&group) {
            Some(GroupPause::Manual {
                group: group.clone(),
            })
        } else {
            resets.get(&group).map(|&reset| GroupPause::Until {
                group: group.clone(),
                reset,
            })
        };
        offers.push((&profile.selection, offer, efforts, group, counts, pause));
    }
    let mut candidates: Vec<_> = offers
        .iter()
        .map(|(profile, _, efforts, _, counts, pause)| Candidate {
            profile,
            enabled: true,
            available: true,
            group_available: pause.is_none(),
            supported_efforts: efforts,
            counts: counts.unwrap_or_default(),
        })
        .collect();
    let fallback = offers
        .iter()
        .any(|(_, _, _, _, counts, _)| counts.is_none())
        || candidates
            .iter()
            .all(|candidate| candidate.counts == RotationCounts::default());
    let sample = if fallback {
        let mut sample = [0; 8];
        getrandom::fill(&mut sample).map_err(|_| ServiceError::Ticket)?;
        Some(u64::from_ne_bytes(sample))
    } else {
        None
    };
    let choose = |candidates: &[Candidate<'_>]| {
        let policy = LaunchPolicy {
            usage,
            candidates,
            // Admission and brief changes are authenticated controller writes.
            planner_brief: true,
            author_models: &[],
        };
        sample.map_or_else(
            || decide_profile_launch(task, observation, &policy),
            |sample| decide_weighted_launch(task, observation, &policy, sample),
        )
    };
    let intent = match choose(&candidates) {
        Ok(Some(intent)) => intent,
        Ok(None) => return Err(ServiceError::Input),
        Err(
            error @ (ProfileLaunchError::NoEligibleProfile { .. }
            | ProfileLaunchError::RequiredProfileUnavailable { .. }),
        ) => {
            let pauses: Vec<_> = offers
                .iter()
                .map(|(_, _, _, _, _, pause)| pause.clone())
                .collect();
            if let Some(pause) = earliest_eligible_pause(&mut candidates, &pauses, choose) {
                state.group_waits.insert(task.identity().id.clone(), pause);
                return Ok(LaunchSelection::Paused);
            }
            return Err(error.into());
        }
        Err(error) => return Err(error.into()),
    };
    state.group_waits.remove(&task.identity().id);
    let (_, offer, _, group, _, _) = offers
        .iter()
        .find(|(profile, ..)| profile.id == intent.profile().id)
        .ok_or(HostError::Configuration)?;
    let native = offer.resolve(intent.profile().effort)?;
    Ok(LaunchSelection::Profile(Box::new(SelectedLaunch {
        intent,
        native,
        group: group.clone(),
        profiles: Arc::clone(profiles),
        usage,
    })))
}

impl Service {
    pub(super) async fn record_provider_limit(
        &self,
        row: &TaskRow,
        run: &Run,
        limit: &ProviderLimit,
    ) -> Result<(String, String, Option<u64>), ServiceError> {
        let state = self.state.lock().await;
        if self.lookup(&state, &row.task.identity().id)? != *row {
            return Err(nucleus_store::StoreError::StaleTask.into());
        }
        let expected = launch_provider_instance(run)?;
        let group = if expected.as_deref().is_none_or(|id| id == limit.instance) {
            state.launch_group(run, &limit.instance)
        } else {
            // A native provider switch cannot exhaust the originally selected subscription.
            &limit.instance
        };
        let requested = limit_pause(limit);
        let pause = self
            .save_subscription_pause(&state, group, requested, now_ms())?
            .unwrap_or(requested);
        let horizon = nucleus_hosts::snooze_deadline(pause.until_ms);
        let cause = if pause.fallback {
            format!(
                "Provider usage limit for subscription group {group}. Reset unknown, clear in Profiles after topping up. Automatic retry at {horizon}."
            )
        } else {
            format!("Provider usage limit for subscription group {group}. Reset at {horizon}.")
        };
        Ok((cause, group.to_owned(), limit.reset_at_ms))
    }

    pub(super) fn record_subscription_pause(
        &self,
        state: &State,
        group: &str,
        deadline: u64,
        now: u64,
    ) -> Result<Option<u64>, ServiceError> {
        Ok(self
            .save_subscription_pause(
                state,
                group,
                SubscriptionPause {
                    until_ms: deadline,
                    fallback: false,
                },
                now,
            )?
            .map(|pause| pause.until_ms))
    }

    fn save_subscription_pause(
        &self,
        state: &State,
        group: &str,
        pause: SubscriptionPause,
        now: u64,
    ) -> Result<Option<SubscriptionPause>, ServiceError> {
        if state.store.set_subscription_pause(group, pause, now)? {
            self.profile_usage_changes.send_replace(());
            return Ok(Some(pause));
        }
        Ok(state.store.subscription_pause(group, now)?)
    }

    pub(super) async fn pause_prepared(
        &self,
        row: &TaskRow,
        observation: &Observation,
    ) -> Result<Option<Action>, ServiceError> {
        let run = row.task.run().ok_or(ServiceError::Input)?;
        {
            let mut state = self.state.lock().await;
            let Some(pause) = state.prepared_pause(run)? else {
                return Ok(None);
            };
            if run.last_send_at_ms().is_some() || run.report_reminder_for().is_some() {
                state
                    .group_waits
                    .insert(row.task.identity().id.clone(), pause);
                return Ok(Some(Action::Wait(WaitReason::Capacity)));
            }
        }
        let mut task = row.task.clone();
        if task.discard_paused_reservation(observation) {
            self.save(row, task, &crate::event("paused_reservation_released"))
                .await?;
            return Ok(Some(Action::Advance(row.task.phase())));
        }
        Ok(Some(Action::Wait(WaitReason::Capacity)))
    }
}

fn limit_pause(limit: &ProviderLimit) -> SubscriptionPause {
    let reset = limit.reset_at_ms.filter(|reset| *reset > limit.ended_at_ms);
    SubscriptionPause {
        until_ms: reset.unwrap_or_else(|| limit.ended_at_ms.saturating_add(86_400_000)),
        fallback: reset.is_none(),
    }
}

impl State {
    fn group_pause(&self, group: &str, now: u64) -> Result<Option<GroupPause>, ServiceError> {
        if self
            .settings
            .profiles
            .as_ref()
            .is_some_and(|profiles| profiles.paused_groups.contains(group))
        {
            return Ok(Some(GroupPause::Manual {
                group: group.to_owned(),
            }));
        }
        Ok(self
            .store
            .provider_pause(group, now)?
            .map(|reset| GroupPause::Until {
                group: group.to_owned(),
                reset,
            }))
    }

    pub(super) fn prepared_pause(&self, run: &Run) -> Result<Option<GroupPause>, ServiceError> {
        if let Some(group) = run.launch().subscription_group() {
            return self.group_pause(group, now_ms());
        }
        let Some(instance) = launch_provider_instance(run)? else {
            return Ok(None);
        };
        self.group_pause(self.launch_group(run, &instance), now_ms())
    }

    fn launch_group<'a>(&'a self, run: &'a Run, instance: &'a str) -> &'a str {
        run.launch()
            .subscription_group()
            .or_else(|| {
                let selected = run.launch().profile()?;
                let profiles = self.settings.profiles.as_ref()?;
                let profile = profiles.profiles.iter().find(|p| {
                    p.selection.id == selected.id
                        && p.selection.provider == selected.provider
                        && p.selection.model == selected.model
                })?;
                profile.group.as_deref()
            })
            .unwrap_or(instance)
    }
}

fn earliest_eligible_pause(
    candidates: &mut [Candidate<'_>],
    pauses: &[Option<GroupPause>],
    choose: impl Fn(&[Candidate<'_>]) -> Result<Option<ProfileLaunch>, ProfileLaunchError>,
) -> Option<GroupPause> {
    let deadlines: BTreeSet<_> = pauses
        .iter()
        .flatten()
        .filter_map(GroupPause::reset)
        .collect();
    for reset in deadlines.into_iter().map(Some).chain([None]) {
        for (candidate, pause) in candidates.iter_mut().zip(pauses) {
            candidate.group_available = reset
                .is_none_or(|reset| pause.as_ref().is_none_or(|pause| !pause.remaining(reset)));
        }
        if let Ok(Some(intent)) = choose(candidates) {
            return candidates
                .iter()
                .zip(pauses)
                .find(|(candidate, _)| candidate.profile.id == intent.profile().id)
                .and_then(|(_, pause)| pause.clone());
        }
    }
    None
}

pub(super) fn usage(state: &State) -> UsageLevel {
    state
        .settings
        .dispatch
        .as_ref()
        .map_or(UsageLevel::default(), |dispatch| {
            dispatch.effective_usage(now_ms())
        })
}
