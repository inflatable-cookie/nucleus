use std::{
    collections::BTreeMap,
    env, io,
    path::{Path, PathBuf},
};

use clap::Subcommand;
use nucleus_core::Head;
use nucleus_store::planning::{
    DecisionOption, MAX_TEXT_BYTES, PlanLane,
    legacy::{self, ImportMode},
    valid_key,
};
use reqwest::{Method, Url};
use serde_json::{Value, json};

use super::{Result, read_with_limit};

#[derive(Subcommand)]
pub(super) enum Action {
    /// Read the project's plan and lane documents.
    #[command(name = "plan.get")]
    PlanGet { project: Option<String> },
    /// Replace the ordered plan. Read a JSON array of lane entries from stdin.
    #[command(
        name = "plan.set",
        override_usage = "nucleus plan.set [OPTIONS] [PROJECT] <VERSION>"
    )]
    PlanSet {
        #[arg(required = true, num_args = 1..=2, hide = true)]
        args: Vec<String>,
    },
    /// Read the report lane using the current run's ticket.
    #[command(name = "lane.get")]
    LaneGet {
        project: String,
        key: String,
        #[arg(long)]
        ticket: PathBuf,
    },
    /// Create or edit a lane. Read its Markdown from stdin. Use version 0 to create.
    #[command(
        name = "lane.put",
        override_usage = "nucleus lane.put [PROJECT] <KEY> <VERSION> <TITLE> <AIM>\n       nucleus lane.put <PROJECT> <KEY> <VERSION> --ticket <PATH>"
    )]
    LanePut {
        #[arg(required = true, num_args = 1..=5, hide = true)]
        args: Vec<String>,
        #[arg(long)]
        ticket: Option<PathBuf>,
    },
    /// Set a lane's status. A closed lane requires a note.
    #[command(
        name = "lane.status",
        override_usage = "nucleus lane.status [OPTIONS] [PROJECT] <KEY> <STATUS>"
    )]
    LaneStatus {
        #[arg(required = true, num_args = 1..=3, hide = true)]
        args: Vec<String>,
        #[arg(long)]
        note: Option<String>,
    },
    /// List leads and papercuts with their current states.
    #[command(name = "item.list")]
    ItemList { project: Option<String> },
    /// Add a lead or papercut. Read the Markdown body from stdin.
    #[command(
        name = "item.add",
        override_usage = "nucleus item.add [OPTIONS] [PROJECT] <KIND> <TITLE>"
    )]
    ItemAdd {
        #[arg(required = true, num_args = 1..=3, hide = true)]
        args: Vec<String>,
        #[arg(long = "lane")]
        lanes: Vec<String>,
    },
    /// Replace an item's title, body and lanes. Read the Markdown body from stdin.
    #[command(
        name = "item.edit",
        override_usage = "nucleus item.edit [OPTIONS] [PROJECT] <ID> <TITLE>"
    )]
    ItemEdit {
        #[arg(required = true, num_args = 1..=3, hide = true)]
        args: Vec<String>,
        #[arg(long = "lane")]
        lanes: Vec<String>,
    },
    /// Park a lead or papercut with a reason.
    #[command(
        name = "item.park",
        override_usage = "nucleus item.park [OPTIONS] [PROJECT] <ID> <REASON>"
    )]
    ItemPark {
        #[arg(required = true, num_args = 1..=3, hide = true)]
        args: Vec<String>,
        #[arg(long)]
        revisit_at: Option<String>,
    },
    /// Drop a lead or papercut.
    #[command(
        name = "item.drop",
        override_usage = "nucleus item.drop [OPTIONS] [PROJECT] <ID>"
    )]
    ItemDrop {
        #[arg(required = true, num_args = 1..=2, hide = true)]
        args: Vec<String>,
        #[arg(long)]
        reason: Option<String>,
    },
    /// Admit a task from an item's current body.
    #[command(
        name = "item.promote",
        override_usage = "nucleus item.promote [OPTIONS] [PROJECT] <ID>"
    )]
    ItemPromote {
        #[arg(required = true, num_args = 1..=2, hide = true)]
        args: Vec<String>,
    },
    /// Admit a task directly. Read the brief from stdin.
    #[command(name = "task.add")]
    TaskAdd {
        /// Project key or display name. Defaults to the caller's T3 project.
        project: Option<String>,
        #[arg(long)]
        repository: Option<String>,
        #[arg(long)]
        id: Option<String>,
        #[arg(long)]
        reference: Option<String>,
        /// Review an existing GitHub PR at its expected head.
        #[arg(long, num_args = 2, value_names = ["PR_URL", "HEAD"])]
        review: Vec<String>,
        /// Match this exact published integration tip at report-only admission.
        #[arg(long)]
        planning_commit: Option<Head>,
    },
    /// List operator decisions.
    #[command(name = "decision.list")]
    DecisionList {
        project: Option<String>,
        #[arg(long)]
        pending: bool,
    },
    /// Ask the operator a question. Pass each option as --option id=label.
    #[command(
        name = "decision.add",
        override_usage = "nucleus decision.add [OPTIONS] [PROJECT] <QUESTION>"
    )]
    DecisionAdd {
        #[arg(required = true, num_args = 1..=2, hide = true)]
        args: Vec<String>,
        #[arg(long = "option", required = true, value_parser = decision_option)]
        options: Vec<DecisionOption>,
    },
    /// Answer an operator decision.
    #[command(name = "decision.answer")]
    DecisionAnswer {
        project: String,
        id: String,
        option_id: String,
        #[arg(long)]
        note: Option<String>,
    },
}

impl Action {
    pub(super) fn uses_ticket(&self) -> bool {
        matches!(
            self,
            Self::LaneGet { .. }
                | Self::LanePut {
                    ticket: Some(_),
                    ..
                }
        )
    }

    pub(super) async fn run_ticket(self) -> Result<()> {
        let (method, project, key, ticket, body) = match self {
            Self::LaneGet {
                project,
                key,
                ticket,
            } => (Method::GET, project, key, ticket, None),
            Self::LanePut {
                args,
                ticket: Some(ticket),
            } => {
                let [project, key, version]: [String; 3] = args.try_into().map_err(|_| {
                    "run-ticket lane.put requires PROJECT KEY VERSION and reads the Markdown from stdin"
                })?;
                let version = version.parse::<u64>()?;
                (
                    Method::PUT,
                    project,
                    key,
                    ticket,
                    Some(json!({"version": version, "document": stdin_text()?})),
                )
            }
            _ => return Err("use an authenticated report ticket".into()),
        };
        let suffix = format!("lanes/{}/{}", segment(&project)?, segment(&key)?);
        let response = super::run_ticket_request(&ticket, method, &suffix, body).await?;
        let status = response.status();
        let result: Value = response.json().await?;
        if !status.is_success() {
            return Err(result["error"]
                .as_str()
                .unwrap_or("report lane operation failed")
                .to_owned()
                .into());
        }
        println!("{}", serde_json::to_string_pretty(&result)?);
        Ok(())
    }

    #[expect(
        clippy::too_many_lines,
        reason = "keep each CLI verb next to its complete wire request"
    )]
    pub(super) fn request(self) -> Result<(Method, String, Option<Value>)> {
        use Action as A;
        let (method, project, path, body) = match self {
            A::LaneGet { .. } => return Err("use an authenticated report ticket".into()),
            A::PlanGet { project } => (Method::GET, project, "plan".into(), None),
            A::PlanSet { args } => {
                let (project, [version]) = project_and_args(args)?;
                let version = version.parse::<u64>()?;
                let lanes: Vec<PlanLane> = serde_json::from_str(&stdin_text()?)?;
                (
                    Method::PUT,
                    project,
                    "plan".into(),
                    Some(json!({ "version": version, "lanes": lanes })),
                )
            }
            A::LanePut { args, .. } => {
                let (project, [key, version, title, aim]) = project_and_args(args)?;
                let version = version.parse::<u64>()?;
                (
                    Method::PUT,
                    project,
                    format!("lanes/{}", segment(&key)?),
                    Some(json!({
                        "version": version, "title": title, "aim": aim, "document": stdin_text()?,
                    })),
                )
            }
            A::LaneStatus { args, note } => {
                let (project, [key, status]) = project_and_args(args)?;
                if !matches!(status.as_str(), "open" | "done" | "dropped") {
                    return Err("lane status must be open, done or dropped".into());
                }
                (
                    Method::POST,
                    project,
                    format!("lanes/{}/status", segment(&key)?),
                    Some(json!({ "status": status, "note": note })),
                )
            }
            A::ItemList { project } => (Method::GET, project, "items".into(), None),
            A::ItemAdd { args, lanes } => {
                let (project, [kind, title]) = project_and_args(args)?;
                if !matches!(kind.as_str(), "lead" | "papercut") {
                    return Err("item kind must be lead or papercut".into());
                }
                (
                    Method::POST,
                    project,
                    "items".into(),
                    Some(
                        json!({ "kind": kind, "title": title, "body": stdin_text()?, "lanes": lanes }),
                    ),
                )
            }
            A::ItemEdit { args, lanes } => {
                let (project, [id, title]) = project_and_args(args)?;
                (
                    Method::PUT,
                    project,
                    format!("items/{}", segment(&id)?),
                    Some(json!({ "title": title, "body": stdin_text()?, "lanes": lanes })),
                )
            }
            A::ItemPark { args, revisit_at } => {
                let (project, [id, reason]) = project_and_args(args)?;
                (
                    Method::POST,
                    project,
                    format!("items/{}/park", segment(&id)?),
                    Some(json!({ "reason": reason, "revisitAt": revisit_at })),
                )
            }
            A::ItemDrop { args, reason } => {
                let (project, [id]) = project_and_args(args)?;
                (
                    Method::POST,
                    project,
                    format!("items/{}/drop", segment(&id)?),
                    Some(json!({ "reason": reason })),
                )
            }
            A::ItemPromote { args } => {
                let (project, [id]) = project_and_args(args)?;
                (
                    Method::POST,
                    project,
                    format!("items/{}/promote", segment(&id)?),
                    None,
                )
            }
            A::TaskAdd {
                project,
                repository,
                id,
                reference,
                review,
                planning_commit,
            } => (
                Method::POST,
                project,
                "tasks".into(),
                Some(json!({
                    "id": id, "reference": reference, "repository": repository, "brief": stdin_text()?,
                    "planningCommit": planning_commit,
                    "review": match review.as_slice() {
                        [url, head] => Some(json!({"url": url, "head": head})),
                        _ => None,
                    },
                })),
            ),
            A::DecisionList { project, pending } => (
                Method::GET,
                project,
                format!("decisions?pending={pending}"),
                None,
            ),
            A::DecisionAdd { args, options } => {
                let (project, [question]) = project_and_args(args)?;
                (
                    Method::POST,
                    project,
                    "decisions".into(),
                    Some(json!({ "question": question, "options": options })),
                )
            }
            A::DecisionAnswer {
                project,
                id,
                option_id,
                note,
            } => (
                Method::POST,
                Some(project),
                format!("decisions/{}/answer", segment(&id)?),
                Some(json!({ "optionId": option_id, "note": note })),
            ),
        };
        Ok((method, planning_path(project.as_deref(), &path)?, body))
    }
}

fn project_and_args<const N: usize>(
    mut args: Vec<String>,
) -> Result<(Option<String>, [String; N])> {
    // The previous form has exactly one extra argument, always at the front.
    let project = (args.len() == N + 1).then(|| args.remove(0));
    let args = args
        .try_into()
        .map_err(|_| "invalid number of planning arguments")?;
    Ok((project, args))
}

fn planning_path(project: Option<&str>, path: &str) -> Result<String> {
    let Some(project) = project else {
        return Ok(format!("/v1/planning-current/{path}"));
    };
    if valid_key(project) {
        return Ok(format!("/v1/planning/{project}/{path}"));
    }
    let mut url = Url::parse(&format!("http://localhost/v1/planning-current/{path}"))?;
    url.query_pairs_mut().append_pair("project", project);
    let query = url.query().ok_or("missing project selector")?;
    Ok(format!("{}?{query}", url.path()))
}

fn stdin_text() -> Result<String> {
    let limit = u64::try_from(MAX_TEXT_BYTES)?;
    Ok(String::from_utf8(read_with_limit(
        io::stdin().lock(),
        limit,
    )?)?)
}

fn segment(value: &str) -> Result<&str> {
    if valid_key(value) {
        Ok(value)
    } else {
        Err("invalid planning key or record ID".into())
    }
}

fn decision_option(value: &str) -> std::result::Result<DecisionOption, String> {
    let (id, label) = value.split_once('=').ok_or("expected id=label")?;
    if !valid_key(id) || label.trim().is_empty() {
        return Err("an option needs a valid ID and a label".into());
    }
    Ok(DecisionOption {
        id: id.into(),
        label: label.into(),
    })
}

pub(super) fn repository_mapping(input: &str) -> std::result::Result<(String, String), String> {
    let (repository, project) = input.split_once('=').ok_or("expected owner/repo=project")?;
    Ok((repository.into(), project.into()))
}

pub(super) fn import_items(
    source: &Path,
    repositories: Vec<(String, String)>,
    keep: bool,
    apply: Option<&Path>,
    profiles_only: bool,
) -> Result<()> {
    let scratch = env::var_os("NUCLEUS_SCRATCH_ROOT")
        .map(PathBuf::from)
        .ok_or("set NUCLEUS_SCRATCH_ROOT to the configured scratch root")?;
    let mut mapping = BTreeMap::new();
    for (repository, project) in repositories {
        if mapping.insert(repository, project).is_some() {
            return Err("supply only one project per legacy repository".into());
        }
    }
    let report = if let Some(home) = apply {
        let settings = super::open_settings(Some(home))?;
        if profiles_only {
            legacy::apply_profiles(&scratch, source, &settings)?
        } else {
            legacy::apply_items(&scratch, source, &mapping, &settings)?
        }
    } else {
        let mode = if keep {
            ImportMode::Keep
        } else {
            ImportMode::Rehearse
        };
        legacy::import_items(&scratch, source, &mapping, mode)?
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

pub(super) fn import_projects(source: &Path, apply: Option<&Path>) -> Result<()> {
    let scratch = env::var_os("NUCLEUS_SCRATCH_ROOT")
        .map(PathBuf::from)
        .ok_or("set NUCLEUS_SCRATCH_ROOT to the configured scratch root")?;
    let settings = apply
        .map(|home| super::open_settings(Some(home)))
        .transpose()?;
    let report = legacy::import_projects(&scratch, source, settings.as_ref())?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

pub(super) fn import_limits(source: &Path, apply: Option<&Path>) -> Result<()> {
    let scratch = env::var_os("NUCLEUS_SCRATCH_ROOT")
        .map(PathBuf::from)
        .ok_or("set NUCLEUS_SCRATCH_ROOT to the configured scratch root")?;
    let settings = apply
        .map(|home| super::open_settings(Some(home)))
        .transpose()?;
    let report = legacy::import_limits(&scratch, source, settings.as_ref())?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use clap::{Parser, error::ErrorKind};

    use super::Action as Planning;
    use crate::{Action, Cli};

    #[test]
    fn planning_cli_routes_implicit_and_explicit_projects() {
        for (args, expected) in [
            (&["plan.get"][..], "/v1/planning-current/plan"),
            (&["item.list", "product"], "/v1/planning/product/items"),
            (
                &["decision.list", "--pending", "Exact T3 Alpha"],
                "/v1/planning-current/decisions?pending=true&project=Exact+T3+Alpha",
            ),
            (
                &["item.park", "item-id", "--revisit-at", "2026-12-01", "Wait"],
                "/v1/planning-current/items/item-id/park",
            ),
            (
                &["item.park", "product", "item-id", "Wait"],
                "/v1/planning/product/items/item-id/park",
            ),
            (
                &["item.promote", "item-id"],
                "/v1/planning-current/items/item-id/promote",
            ),
        ] {
            let parsed = Cli::try_parse_from(["nucleus"].into_iter().chain(args.iter().copied()))
                .expect("planning command");
            let Action::Planning(action) = parsed.action else {
                panic!("expected a planning command");
            };
            let (_, path, _) = action.request().expect("planning request");
            assert_eq!(path, expected);
        }
    }

    #[test]
    fn planning_item_add_distinguishes_project_from_kind_by_arity() {
        for (positionals, expected) in [
            (&["papercut", "Fix it"][..], None),
            (&["lead", "papercut", "Fix it"], Some("lead")),
        ] {
            let parsed = Cli::try_parse_from(
                ["nucleus", "item.add"]
                    .into_iter()
                    .chain(positionals.iter().copied())
                    .chain(["--lane", "interface"]),
            )
            .expect("item.add");
            let Action::Planning(Planning::ItemAdd { args, lanes }) = parsed.action else {
                panic!("expected item.add");
            };
            let (project, [kind, title]) = super::project_and_args(args).expect("item arguments");
            assert_eq!(project.as_deref(), expected);
            assert_eq!(kind, "papercut");
            assert_eq!(title, "Fix it");
            assert_eq!(lanes, ["interface"]);
        }
    }

    #[test]
    fn report_only_lane_put_uses_a_ticket_without_controller_metadata() {
        let input = ["nucleus", "lane.put", "project", "qa", "1"];
        let worker = Cli::try_parse_from(input.into_iter().chain(["--ticket", "/scratch/ticket"]))
            .expect("run-ticket edit");
        assert!(matches!(worker.action, Action::Planning(action) if action.uses_ticket()));
        let controller = Cli::try_parse_from(input.into_iter().chain(["QA", "Qualification"]))
            .expect("controller edit");
        assert!(matches!(controller.action, Action::Planning(action) if !action.uses_ticket()));
    }

    #[test]
    fn legacy_planning_apply_requires_a_profile_and_conflicts_with_keep() {
        let args = [
            "nucleus-engine",
            "item.import",
            "copy.sqlite",
            "--repository",
            "example/repo=project",
            "--apply",
        ];
        assert!(Cli::try_parse_from(args).is_err());
        let parsed = Cli::try_parse_from(args.into_iter().chain(["/scratch/profile"]))
            .expect("explicit profile");
        assert!(matches!(
            parsed.action,
            Action::ImportItems { apply: Some(home), keep: false, .. }
                if home == Path::new("/scratch/profile")
        ));
        let result = Cli::try_parse_from(args.into_iter().chain(["/scratch/profile", "--keep"]));
        assert!(matches!(result, Err(error) if error.kind() == ErrorKind::ArgumentConflict));
    }

    #[test]
    fn legacy_profiles_only_requires_apply_and_skips_repository_mapping() {
        let args = ["nucleus-engine", "item.import", "copy.sqlite"];
        assert!(Cli::try_parse_from(args.into_iter().chain(["--profiles-only"])).is_err());
        assert!(
            Cli::try_parse_from(args.into_iter().chain(["--apply", "/scratch/profile"])).is_err()
        );
        let parsed = Cli::try_parse_from(args.into_iter().chain([
            "--profiles-only",
            "--apply",
            "/scratch/profile",
        ]))
        .expect("profiles-only apply");
        assert!(matches!(
            parsed.action,
            Action::ImportItems { profiles_only: true, repositories, .. } if repositories.is_empty()
        ));
    }
}
