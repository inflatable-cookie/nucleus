use std::fmt;

use serde::Deserialize;

use super::{Complexity, Effort};
use crate::Role;

/// Only the routing keys from the existing `queue` frontmatter.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BriefPolicy {
    pub complexity: Option<Complexity>,
    pub critical: bool,
    profile_requests: Requests,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
struct Requests {
    worker: Option<ProfileRequest>,
    reviewer: Option<ProfileRequest>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileRequest {
    pub profile_id: String,
    pub reason: String,
    #[serde(default)]
    pub required: bool,
    pub thinking_option_id: Option<Effort>,
}

#[derive(Debug)]
pub enum BriefPolicyError {
    UnclosedFrontmatter,
    InvalidFrontmatter(yaml_serde::Error),
    UnjustifiedRequest(Role),
}

impl fmt::Display for BriefPolicyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnclosedFrontmatter => {
                f.write_str("brief frontmatter is missing its closing delimiter")
            }
            Self::InvalidFrontmatter(error) => write!(f, "invalid routing frontmatter: {error}"),
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
        let Some((first, body)) = brief.split_once('\n') else {
            return Ok(Self::default());
        };
        if first.trim_end_matches('\r') != "---" {
            return Ok(Self::default());
        }
        let mut offset = 0;
        for line in body.split_inclusive('\n') {
            if line.trim_end_matches(['\r', '\n']) == "---" {
                let parsed: Option<Frontmatter> = yaml_serde::from_str(&body[..offset])
                    .map_err(BriefPolicyError::InvalidFrontmatter)?;
                let mut policy = parsed.and_then(|front| front.queue).unwrap_or_default();
                policy.normalize_requests()?;
                return Ok(policy);
            }
            offset += line.len();
        }
        Err(BriefPolicyError::UnclosedFrontmatter)
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
