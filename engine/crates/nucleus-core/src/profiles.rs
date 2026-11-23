//! The host-independent routing rules from Specs 052 and 053.

mod brief;
mod launch;

use std::cmp::Ordering;

use serde::{Deserialize, Serialize};

pub use brief::{BriefPolicy, BriefPolicyError, ProfileRequest};
pub(crate) use launch::{BoundProfile, applied_changes};
pub use launch::{
    LaunchPolicy, ProfileLaunch, ProfileLaunchError, decide_profile_launch, decide_weighted_launch,
};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UsageLevel {
    #[serde(alias = "minimal")]
    Low,
    #[default]
    Normal,
    High,
    ExtraHigh,
    Maximum,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Complexity {
    VeryLow,
    Low,
    #[default]
    Medium,
    High,
    VeryHigh,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    #[serde(alias = "very_low", alias = "low")]
    Mechanical,
    #[default]
    #[serde(alias = "medium", alias = "high")]
    Worker,
    #[serde(alias = "very_high")]
    Heavyweight,
    Frontier,
}

impl Capability {
    const fn lower(self) -> Self {
        match self {
            Self::Mechanical | Self::Worker => Self::Mechanical,
            Self::Heavyweight => Self::Worker,
            Self::Frontier => Self::Heavyweight,
        }
    }

    const fn higher(self) -> Self {
        match self {
            Self::Mechanical => Self::Worker,
            Self::Worker => Self::Heavyweight,
            Self::Heavyweight | Self::Frontier => Self::Frontier,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Weight {
    Fewest,
    Fewer,
    #[default]
    Default,
    More,
    Most,
}

impl Weight {
    #[must_use]
    pub const fn share(self) -> u16 {
        match self {
            Self::Fewest => 50,
            Self::Fewer => 75,
            Self::Default => 100,
            Self::More => 150,
            Self::Most => 200,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    Codex,
    Claude,
    Pi,
    Grok,
    Cursor,
    Opencode,
    Copilot,
    Omp,
    Antigravity,
    Muse,
    Fx,
    Kiro,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Effort {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    #[serde(rename = "xhigh")]
    XHigh,
    Max,
    Ultra,
}

/// Canonical Settings data. A host translates this selection at the launch seam.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    pub id: String,
    #[serde(default)]
    pub capability: Capability,
    #[serde(default)]
    pub weight: Weight,
    pub provider: Provider,
    pub model: String,
    #[serde(default, alias = "thinkingOptionId")]
    pub effort: Option<Effort>,
}

impl Profile {
    fn same_binding(&self, other: &Self) -> bool {
        self.id == other.id
            && self.provider == other.provider
            && self.model == other.model
            && self.effort == other.effort
    }
}

/// Counts supplied for this candidate and the role being selected. Recent
/// profile counts come from the role's last 50 assignments. Group counts span roles.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RotationCounts {
    pub profile_recent: u64,
    pub group_recent: u64,
    pub profile_lifetime: u64,
    pub group_lifetime: u64,
}

/// Availability and counts are scheduler inputs, independent of the native catalogue.
#[derive(Debug, Clone, Copy)]
pub struct Candidate<'a> {
    pub profile: &'a Profile,
    pub enabled: bool,
    pub available: bool,
    pub group_available: bool,
    pub supported_efforts: &'a [Effort],
    pub counts: RotationCounts,
}

impl Candidate<'_> {
    fn usable(self, effort: Option<Effort>) -> bool {
        self.enabled
            && self.available
            && self.group_available
            && effort
                .or(self.profile.effort)
                .is_none_or(|value| self.supported_efforts.contains(&value))
    }
}

#[must_use]
pub const fn own_bracket(complexity: Complexity) -> Capability {
    match complexity {
        Complexity::VeryLow | Complexity::Low => Capability::Mechanical,
        Complexity::Medium | Complexity::High => Capability::Worker,
        Complexity::VeryHigh => Capability::Heavyweight,
    }
}

#[must_use]
pub const fn requested_bracket(complexity: Complexity) -> Capability {
    match complexity {
        Complexity::High | Complexity::VeryHigh => own_bracket(complexity).higher(),
        _ => own_bracket(complexity),
    }
}

#[must_use]
pub const fn worker_start(usage: UsageLevel, complexity: Complexity) -> Capability {
    match usage {
        UsageLevel::Low => requested_bracket(complexity).lower(),
        UsageLevel::Normal => own_bracket(complexity),
        UsageLevel::High | UsageLevel::ExtraHigh => match requested_bracket(complexity) {
            Capability::Frontier => Capability::Heavyweight,
            requested => requested,
        },
        UsageLevel::Maximum => own_bracket(complexity).higher(),
    }
}

#[must_use]
pub const fn reviewer_bracket(usage: UsageLevel, worker: Capability, critical: bool) -> Capability {
    if critical {
        return worker;
    }
    match (usage, worker) {
        (UsageLevel::Low | UsageLevel::Normal, _)
        | (UsageLevel::High, Capability::Heavyweight | Capability::Frontier) => worker.lower(),
        _ => worker,
    }
}

#[must_use]
pub fn request_only(
    capability: Capability,
    usage: UsageLevel,
    complexity: Complexity,
    earned: Option<Capability>,
) -> bool {
    match (usage, capability) {
        (UsageLevel::Low | UsageLevel::Normal | UsageLevel::High, Capability::Frontier) => true,
        (UsageLevel::Low | UsageLevel::Normal, Capability::Heavyweight) => {
            requested_bracket(complexity) != Capability::Frontier
                && earned != Some(Capability::Heavyweight)
        }
        _ => false,
    }
}

/// The next bracket an unconsumed, applied changes review permits.
#[must_use]
pub fn worker_climb(
    usage: UsageLevel,
    complexity: Complexity,
    actual: Capability,
) -> Option<Capability> {
    let start = worker_start(usage, complexity);
    let bound = match (usage, complexity) {
        (UsageLevel::Maximum, Complexity::High | Complexity::VeryHigh) => Capability::Frontier,
        (UsageLevel::Maximum, _) => start,
        _ => requested_bracket(complexity),
    };
    let ceiling = if request_only(Capability::Frontier, usage, complexity, None) {
        bound.min(Capability::Heavyweight)
    } else {
        bound
    };
    (start < bound && actual < ceiling).then(|| actual.higher().min(ceiling))
}

fn rotation_order(a: Candidate<'_>, b: Candidate<'_>) -> Ordering {
    let weighted = |a_count, b_count| {
        (u128::from(a_count) * u128::from(b.profile.weight.share()))
            .cmp(&(u128::from(b_count) * u128::from(a.profile.weight.share())))
    };
    weighted(a.counts.profile_recent, b.counts.profile_recent)
        .then_with(|| a.counts.group_recent.cmp(&b.counts.group_recent))
        .then_with(|| weighted(a.counts.profile_lifetime, b.counts.profile_lifetime))
        .then_with(|| a.counts.group_lifetime.cmp(&b.counts.group_lifetime))
        .then_with(|| a.profile.id.cmp(&b.profile.id))
}

fn tier_order(capability: Capability, demand: Capability) -> (bool, u8) {
    // A shortfall loses to any bracket that meets demand, then proximity wins.
    (
        capability < demand,
        (capability as u8).abs_diff(demand as u8),
    )
}
