use std::{io::Read as _, sync::atomic::AtomicBool};

use longhorn_git_workspace::{
    DeviceFlowEndpoints, GITHUB_ACCESS_TOKEN_URL, GithubAuthFailure, GithubAuthProgress,
    GithubTokenClient, TOKEN_REQUEST_TIMEOUT, TokenGrant, run_device_flow,
};
use nucleus_store::{GITHUB_HOST, GitHubAccount};
use reqwest::blocking::{Client, Response};
use secrecy::{ExposeSecret as _, SecretString};
use serde::{Deserialize, de::DeserializeOwned};

use super::AccountError;

const USER_URL: &str = "https://api.github.com/user";
const RESPONSE_LIMIT: usize = 64 * 1024;

pub(super) struct Transport {
    #[cfg(test)]
    device: String,
    token: String,
    user: String,
}

impl Transport {
    pub(super) fn github() -> Self {
        Self {
            #[cfg(test)]
            device: longhorn_git_workspace::GITHUB_DEVICE_CODE_URL.into(),
            token: GITHUB_ACCESS_TOKEN_URL.into(),
            user: USER_URL.into(),
        }
    }

    #[cfg(test)]
    pub(super) fn loopback(origin: &str) -> Self {
        Self {
            device: format!("{origin}/login/device/code"),
            token: format!("{origin}/login/oauth/access_token"),
            user: format!("{origin}/user"),
        }
    }

    pub(super) fn token_client(&self) -> Result<GithubTokenClient, AccountError> {
        #[cfg(test)]
        if self.token.starts_with("http://127.0.0.1:") {
            return Ok(GithubTokenClient::loopback_for_tests(&self.token)?);
        }
        Ok(GithubTokenClient::new(&self.token)?)
    }

    pub(super) fn device_flow(
        &self,
        client_id: &str,
        cancel: &AtomicBool,
        mut show_code: impl FnMut(String, String),
    ) -> Result<TokenGrant, AccountError> {
        let endpoints = DeviceFlowEndpoints::github();
        #[cfg(test)]
        let endpoints = if self.device.starts_with("http://127.0.0.1:") {
            DeviceFlowEndpoints::loopback_for_tests(&self.device, &self.token)?
        } else {
            endpoints
        };
        let grant = run_device_flow(client_id, &endpoints, cancel, &mut |progress| {
            if let GithubAuthProgress::AwaitingVerification {
                user_code,
                verification_uri,
            } = progress
            {
                show_code(verification_uri, user_code);
            }
        })?;
        Ok(grant)
    }

    pub(super) fn validate_account(
        &self,
        token: &SecretString,
    ) -> Result<GitHubAccount, AccountError> {
        #[derive(Deserialize)]
        struct Profile {
            id: u64,
            login: String,
        }
        let response = client()?
            .get(&self.user)
            .bearer_auth(token.expose_secret())
            .header("accept", "application/vnd.github+json")
            .header("x-github-api-version", "2022-11-28")
            .send()
            .map_err(|_| GithubAuthFailure::Offline)?;
        if response.status().as_u16() == 401 {
            return Err(GithubAuthFailure::SignInExpired.into());
        }
        let profile: Profile = bounded_json(response)?;
        let account = GitHubAccount {
            host: GITHUB_HOST.into(),
            user_id: profile.id.to_string(),
            login: profile.login,
        };
        if !account.valid() {
            return Err(AccountError::Identity);
        }
        Ok(account)
    }
}

fn client() -> Result<Client, GithubAuthFailure> {
    Client::builder()
        .timeout(TOKEN_REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("nucleus-github-accounts")
        .no_proxy()
        .build()
        .map_err(|_| GithubAuthFailure::Failed)
}

fn bounded_json<T: DeserializeOwned>(response: Response) -> Result<T, GithubAuthFailure> {
    let status = response.status();
    if status.is_server_error() || status.as_u16() == 429 {
        return Err(GithubAuthFailure::Offline);
    }
    if !status.is_success() {
        return Err(GithubAuthFailure::Failed);
    }
    let mut body = Vec::new();
    response
        .take(RESPONSE_LIMIT as u64 + 1)
        .read_to_end(&mut body)
        .map_err(|_| GithubAuthFailure::Offline)?;
    if body.len() > RESPONSE_LIMIT {
        return Err(GithubAuthFailure::Failed);
    }
    serde_json::from_slice(&body).map_err(|_| GithubAuthFailure::Failed)
}
