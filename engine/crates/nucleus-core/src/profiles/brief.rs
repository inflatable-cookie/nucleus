use std::{collections::BTreeMap, fmt};

use serde::{Deserialize, Deserializer, de};

use super::{Complexity, Effort};
use crate::{Brief, QueuePriority, Role};

/// The engine policy declared in a brief's `queue` frontmatter.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BriefPolicy {
    pub complexity: Option<Complexity>,
    pub priority: Option<QueuePriority>,
    pub critical: bool,
    pub notify_origin_on_closeout: bool,
    merge_hold: Option<bool>,
    #[serde(default, deserialize_with = "optional_text")]
    merge_hold_reason: Option<String>,
    profile_requests: Requests,
    #[serde(default, deserialize_with = "present")]
    preferred_profile_id: Option<()>,
    #[serde(default, deserialize_with = "optional_bool")]
    pub report_only: Option<bool>,
    #[serde(default, deserialize_with = "optional_text")]
    pub report_lane: Option<String>,
    lane: Option<LaneSelection>,
    #[serde(default, deserialize_with = "optional_lane_keys")]
    lanes: Option<Vec<String>>,
    #[serde(deserialize_with = "lane_keys")]
    pub lane_documents: Vec<String>,
    #[serde(deserialize_with = "lane_keys")]
    pub depends_on: Vec<String>,
    #[serde(default, deserialize_with = "present")]
    interactive: Option<()>,
    #[serde(flatten)]
    unknown: BTreeMap<String, yaml_serde::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(untagged)]
enum LaneSelection {
    Key(#[serde(deserialize_with = "text_scalar")] String),
    Keys(#[serde(deserialize_with = "lane_keys")] Vec<String>),
}

fn present<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<()>, D::Error> {
    de::IgnoredAny::deserialize(deserializer).map(|_| Some(()))
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
    RetiredProfile,
    RetiredInteractive,
    UnknownQueueKey(String),
    MergeHoldReason,
    InvalidFrontmatter(yaml_serde::Error),
    UnjustifiedRequest(Role),
    ReportPolicy(&'static str),
}

impl fmt::Display for BriefPolicyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RetiredProfile => f.write_str("queue.preferredProfileId is retired; use queue.profileRequests.worker with profileId and reason (required: true to require it)"),
            Self::RetiredInteractive => f.write_str("queue.interactive is retired; submit the work as a normal brief"),
            Self::UnknownQueueKey(key) => write!(f, "unknown queue key: queue.{key}"),
            Self::MergeHoldReason => f.write_str("queue.mergeHold: true requires a queue.mergeHoldReason of 1 to 4000 characters"),
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
    /// Validate routing keys on a new brief.
    ///
    /// # Errors
    /// Returns an error for unsupported keys or invalid policy.
    pub fn submitted(brief: &str) -> Result<Self, BriefPolicyError> {
        Self::parse(brief)?.validate(&BTreeMap::new())
    }

    /// Validate a replacement brief against the stored policy.
    ///
    /// # Errors
    /// Returns an error for new or changed unknown keys or invalid policy.
    pub fn amended(&self, brief: &str) -> Result<Self, BriefPolicyError> {
        Self::parse(brief)?.validate(&self.unknown)
    }

    fn validate(
        self,
        stored_unknown: &BTreeMap<String, yaml_serde::Value>,
    ) -> Result<Self, BriefPolicyError> {
        if self.preferred_profile_id.is_some() {
            return Err(BriefPolicyError::RetiredProfile);
        }
        if self.interactive.is_some() {
            return Err(BriefPolicyError::RetiredInteractive);
        }
        if let Some((key, _)) = self
            .unknown
            .iter()
            .find(|(key, value)| stored_unknown.get(*key) != Some(*value))
        {
            return Err(BriefPolicyError::UnknownQueueKey(key.clone()));
        }
        if self.merge_hold == Some(true) {
            if self
                .merge_hold_reason()
                .is_none_or(|reason| reason.is_empty() || reason.chars().count() > 4000)
            {
                return Err(BriefPolicyError::MergeHoldReason);
            }
            if self.report_only == Some(true) {
                return Err(BriefPolicyError::ReportPolicy(
                    "queue.mergeHold cannot be combined with queue.reportOnly",
                ));
            }
        }
        Ok(self)
    }

    /// Return the reason when the brief declares a merge hold.
    #[must_use]
    pub fn merge_hold_reason(&self) -> Option<&str> {
        self.merge_hold_reason
            .as_deref()
            .filter(|_| self.merge_hold == Some(true))
            .map(str::trim)
    }

    /// Write the explicit promotion choice into a papercut's task brief.
    ///
    /// # Errors
    /// Returns an error if the brief's existing YAML cannot be read.
    pub fn with_complexity(
        brief: &str,
        complexity: Complexity,
    ) -> Result<String, BriefPolicyError> {
        use yaml_serde::{Mapping, Value};

        let error = BriefPolicyError::InvalidFrontmatter;
        let front =
            Brief::frontmatter(brief).map_err(|()| BriefPolicyError::UnclosedFrontmatter)?;
        let (mut document, body) = if let Some(front) = front {
            let document: Option<Mapping> = yaml_serde::from_str(front).map_err(error)?;
            let (_, lines) = brief
                .split_once('\n')
                .ok_or(BriefPolicyError::UnclosedFrontmatter)?;
            let body = lines[front.len()..]
                .split_once('\n')
                .map_or("", |(_, body)| body);
            (document.unwrap_or_default(), body)
        } else {
            (Mapping::new(), brief)
        };
        let key = Value::String("queue".into());
        let queue: Option<Mapping> =
            yaml_serde::from_value(document.remove(&key).unwrap_or(Value::Null)).map_err(error)?;
        let mut queue = queue.unwrap_or_default();
        queue.insert(
            Value::String("complexity".into()),
            yaml_serde::to_value(complexity).map_err(error)?,
        );
        document.insert(key, Value::Mapping(queue));
        let yaml = yaml_serde::to_string(&document).map_err(error)?;
        Ok(format!("---\n{yaml}---\n{body}"))
    }

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

#[cfg(test)]
mod submission_tests {
    use super::BriefPolicy;

    #[test]
    fn retired_selector_only_refuses_new_or_amended_input() {
        let brief = "---\nqueue:\n  preferredProfileId: old\n---\nHeld work";
        assert!(BriefPolicy::parse(brief).is_ok());
        assert!(
            BriefPolicy::submitted(brief)
                .unwrap_err()
                .to_string()
                .contains("queue.profileRequests.worker")
        );
    }

    #[test]
    fn retired_interactive_only_refuses_new_or_amended_input() {
        let brief = "---\nqueue:\n  interactive: true\n---\nHeld work";
        assert!(BriefPolicy::parse(brief).is_ok());
        assert!(
            BriefPolicy::submitted(brief)
                .unwrap_err()
                .to_string()
                .contains("queue.interactive is retired")
        );
    }

    #[test]
    fn only_submitted_briefs_refuse_legacy_queue_keys() {
        let brief = "---\nqueue:\n  complexity: high\n  scope: complex\n---\nHeld work";
        assert!(BriefPolicy::parse(brief).unwrap().complexity.is_some());
        assert_eq!(
            BriefPolicy::submitted(brief).unwrap_err().to_string(),
            "unknown queue key: queue.scope"
        );
    }

    #[test]
    fn amendments_can_keep_or_remove_but_cannot_add_or_change_unknown_queue_keys() {
        let brief = "---\nqueue:\n  complexity: high\n  scope: complex\n---\nHeld work";
        let stored = BriefPolicy::parse(brief).unwrap();
        assert!(
            stored
                .amended(&brief.replace("Held work", "Amended work"))
                .is_ok()
        );
        assert!(
            stored
                .amended(&brief.replace("  scope: complex\n", ""))
                .is_ok()
        );
        for (entry, key) in [
            ("scope: general", "scope"),
            ("scope: complex\n  mergeHlod: true", "mergeHlod"),
        ] {
            let replacement = brief.replace("scope: complex", entry);
            assert_eq!(
                stored.amended(&replacement).unwrap_err().to_string(),
                format!("unknown queue key: queue.{key}")
            );
        }
    }

    #[test]
    fn a_merge_hold_requires_a_reason() {
        for reason in ["", "  mergeHoldReason: '   '\n"] {
            let brief = format!("---\nqueue:\n  mergeHold: true\n{reason}---\nHeld work");
            assert!(
                BriefPolicy::submitted(&brief)
                    .unwrap_err()
                    .to_string()
                    .contains("requires a queue.mergeHoldReason")
            );
        }
    }
}
