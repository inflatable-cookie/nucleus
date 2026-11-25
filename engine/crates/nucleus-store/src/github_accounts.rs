use std::collections::BTreeSet;

use longhorn_config::{DomainIssue, StorageClass};
use serde::{Deserialize, Serialize};

use crate::{SettingsValue, settings_domains::check};

pub const GITHUB_HOST: &str = "github.com";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubAccount {
    pub host: String,
    pub user_id: String,
    pub login: String,
}

impl GitHubAccount {
    #[must_use]
    pub fn id(&self) -> String {
        format!("{}:{}", self.host, self.user_id)
    }

    #[must_use]
    pub fn numeric_id(&self) -> Option<u64> {
        self.user_id
            .parse::<u64>()
            .ok()
            .filter(|id| *id != 0 && id.to_string() == self.user_id)
    }

    #[must_use]
    pub fn valid(&self) -> bool {
        self.host == GITHUB_HOST
            && self.numeric_id().is_some()
            && (1..=100).contains(&self.login.len())
            && self
                .login
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-_[]".contains(&byte))
    }
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubAccountSettings {
    pub accounts: Vec<GitHubAccount>,
    pub worker_account_id: Option<String>,
    pub reviewer_account_id: Option<String>,
}

impl SettingsValue for GitHubAccountSettings {
    const ID: &'static str = "nucleus.engine.github-accounts";
    const FILE: &'static str = "github-accounts.json";
    const CLASS: StorageClass = StorageClass::UserConfig;

    fn validate(&self) -> Result<(), DomainIssue> {
        let mut ids = BTreeSet::new();
        check(
            self.accounts
                .iter()
                .all(|account| account.valid() && ids.insert(account.id())),
            "github-accounts",
            "each GitHub account must have a unique verified identity",
        )?;
        check(
            [&self.worker_account_id, &self.reviewer_account_id]
                .into_iter()
                .flatten()
                .all(|id| ids.contains(id)),
            "github-account-selection",
            "each selected role must name a saved GitHub account",
        )
    }
}
