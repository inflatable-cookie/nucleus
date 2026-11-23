use std::fmt;

use serde::{Deserialize, Serialize};

use super::{
    BriefPolicy, BriefPolicyError, Candidate, Capability, Profile, UsageLevel, request_only,
    requested_bracket, reviewer_bracket, rotation_order, tier_order, worker_climb, worker_start,
};
use crate::{
    Action, Brief, Forge, Launch, Observation, Observed, Phase, PullRequest, Review, Role, Task,
    Verdict, decide,
};

/// Authoritative inputs supplied by the scheduler for this role's next run.
pub struct LaunchPolicy<'a> {
    pub usage: UsageLevel,
    pub candidates: &'a [Candidate<'a>],
    /// The service authenticates the brief at admission and amendment.
    /// Text in the brief cannot establish that authority by itself.
    pub planner_brief: bool,
    /// Additional known contributors, including author models for a review entry.
    pub author_models: &'a [&'a str],
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct BoundProfile {
    pub(crate) selected: Profile,
    pub(crate) consumed_review: Option<u64>,
}

/// Selected inputs for an ordinary new reservation. A host given `Create`
/// creates a child, including when this replaces a retained role thread.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileLaunch {
    pub(crate) role: Role,
    pub(crate) via: Launch,
    pub(crate) previous: Launch,
    pub(crate) instance: String,
    pub(crate) profile: BoundProfile,
    pub(crate) brief: Brief,
    pub(crate) pr: Option<PullRequest>,
    pub(crate) findings: Option<String>,
    pub(crate) request_reason: Option<String>,
}

impl ProfileLaunch {
    #[must_use]
    pub const fn role(&self) -> Role {
        self.role
    }

    #[must_use]
    pub const fn via(&self) -> &Launch {
        &self.via
    }

    #[must_use]
    pub fn replaced_thread(&self) -> Option<&str> {
        match (&self.via, &self.previous) {
            (Launch::Create, Launch::Continue { thread }) => Some(thread),
            _ => None,
        }
    }

    #[must_use]
    pub fn instance(&self) -> &str {
        &self.instance
    }

    #[must_use]
    pub const fn profile(&self) -> &Profile {
        &self.profile.selected
    }

    #[must_use]
    pub const fn brief(&self) -> &Brief {
        &self.brief
    }

    #[must_use]
    pub const fn pull_request(&self) -> Option<&PullRequest> {
        self.pr.as_ref()
    }

    #[must_use]
    pub fn findings(&self) -> Option<&str> {
        self.findings.as_deref()
    }

    #[must_use]
    pub fn request_reason(&self) -> Option<&str> {
        self.request_reason.as_deref()
    }
}

#[derive(Debug)]
pub enum ProfileLaunchError {
    Brief(BriefPolicyError),
    RequiredProfileUnavailable { role: Role, id: String },
    NoEligibleProfile { role: Role, demand: Capability },
    OpaqueAuthor,
    SequenceExhausted,
}

impl fmt::Display for ProfileLaunchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Brief(error) => error.fmt(f),
            Self::RequiredProfileUnavailable { role, id } => {
                write!(f, "required {role:?} profile {id} is unavailable")
            }
            Self::NoEligibleProfile { role, demand } => {
                write!(f, "no eligible {role:?} profile for {demand:?} demand")
            }
            Self::OpaqueAuthor => f.write_str("the author's model is unknown"),
            Self::SequenceExhausted => f.write_str("the launch sequence cannot be incremented"),
        }
    }
}

impl std::error::Error for ProfileLaunchError {}

/// Select a profile only when the lifecycle permits a fresh reservation.
/// Existing runs, including a ready-to-send replay, keep their frozen inputs.
///
/// # Errors
/// Returns an error when the brief or sequence is invalid or no eligible
/// profile can be dispatched for the role.
pub fn decide_profile_launch(
    task: &Task,
    observation: &Observation,
    policy: &LaunchPolicy<'_>,
) -> Result<Option<ProfileLaunch>, ProfileLaunchError> {
    select_launch(task, observation, policy, None)
}

/// Select a launch without historical counts. Once eligibility and demand
/// are decided, a uniform sample picks among the best bracket by weight.
///
/// # Errors
/// Returns the same eligibility and brief errors as [`decide_profile_launch`].
pub fn decide_weighted_launch(
    task: &Task,
    observation: &Observation,
    policy: &LaunchPolicy<'_>,
    sample: u64,
) -> Result<Option<ProfileLaunch>, ProfileLaunchError> {
    select_launch(task, observation, policy, Some(sample))
}

fn select_launch(
    task: &Task,
    observation: &Observation,
    policy: &LaunchPolicy<'_>,
    sample: Option<u64>,
) -> Result<Option<ProfileLaunch>, ProfileLaunchError> {
    let Action::Launch {
        role,
        via: previous,
    } = decide(task, observation)
    else {
        return Ok(None);
    };
    if previous == Launch::SendPrepared {
        return Ok(None);
    }

    let brief = BriefPolicy::parse(&task.brief().text).map_err(ProfileLaunchError::Brief)?;
    let request = brief.request(role).filter(|_| policy.planner_brief);
    let demand = demand(task, observation, role, &brief, policy.usage);
    let exclusions = excluded_models(task, role, policy.author_models)?;
    let eligible = policy.candidates.iter().copied().filter(|candidate| {
        let model = model_key(&candidate.profile.model);
        (role != Role::Reviewer || model.is_some())
            && !model.is_some_and(|model| exclusions.contains(&model))
            && (role != Role::Reviewer || candidate.profile.capability <= demand.ceiling)
    });
    let requested = request.and_then(|request| {
        eligible.clone().find(|candidate| {
            candidate.profile.id == request.profile_id
                && candidate.usable(request.thinking_option_id)
        })
    });
    let retained = task.threads().profile(role);
    let (profile, reason, climbed) = if let Some(candidate) = requested {
        let mut profile = candidate.profile.clone();
        let reason = request.map(|request| {
            profile.effort = request.thinking_option_id.or(profile.effort);
            request.reason.clone()
        });
        (profile, reason, false)
    } else {
        if let Some(request) = request.filter(|request| request.required) {
            return Err(ProfileLaunchError::RequiredProfileUnavailable {
                role,
                id: request.profile_id.clone(),
            });
        }
        let automatic = eligible.filter(|candidate| {
            candidate.usable(None)
                && candidate.profile.capability <= demand.ceiling
                && !request_only(
                    candidate.profile.capability,
                    policy.usage,
                    brief.complexity.unwrap_or_default(),
                    demand.climb.or(demand.earned),
                )
        });
        let best = retain_or_rotate(automatic, &previous, retained, &demand, sample).ok_or(
            ProfileLaunchError::NoEligibleProfile {
                role,
                demand: demand.target,
            },
        )?;
        let climbed = demand.climb == Some(best.profile.capability);
        (best.profile.clone(), None, climbed)
    };
    let via = match (&previous, retained) {
        (Launch::Continue { .. }, Some(retained)) if retained.same_binding(&profile) => {
            previous.clone()
        }
        _ => Launch::Create,
    };
    let pr = task.pull_request().cloned();
    let changes = applied_changes(task, observation);
    let consumed_review = if role == Role::Worker {
        if climbed {
            task.threads.applied_review_sequence
        } else {
            task.threads
                .worker_profile
                .as_ref()
                .and_then(|bound| bound.consumed_review)
        }
    } else {
        None
    };
    Ok(Some(ProfileLaunch {
        role,
        via,
        previous,
        instance: task
            .next_launch_instance()
            .map_err(|_| ProfileLaunchError::SequenceExhausted)?,
        profile: BoundProfile {
            selected: profile,
            consumed_review,
        },
        brief: task.brief().clone(),
        pr,
        findings: changes.map(str::to_owned),
        request_reason: reason,
    }))
}

struct Demand {
    target: Capability,
    retained_floor: Capability,
    ceiling: Capability,
    climb: Option<Capability>,
    earned: Option<Capability>,
}

fn demand(
    task: &Task,
    observation: &Observation,
    role: Role,
    brief: &BriefPolicy,
    usage: UsageLevel,
) -> Demand {
    let complexity = brief.complexity.unwrap_or_default();
    let start = worker_start(usage, complexity);
    let worker = task.threads.worker_profile.as_ref();
    let actual = worker.map_or(start, |bound| bound.selected.capability);
    let consumed = worker.and_then(|bound| bound.consumed_review);
    let earned = consumed.map(|_| actual);
    match role {
        Role::Reviewer => Demand {
            target: reviewer_bracket(usage, actual, brief.critical),
            // Criticality prefers a peer for fresh review. An independent
            // retained fallback can continue if it meets the ordinary bracket.
            retained_floor: reviewer_bracket(usage, actual, false),
            ceiling: actual,
            climb: None,
            earned,
        },
        Role::Worker => {
            let applied =
                applied_changes(task, observation).and(task.threads.applied_review_sequence);
            let climb = if applied > consumed {
                worker_climb(usage, complexity, actual)
            } else {
                None
            };
            let same_review = applied.is_some() && applied == consumed;
            let ceiling = if usage == UsageLevel::Maximum {
                Capability::Frontier
            } else {
                requested_bracket(complexity)
            };
            let target = if same_review {
                actual
            } else {
                start.max(actual)
            };
            Demand {
                target: climb.unwrap_or(target),
                retained_floor: climb.unwrap_or(Capability::Mechanical),
                ceiling: climb.unwrap_or(if same_review {
                    ceiling.min(actual)
                } else {
                    ceiling
                }),
                climb,
                earned,
            }
        }
    }
}

pub(crate) fn applied_changes<'a>(task: &'a Task, observation: &Observation) -> Option<&'a str> {
    match (task.phase(), task.verdict(), &observation.forge) {
        (
            Phase::Working,
            Some(Verdict::Reviewed {
                head,
                decision: Review::Changes,
                summary,
            }),
            Observed::Known(Forge::Open { pr, .. }),
        ) if task.pull_request() == Some(pr) && head == &pr.head => Some(summary),
        _ => None,
    }
}

fn retain_or_rotate<'a>(
    candidates: impl Iterator<Item = Candidate<'a>> + Clone,
    launch: &Launch,
    retained: Option<&Profile>,
    demand: &Demand,
    sample: Option<u64>,
) -> Option<Candidate<'a>> {
    let tier = |candidate: &Candidate<'_>| tier_order(candidate.profile.capability, demand.target);
    let best = candidates
        .clone()
        .min_by(|a, b| tier(a).cmp(&tier(b)).then_with(|| rotation_order(*a, *b)))?;
    if matches!(launch, Launch::Continue { .. })
        && let Some(retained) = candidates.clone().find(|candidate| {
            retained.is_some_and(|profile| profile.same_binding(candidate.profile))
                && (candidate.profile.capability >= demand.retained_floor
                    || tier(candidate) <= tier(&best))
        })
    {
        return Some(retained);
    }
    let Some(sample) = sample else {
        return Some(best);
    };
    let mut peers = candidates.filter(|candidate| tier(candidate) == tier(&best));
    let share = |candidate: Candidate<'_>| u64::from(candidate.profile.weight.share());
    let total: u64 = peers.clone().map(share).sum();
    let mut ticket = sample % total;
    peers.find(|candidate| {
        let weight = share(*candidate);
        let chosen = ticket < weight;
        ticket = ticket.saturating_sub(weight);
        chosen
    })
}

fn excluded_models(
    task: &Task,
    role: Role,
    authors: &[&str],
) -> Result<Vec<String>, ProfileLaunchError> {
    match role {
        Role::Worker => Ok(task
            .threads()
            .profile(Role::Reviewer)
            .and_then(|profile| model_key(&profile.model))
            .into_iter()
            .collect()),
        Role::Reviewer => {
            let retained_worker = task.threads().profile(Role::Worker);
            let retained_model = retained_worker.map(|profile| profile.model.as_str());
            if task.threads().get(Role::Worker).is_some() && retained_model.is_none() {
                return Err(ProfileLaunchError::OpaqueAuthor);
            }
            authors
                .iter()
                .copied()
                .chain(retained_model)
                .map(|model| model_key(model).ok_or(ProfileLaunchError::OpaqueAuthor))
                .collect()
        }
    }
}

fn model_key(model: &str) -> Option<String> {
    let model = model.rsplit('/').next()?.trim().to_ascii_lowercase();
    (!matches!(model.as_str(), "" | "default" | "unknown")).then_some(model)
}
