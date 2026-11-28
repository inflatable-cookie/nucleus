use axum::{
    Extension, Json, Router,
    extract::{Path, State, rejection::JsonRejection},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use nucleus_core::Authority;
use serde::Deserialize;
use serde_json::json;

use super::{Api, ApiError, body};
use crate::github_accounts::{AccountError, FlowView, SettingsView};

pub(super) fn routes(prefix: &str) -> Router<Api> {
    Router::new()
        .route(prefix, get(view))
        .route(&format!("{prefix}/reviewer"), put(select))
        .route(&format!("{prefix}/sign-in"), post(start))
        .route(&format!("{prefix}/flows/{{id}}"), get(flow).delete(cancel))
        .route(&format!("{prefix}/flows/{{id}}/confirm"), post(confirm))
        .route(
            &format!("{prefix}/accounts/{{id}}/sign-out"),
            post(sign_out),
        )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Start {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Selection {
    revision: String,
    #[serde(deserialize_with = "Option::deserialize")]
    account_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Revision {
    revision: String,
}

enum AccountApiError {
    Api(ApiError),
    Account(AccountError),
}

impl From<ApiError> for AccountApiError {
    fn from(value: ApiError) -> Self {
        Self::Api(value)
    }
}

impl From<AccountError> for AccountApiError {
    fn from(value: AccountError) -> Self {
        Self::Account(value)
    }
}

impl IntoResponse for AccountApiError {
    fn into_response(self) -> Response {
        match self {
            Self::Api(error) => error.into_response(),
            Self::Account(error) => {
                let status = match error {
                    AccountError::Conflict
                    | AccountError::FlowActive
                    | AccountError::Saving
                    | AccountError::NotReady
                    | AccountError::WorkerUsesAccount => StatusCode::CONFLICT,
                    AccountError::MissingAccount | AccountError::MissingFlow => {
                        StatusCode::NOT_FOUND
                    }
                    AccountError::Denied | AccountError::Expired => StatusCode::GONE,
                    _ => StatusCode::SERVICE_UNAVAILABLE,
                };
                (status, Json(json!({ "error": error.to_string() }))).into_response()
            }
        }
    }
}

fn operator(authority: &Authority) -> Result<(), ApiError> {
    if matches!(authority, Authority::Operator { .. }) {
        Ok(())
    } else {
        Err(ApiError::GitHubAccountsOperator)
    }
}

async fn view(
    State(api): State<Api>,
    Extension(authority): Extension<Authority>,
) -> Result<Json<SettingsView>, AccountApiError> {
    operator(&authority)?;
    Ok(Json(api.service.github_accounts.view().await?))
}

async fn select(
    State(api): State<Api>,
    Extension(authority): Extension<Authority>,
    input: Result<Json<Selection>, JsonRejection>,
) -> Result<Json<SettingsView>, AccountApiError> {
    operator(&authority)?;
    let input = body(input)?;
    let result = api
        .service
        .github_accounts
        .select(input.revision, input.account_id)
        .await?;
    api.service.settings_changes.send_replace(());
    Ok(Json(result))
}

async fn start(
    State(api): State<Api>,
    Extension(authority): Extension<Authority>,
    input: Result<Json<Start>, JsonRejection>,
) -> Result<Json<FlowView>, AccountApiError> {
    operator(&authority)?;
    body(input)?;
    Ok(Json(api.service.github_accounts.start_device()?))
}

async fn flow(
    State(api): State<Api>,
    Extension(authority): Extension<Authority>,
    Path(id): Path<String>,
) -> Result<Json<FlowView>, AccountApiError> {
    operator(&authority)?;
    Ok(Json(api.service.github_accounts.flow_view(&id)?))
}

async fn cancel(
    State(api): State<Api>,
    Extension(authority): Extension<Authority>,
    Path(id): Path<String>,
) -> Result<StatusCode, AccountApiError> {
    operator(&authority)?;
    api.service.github_accounts.cancel(&id)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn confirm(
    State(api): State<Api>,
    Extension(authority): Extension<Authority>,
    Path(id): Path<String>,
    input: Result<Json<Revision>, JsonRejection>,
) -> Result<Json<SettingsView>, AccountApiError> {
    operator(&authority)?;
    let input = body(input)?;
    let result = api
        .service
        .github_accounts
        .confirm(id, input.revision)
        .await?;
    api.service.settings_changes.send_replace(());
    Ok(Json(result))
}

async fn sign_out(
    State(api): State<Api>,
    Extension(authority): Extension<Authority>,
    Path(id): Path<String>,
    input: Result<Json<Revision>, JsonRejection>,
) -> Result<Json<SettingsView>, AccountApiError> {
    operator(&authority)?;
    let input = body(input)?;
    let result = api
        .service
        .github_accounts
        .sign_out(input.revision, id)
        .await?;
    api.service.settings_changes.send_replace(());
    Ok(Json(result))
}
