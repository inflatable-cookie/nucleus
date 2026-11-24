use std::{
    collections::BTreeMap,
    env, io,
    path::{Path, PathBuf},
};

use clap::Subcommand;
use nucleus_store::planning::{
    DecisionOption, MAX_TEXT_BYTES, PlanLane,
    legacy::{self, ImportMode},
    valid_key,
};
use reqwest::Method;
use serde_json::{Value, json};

use super::{Result, read_with_limit};

#[derive(Subcommand)]
pub(super) enum Action {
    /// Read the project's plan and lane documents.
    #[command(name = "plan.get")]
    PlanGet { project: String },
    /// Replace the ordered plan. Read a JSON array of lane entries from stdin.
    #[command(name = "plan.set")]
    PlanSet { project: String, version: u64 },
    /// Create or edit a lane. Read its Markdown from stdin. Use version 0 to create.
    #[command(name = "lane.put")]
    LanePut {
        project: String,
        key: String,
        version: u64,
        title: String,
        aim: String,
    },
    /// Set a lane's status. A closed lane requires a note.
    #[command(name = "lane.status")]
    LaneStatus {
        project: String,
        key: String,
        #[arg(value_parser = ["open", "done", "dropped"])]
        status: String,
        #[arg(long)]
        note: Option<String>,
    },
    /// List leads and papercuts with their current states.
    #[command(name = "item.list")]
    ItemList { project: String },
    /// Add a lead or papercut. Read the Markdown body from stdin.
    #[command(name = "item.add")]
    ItemAdd {
        project: String,
        #[arg(value_parser = ["lead", "papercut"])]
        kind: String,
        title: String,
        #[arg(long = "lane")]
        lanes: Vec<String>,
    },
    /// Replace an item's title, body and lanes. Read the Markdown body from stdin.
    #[command(name = "item.edit")]
    ItemEdit {
        project: String,
        id: String,
        title: String,
        #[arg(long = "lane")]
        lanes: Vec<String>,
    },
    /// Park a lead or papercut with a reason.
    #[command(name = "item.park")]
    ItemPark {
        project: String,
        id: String,
        reason: String,
        #[arg(long)]
        revisit_at: Option<String>,
    },
    /// Drop a lead or papercut.
    #[command(name = "item.drop")]
    ItemDrop {
        project: String,
        id: String,
        #[arg(long)]
        reason: Option<String>,
    },
    /// Admit a task from an item's current body.
    #[command(name = "item.promote")]
    ItemPromote { project: String, id: String },
    /// Admit a task directly. Read the brief from stdin.
    #[command(name = "task.add")]
    TaskAdd {
        project: String,
        #[arg(long)]
        id: Option<String>,
        #[arg(long)]
        reference: Option<String>,
        /// Review an existing GitHub PR at its expected head.
        #[arg(long, num_args = 2, value_names = ["PR_URL", "HEAD"])]
        review: Vec<String>,
    },
    /// List operator decisions.
    #[command(name = "decision.list")]
    DecisionList {
        project: String,
        #[arg(long)]
        pending: bool,
    },
    /// Ask the operator a question. Pass each option as --option id=label.
    #[command(name = "decision.add")]
    DecisionAdd {
        project: String,
        question: String,
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
    #[expect(
        clippy::too_many_lines,
        reason = "keep each CLI verb next to its complete wire request"
    )]
    pub(super) fn request(self) -> Result<(Method, String, Option<Value>)> {
        use Action as A;
        let (method, project, path, body) = match self {
            A::PlanGet { project } => (Method::GET, project, "plan".into(), None),
            A::PlanSet { project, version } => {
                let lanes: Vec<PlanLane> = serde_json::from_str(&stdin_text()?)?;
                (
                    Method::PUT,
                    project,
                    "plan".into(),
                    Some(json!({ "version": version, "lanes": lanes })),
                )
            }
            A::LanePut {
                project,
                key,
                version,
                title,
                aim,
            } => (
                Method::PUT,
                project,
                format!("lanes/{}", segment(&key)?),
                Some(
                    json!({ "version": version, "title": title, "aim": aim, "document": stdin_text()? }),
                ),
            ),
            A::LaneStatus {
                project,
                key,
                status,
                note,
            } => (
                Method::POST,
                project,
                format!("lanes/{}/status", segment(&key)?),
                Some(json!({ "status": status, "note": note })),
            ),
            A::ItemList { project } => (Method::GET, project, "items".into(), None),
            A::ItemAdd {
                project,
                kind,
                title,
                lanes,
            } => (
                Method::POST,
                project,
                "items".into(),
                Some(
                    json!({ "kind": kind, "title": title, "body": stdin_text()?, "lanes": lanes }),
                ),
            ),
            A::ItemEdit {
                project,
                id,
                title,
                lanes,
            } => (
                Method::PUT,
                project,
                format!("items/{}", segment(&id)?),
                Some(json!({ "title": title, "body": stdin_text()?, "lanes": lanes })),
            ),
            A::ItemPark {
                project,
                id,
                reason,
                revisit_at,
            } => (
                Method::POST,
                project,
                format!("items/{}/park", segment(&id)?),
                Some(json!({ "reason": reason, "revisitAt": revisit_at })),
            ),
            A::ItemDrop {
                project,
                id,
                reason,
            } => (
                Method::POST,
                project,
                format!("items/{}/drop", segment(&id)?),
                Some(json!({ "reason": reason })),
            ),
            A::ItemPromote { project, id } => (
                Method::POST,
                project,
                format!("items/{}/promote", segment(&id)?),
                None,
            ),
            A::TaskAdd {
                project,
                id,
                reference,
                review,
            } => (
                Method::POST,
                project,
                "tasks".into(),
                Some(json!({
                    "id": id, "reference": reference, "brief": stdin_text()?,
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
            A::DecisionAdd {
                project,
                question,
                options,
            } => (
                Method::POST,
                project,
                "decisions".into(),
                Some(json!({ "question": question, "options": options })),
            ),
            A::DecisionAnswer {
                project,
                id,
                option_id,
                note,
            } => (
                Method::POST,
                project,
                format!("decisions/{}/answer", segment(&id)?),
                Some(json!({ "optionId": option_id, "note": note })),
            ),
        };
        Ok((
            method,
            format!("/v1/planning/{}/{path}", segment(&project)?),
            body,
        ))
    }
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
        let storage = super::open_settings(Some(home))?.storage()?;
        legacy::apply_items(&scratch, source, &mapping, &storage)?
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

#[cfg(test)]
mod tests {
    use std::path::Path;

    use clap::{Parser, error::ErrorKind};

    use crate::{Action, Cli};

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
}
