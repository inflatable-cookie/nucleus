use std::sync::Arc;

use nucleus_core::{
    Observation, Role, Task,
    profiles::{
        Candidate, LaunchPolicy, ProfileLaunch, ProfileLaunchError, RotationCounts, UsageLevel,
        decide_profile_launch, decide_weighted_launch,
    },
};
use nucleus_hosts::{HostError, RoleProfile, TaskHost};
use nucleus_store::Profiles;

use crate::{ProjectMode, Service, ServiceError, State, now_ms};

pub(super) struct SelectedLaunch {
    pub(super) intent: ProfileLaunch,
    pub(super) native: RoleProfile,
    pub(super) group: String,
    profiles: Arc<Profiles>,
    usage: UsageLevel,
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
    pub(super) async fn select_launch(
        &self,
        task: &Task,
        observation: &Observation,
        role: Role,
        host: &impl TaskHost,
    ) -> Result<Option<SelectedLaunch>, ServiceError> {
        if self.state.lock().await.settings.profiles.is_none() {
            return match self.project.mode {
                ProjectMode::Fixture => Ok(None),
                ProjectMode::Project => Err(ServiceError::ProfileConfiguration),
            };
        }
        if role == Role::Reviewer && task.threads().profile(Role::Worker).is_none() {
            return Err(ProfileLaunchError::OpaqueAuthor.into());
        }
        let catalog = host.profile_catalog().await?;
        let state = self.state.lock().await;
        let profiles = state
            .settings
            .profiles
            .as_ref()
            .ok_or(HostError::Configuration)?;
        let usage = usage(&state);
        let mut offers = Vec::new();
        for profile in &profiles.profiles {
            let Some(offer) =
                catalog.offer(&profile.selection, &self.project.profile(role).runtime_mode)
            else {
                continue;
            };
            let group = profile
                .group
                .as_deref()
                .unwrap_or_else(|| offer.instance())
                .to_owned();
            let counts = state
                .store
                .rotation_counts(role, &profile.selection.id, &group);
            let efforts: Vec<_> = offer.efforts().collect();
            offers.push((&profile.selection, offer, efforts, group, counts));
        }
        let candidates: Vec<_> = offers
            .iter()
            .map(|(profile, _, efforts, _, counts)| Candidate {
                profile,
                enabled: true,
                available: true,
                // This catalog reports provider readiness, with no group limit evidence.
                group_available: true,
                supported_efforts: efforts,
                counts: counts.unwrap_or_default(),
            })
            .collect();
        let policy = LaunchPolicy {
            usage,
            candidates: &candidates,
            // Admission and brief changes are authenticated controller writes.
            planner_brief: true,
            author_models: &[],
        };
        let fallback = offers.iter().any(|(_, _, _, _, counts)| counts.is_none())
            || candidates
                .iter()
                .all(|candidate| candidate.counts == RotationCounts::default());
        let intent = if fallback {
            let mut sample = [0; 8];
            getrandom::fill(&mut sample).map_err(|_| ServiceError::Ticket)?;
            decide_weighted_launch(task, observation, &policy, u64::from_ne_bytes(sample))
        } else {
            decide_profile_launch(task, observation, &policy)
        }?
        .ok_or(ServiceError::Input)?;
        let (_, offer, _, group, _) = offers
            .iter()
            .find(|(profile, ..)| profile.id == intent.profile().id)
            .ok_or(HostError::Configuration)?;
        let native = offer.resolve(intent.profile().effort)?;
        Ok(Some(SelectedLaunch {
            intent,
            native,
            group: group.clone(),
            profiles: Arc::clone(profiles),
            usage,
        }))
    }
}

fn usage(state: &State) -> UsageLevel {
    state
        .settings
        .dispatch
        .as_ref()
        .map_or(UsageLevel::default(), |dispatch| {
            dispatch.effective_usage(now_ms())
        })
}
