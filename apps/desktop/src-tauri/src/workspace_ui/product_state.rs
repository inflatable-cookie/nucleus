use std::collections::{BTreeMap, BTreeSet};

use longhorn_config::{
    ConfigDomain, DomainDescriptor, DomainFilePath, DomainIssue, MigrationStep, StorageClass,
};
use longhorn_core::{DomainId, SchemaVersion};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::dto::{
    default_forge_diff_scope, WorkspaceEditorFileDto, WorkspaceForgeDiffDto, WorkspacePanelDto,
    WorkspacePanelPresentationDto, WorkspacePanelPresentationInputDto, WorkspaceProjectContextDto,
    WorkspaceRunReviewDto,
};
use super::registry::{default_title, kind_for_definition, panel_instance_id};

pub const DOMAIN_ID: &str = "nucleus.panel-presentations";
pub const DOMAIN_FILE: &str = "project-panel-presentations.json";
const SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PanelPresentationState {
    #[serde(default)]
    pub projects: BTreeMap<String, BTreeMap<String, PanelPresentation>>,
    #[serde(default)]
    pub contexts: BTreeMap<String, WorkspaceProjectContextDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PanelPresentation {
    pub external_id: String,
    pub title: String,
    #[serde(default)]
    pub resource_targets: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub editor_file: Option<WorkspaceEditorFileDto>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forge_diff: Option<WorkspaceForgeDiffDto>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_review: Option<WorkspaceRunReviewDto>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
}

impl PanelPresentation {
    pub fn from_panel(
        project_id: &str,
        panel: &WorkspacePanelDto,
    ) -> Result<(String, Self), String> {
        let internal_id = panel_instance_id(project_id, &panel.id)?;
        let title = panel.title.trim();
        if title.is_empty() || title.len() > 256 {
            return Err(format!(
                "panel {} title must contain 1..=256 bytes",
                panel.id
            ));
        }
        let resource_targets = normalize_resource_targets(&panel.resource_targets)?;
        let editor_file = if panel.kind == "editor" {
            panel
                .editor_file
                .clone()
                .map(normalize_editor_file)
                .transpose()?
        } else {
            None
        };
        let forge_diff = if panel.kind == "forgeDiff" {
            panel
                .forge_diff
                .clone()
                .map(normalize_forge_diff)
                .transpose()?
        } else {
            None
        };
        let run_review = if panel.kind == "runReview" {
            panel
                .run_review
                .clone()
                .map(normalize_run_review)
                .transpose()?
        } else {
            None
        };
        Ok((
            internal_id.as_str().to_owned(),
            Self {
                external_id: panel.id.clone(),
                title: title.to_owned(),
                resource_targets,
                editor_file,
                forge_diff,
                run_review,
                conversation_id: None,
            },
        ))
    }

    pub fn agent_chat(project_id: &str) -> Result<(String, Self), String> {
        let external_id = "panel:agent-chat".to_owned();
        let internal_id = panel_instance_id(project_id, &external_id)?;
        Ok((
            internal_id.as_str().to_owned(),
            Self {
                external_id,
                title: default_title("agentChat").to_owned(),
                resource_targets: BTreeMap::new(),
                editor_file: None,
                forge_diff: None,
                run_review: None,
                conversation_id: None,
            },
        ))
    }

    pub fn from_input(
        project_id: &str,
        input: &WorkspacePanelPresentationInputDto,
    ) -> Result<(String, Self), String> {
        let panel = WorkspacePanelDto {
            id: input.external_id.clone(),
            kind: input.kind.clone(),
            title: input.title.clone(),
            closeable: false,
            movable: false,
            resource_targets: input.resource_targets.clone(),
            editor_file: input.editor_file.clone(),
            forge_diff: input.forge_diff.clone(),
            run_review: input.run_review.clone(),
            allowed_regions: Vec::new(),
        };
        let (id, mut presentation) = Self::from_panel(project_id, &panel)?;
        presentation.conversation_id = match (&*input.kind, input.conversation_id.as_deref()) {
            ("agentChat", value) => normalize_optional_ref(value, "conversation id")?,
            (_, None) => None,
            (_, Some(_)) => {
                return Err("conversation attachment is only valid for Agent Chat".to_owned())
            }
        };
        Ok((id, presentation))
    }

    pub fn project(
        &self,
        panel_instance_id: &str,
        definition_id: &longhorn_core::PanelDefinitionId,
    ) -> Result<WorkspacePanelPresentationDto, String> {
        let kind = kind_for_definition(definition_id)?;
        if kind != "agentChat" && self.conversation_id.is_some() {
            return Err("conversation attachment is only valid for Agent Chat".to_owned());
        }
        Ok(WorkspacePanelPresentationDto {
            panel_instance_id: panel_instance_id.to_owned(),
            external_id: self.external_id.clone(),
            kind: kind.to_owned(),
            title: self.title.clone(),
            resource_targets: self.resource_targets.clone(),
            editor_file: self.editor_file.clone(),
            forge_diff: self.forge_diff.clone(),
            run_review: self.run_review.clone(),
            conversation_id: self.conversation_id.clone(),
        })
    }
}

pub struct PanelPresentationDomain {
    descriptor: DomainDescriptor,
}

impl PanelPresentationDomain {
    pub fn new() -> Result<Self, String> {
        let descriptor = DomainDescriptor::new(
            DomainId::new(DOMAIN_ID).map_err(|error| error.to_string())?,
            SchemaVersion::new(SCHEMA_VERSION).map_err(|error| error.to_string())?,
            StorageClass::UserConfig,
            Some(DomainFilePath::new(DOMAIN_FILE).map_err(|error| error.to_string())?),
        )
        .map_err(|error| error.to_string())?;
        Ok(Self { descriptor })
    }
}

impl ConfigDomain for PanelPresentationDomain {
    type Value = PanelPresentationState;

    fn descriptor(&self) -> &DomainDescriptor {
        &self.descriptor
    }

    fn default_value(&self) -> Self::Value {
        PanelPresentationState::default()
    }

    fn decode(&self, value: Value) -> Result<Self::Value, DomainIssue> {
        serde_json::from_value(value).map_err(|error| {
            DomainIssue::new(
                "nucleus-panel-presentations-decode",
                format!("decode Nucleus panel presentations failed: {error}"),
            )
        })
    }

    fn encode(&self, value: &Self::Value) -> Result<Value, DomainIssue> {
        serde_json::to_value(value).map_err(|error| {
            DomainIssue::new(
                "nucleus-panel-presentations-encode",
                format!("encode Nucleus panel presentations failed: {error}"),
            )
        })
    }

    fn validate(&self, value: &Self::Value) -> Result<(), DomainIssue> {
        if value.projects.len() > 4_096 {
            return Err(issue("too many project presentation scopes"));
        }
        for (project_id, records) in &value.projects {
            if project_id.is_empty() || project_id.len() > 512 {
                return Err(issue("panel presentation project id is invalid"));
            }
            if records.len() > 1_024 {
                return Err(issue("too many panel presentations in one project"));
            }
            let mut external_ids = BTreeSet::new();
            for (internal_id, record) in records {
                let expected = panel_instance_id(project_id, &record.external_id)
                    .map_err(|detail| issue(&detail))?;
                if internal_id != expected.as_str() {
                    return Err(issue(
                        "panel presentation key does not match its scoped identity",
                    ));
                }
                if !external_ids.insert(&record.external_id) {
                    return Err(issue("duplicate external panel id in one project"));
                }
                validate_record(record).map_err(|detail| issue(&detail))?;
            }
        }
        for (project_id, context) in &value.contexts {
            validate_project_context(project_id, context).map_err(|detail| issue(&detail))?;
        }
        Ok(())
    }

    fn validate_raw(
        &self,
        schema_version: SchemaVersion,
        value: &Value,
    ) -> Result<(), DomainIssue> {
        if schema_version.get() != SCHEMA_VERSION {
            return Err(issue("unsupported Nucleus panel presentation schema"));
        }
        let decoded = self.decode(value.clone())?;
        self.validate(&decoded)
    }

    fn migrate_one(
        &self,
        _from: SchemaVersion,
        _value: Value,
    ) -> Result<Option<MigrationStep>, DomainIssue> {
        Ok(None)
    }
}

fn validate_record(record: &PanelPresentation) -> Result<(), String> {
    if record.external_id.trim().is_empty() || record.external_id.len() > 512 {
        return Err("external panel id must contain 1..=512 bytes".to_owned());
    }
    if record.title.trim().is_empty() || record.title.len() > 256 {
        return Err("panel title must contain 1..=256 bytes".to_owned());
    }
    normalize_resource_targets(&record.resource_targets)?;
    if let Some(file) = record.editor_file.clone() {
        normalize_editor_file(file)?;
    }
    if let Some(diff) = record.forge_diff.clone() {
        normalize_forge_diff(diff)?;
    }
    if let Some(review) = record.run_review.clone() {
        normalize_run_review(review)?;
    }
    normalize_optional_ref(record.conversation_id.as_deref(), "conversation id")?;
    Ok(())
}

pub(super) fn normalize_project_context(
    project_id: &str,
    mut context: WorkspaceProjectContextDto,
) -> Result<WorkspaceProjectContextDto, String> {
    validate_project_context(project_id, &context)?;
    context.selected_goal_id =
        normalize_optional_ref(context.selected_goal_id.as_deref(), "selected Goal id")?;
    context.selected_task_id =
        normalize_optional_ref(context.selected_task_id.as_deref(), "selected Task id")?;
    context.active_conversation_id = normalize_optional_ref(
        context.active_conversation_id.as_deref(),
        "active conversation id",
    )?;
    Ok(context)
}

fn validate_project_context(
    project_id: &str,
    context: &WorkspaceProjectContextDto,
) -> Result<(), String> {
    if project_id.trim().is_empty() || project_id.len() > 512 {
        return Err("workspace context project id is invalid".to_owned());
    }
    normalize_optional_ref(context.selected_goal_id.as_deref(), "selected Goal id")?;
    normalize_optional_ref(context.selected_task_id.as_deref(), "selected Task id")?;
    normalize_optional_ref(
        context.active_conversation_id.as_deref(),
        "active conversation id",
    )?;
    Ok(())
}

fn normalize_optional_ref(value: Option<&str>, label: &str) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() || value.len() > 512 {
        return Err(format!("{label} must contain 1..=512 bytes"));
    }
    Ok(Some(value.to_owned()))
}

fn normalize_resource_targets(
    targets: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, String> {
    if targets.len() > 64 {
        return Err("panel resource targets exceed 64 entries".to_owned());
    }
    let mut normalized = BTreeMap::new();
    for (project_id, resource_id) in targets {
        let project_id = project_id.trim();
        let resource_id = resource_id.trim();
        if project_id.is_empty()
            || project_id.len() > 512
            || resource_id.is_empty()
            || resource_id.len() > 512
        {
            return Err("panel resource target ids must contain 1..=512 bytes".to_owned());
        }
        normalized.insert(project_id.to_owned(), resource_id.to_owned());
    }
    Ok(normalized)
}

fn normalize_editor_file(
    mut file: WorkspaceEditorFileDto,
) -> Result<WorkspaceEditorFileDto, String> {
    file.resource_id = file
        .resource_id
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    file.file_ref = file.file_ref.trim().to_owned();
    file.display_path = file
        .display_path
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    if file.file_ref.is_empty()
        || file.file_ref.len() > 512
        || file
            .resource_id
            .as_ref()
            .is_some_and(|value| value.len() > 512)
        || file
            .display_path
            .as_ref()
            .is_some_and(|value| value.len() > 4_096)
    {
        return Err("editor panel file attachment is invalid".to_owned());
    }
    Ok(file)
}

fn normalize_forge_diff(mut diff: WorkspaceForgeDiffDto) -> Result<WorkspaceForgeDiffDto, String> {
    diff.resource_id = diff.resource_id.trim().to_owned();
    diff.path = diff.path.trim().to_owned();
    diff.scope = match diff.scope.trim() {
        "staged" => "staged".to_owned(),
        "working" => "working".to_owned(),
        "all" => "all".to_owned(),
        _ => default_forge_diff_scope(),
    };
    if diff.resource_id.is_empty()
        || diff.resource_id.len() > 512
        || diff.path.is_empty()
        || diff.path.len() > 4_096
    {
        return Err("Forge diff panel attachment is invalid".to_owned());
    }
    Ok(diff)
}

fn normalize_run_review(mut review: WorkspaceRunReviewDto) -> Result<WorkspaceRunReviewDto, String> {
    review.run_id = review.run_id.trim().to_owned();
    if !review.run_id.starts_with("run:") || review.run_id.len() > 512 {
        return Err("run review panel attachment is invalid".to_owned());
    }
    Ok(review)
}

fn issue(detail: &str) -> DomainIssue {
    DomainIssue::new("nucleus-panel-presentations-invalid", detail)
}
