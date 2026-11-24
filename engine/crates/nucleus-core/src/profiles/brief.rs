use std::fmt;

use serde::{Deserialize, Deserializer, de};

use super::{Complexity, Effort};
use crate::{Brief, Role};

/// Only the routing keys from the existing `queue` frontmatter.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BriefPolicy {
    pub complexity: Option<Complexity>,
    pub critical: bool,
    profile_requests: Requests,
    #[serde(default, deserialize_with = "optional_bool")]
    pub report_only: Option<bool>,
    #[serde(default, deserialize_with = "optional_text")]
    pub report_lane: Option<String>,
    lane: Option<LaneSelection>,
    #[serde(default, deserialize_with = "optional_lane_keys")]
    lanes: Option<Vec<String>>,
    interactive: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(untagged)]
enum LaneSelection {
    Key(#[serde(deserialize_with = "text_scalar")] String),
    Keys(#[serde(deserialize_with = "lane_keys")] Vec<String>),
}

fn optional_text<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    text_scalar(deserializer).map(Some)
}

fn optional_bool<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<bool>, D::Error> {
    match yaml_serde::Value::deserialize(deserializer)? {
        yaml_serde::Value::Bool(value) => Ok(Some(value)),
        _ => Err(de::Error::custom("expected a Boolean reportOnly value")),
    }
}

fn lane_keys<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<String>, D::Error> {
    #[derive(Deserialize)]
    struct Key(#[serde(deserialize_with = "text_scalar")] String);
    Ok(Vec::<Key>::deserialize(deserializer)?
        .into_iter()
        .map(|key| key.0)
        .collect())
}

fn optional_lane_keys<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<String>>, D::Error> {
    lane_keys(deserializer).map(Some)
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
struct Requests {
    worker: Option<ProfileRequest>,
    reviewer: Option<ProfileRequest>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileRequest {
    #[serde(deserialize_with = "text_scalar")]
    pub profile_id: String,
    #[serde(deserialize_with = "text_scalar")]
    pub reason: String,
    #[serde(default)]
    pub required: bool,
    pub thinking_option_id: Option<Effort>,
}

// YAML's direct string reader also accepts booleans and numbers. A routing
// request must supply text for both its profile ID and its justification.
fn text_scalar<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    match yaml_serde::Value::deserialize(deserializer)? {
        yaml_serde::Value::String(text) => Ok(text),
        _ => Err(de::Error::custom("expected a text scalar")),
    }
}

#[derive(Debug)]
pub enum BriefPolicyError {
    UnclosedFrontmatter,
    InvalidFrontmatter(yaml_serde::Error),
    UnjustifiedRequest(Role),
    ReportPolicy(&'static str),
}

impl fmt::Display for BriefPolicyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnclosedFrontmatter => {
                f.write_str("brief frontmatter is missing its closing delimiter")
            }
            Self::InvalidFrontmatter(error) => write!(f, "invalid routing frontmatter: {error}"),
            Self::ReportPolicy(message) => f.write_str(message),
            Self::UnjustifiedRequest(role) => write!(
                f,
                "{role:?} profile request needs a profile ID and a reason of 1 to 4000 characters"
            ),
        }
    }
}

impl std::error::Error for BriefPolicyError {}

impl BriefPolicy {
    /// Read the YAML block at the start of the brief. Plain milestone 1 briefs
    /// and briefs without a routing section keep the normal defaults.
    ///
    /// # Errors
    /// Returns an error for invalid routing data or an unjustified role request.
    pub fn parse(brief: &str) -> Result<Self, BriefPolicyError> {
        #[derive(Deserialize)]
        struct Frontmatter {
            queue: Option<BriefPolicy>,
        }
        let Some(front) =
            Brief::frontmatter(brief).map_err(|()| BriefPolicyError::UnclosedFrontmatter)?
        else {
            return Ok(Self::default());
        };
        let parsed: Option<Frontmatter> =
            yaml_serde::from_str(front).map_err(BriefPolicyError::InvalidFrontmatter)?;
        let mut policy = parsed.and_then(|front| front.queue).unwrap_or_default();
        policy.normalize_requests()?;
        if policy.report_lane.is_some() && policy.report_only != Some(true) {
            return Err(BriefPolicyError::ReportPolicy(
                "queue.reportLane requires queue.reportOnly: true",
            ));
        }
        if policy.report_only == Some(true) {
            if policy.interactive {
                return Err(BriefPolicyError::ReportPolicy(
                    "queue.reportOnly cannot be combined with queue.interactive",
                ));
            }
            if policy.lane.is_some() && policy.lanes.is_some() {
                return Err(BriefPolicyError::ReportPolicy(
                    "provide queue.lane or queue.lanes, not both",
                ));
            }
            if let Some(lane) = &policy.report_lane
                && !policy.lanes().contains(lane)
            {
                return Err(BriefPolicyError::ReportPolicy(
                    "queue.reportLane must also be attached through queue.lane or queue.lanes",
                ));
            }
        }
        Ok(policy)
    }

    /// Return the lane keys declared in held queue frontmatter.
    #[must_use]
    pub fn lanes(&self) -> &[String] {
        self.lanes.as_deref().unwrap_or_else(|| match &self.lane {
            Some(LaneSelection::Key(key)) => std::slice::from_ref(key),
            Some(LaneSelection::Keys(keys)) => keys,
            None => &[],
        })
    }

    #[must_use]
    pub fn request(&self, role: Role) -> Option<&ProfileRequest> {
        match role {
            Role::Worker => self.profile_requests.worker.as_ref(),
            Role::Reviewer => self.profile_requests.reviewer.as_ref(),
        }
    }

    fn normalize_requests(&mut self) -> Result<(), BriefPolicyError> {
        for (role, request) in [
            (Role::Worker, &mut self.profile_requests.worker),
            (Role::Reviewer, &mut self.profile_requests.reviewer),
        ] {
            if let Some(request) = request {
                request.profile_id = request.profile_id.trim().to_owned();
                request.reason = request.reason.trim().to_owned();
                if request.profile_id.is_empty()
                    || request.reason.is_empty()
                    || request.reason.chars().count() > 4000
                {
                    return Err(BriefPolicyError::UnjustifiedRequest(role));
                }
            }
        }
        Ok(())
    }
}
