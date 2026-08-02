use std::{fmt::Display, str::FromStr};

use longhorn_command::{
    CommandArgumentSchema, CommandCapabilityDefinition, CommandContextDefinition,
    CommandDefinition, CommandKeyword, CommandLimits, CommandRegistry, CommandRegistryBuilder,
    CommandRegistryGeneration, CommandVisibility,
};
use longhorn_core::{CommandCategoryId, CommandRouteId};

use super::COMMAND_SPEC_GROUPS;

const REGISTRY_GENERATION: CommandRegistryGeneration = CommandRegistryGeneration::new(2);

pub(crate) fn build_registry() -> Result<CommandRegistry, String> {
    let mut builder = CommandRegistryBuilder::new(REGISTRY_GENERATION, CommandLimits::default());
    for (context, parent) in [
        ("global", None),
        ("workspace", Some("global")),
        ("project", Some("workspace")),
        ("panel", Some("project")),
        ("agent-chat", Some("panel")),
        ("editor", Some("panel")),
        ("forge", Some("panel")),
    ] {
        builder
            .register_context(CommandContextDefinition {
                id: id(context)?,
                parent_id: parent.map(id).transpose()?,
            })
            .map_err(|error| error.to_string())?;
    }
    for capability in [
        "nucleus:shell",
        "nucleus:projects",
        "nucleus:threads",
        "nucleus:panels",
        "nucleus:editor",
        "nucleus:forge",
        "nucleus:agent-turns",
    ] {
        builder
            .register_capability(CommandCapabilityDefinition {
                id: id(capability)?,
            })
            .map_err(|error| error.to_string())?;
    }
    for group in COMMAND_SPEC_GROUPS {
        for spec in *group {
            builder
                .register_command(CommandDefinition {
                    id: id(spec.id)?,
                    label: spec.label.to_owned(),
                    description: Some(spec.description.to_owned()),
                    category_path: vec![id::<CommandCategoryId>(spec.category)?],
                    keywords: spec
                        .keywords
                        .iter()
                        .map(|keyword| {
                            CommandKeyword::new(*keyword).map_err(|error| error.to_string())
                        })
                        .collect::<Result<Vec<_>, _>>()?,
                    icon: None,
                    allowed_contexts: vec![id(spec.context)?],
                    required_capabilities: vec![id(spec.capability)?],
                    visibility: CommandVisibility::ALL,
                    text_input_policy: spec.text_input_policy,
                    route: id::<CommandRouteId>(spec.route.as_str())?,
                    arguments: CommandArgumentSchema::None,
                })
                .map_err(|error| error.to_string())?;
        }
    }
    builder.seal().map_err(|error| error.to_string())
}

fn id<T>(value: &str) -> Result<T, String>
where
    T: FromStr,
    T::Err: Display,
{
    value.parse::<T>().map_err(|error| error.to_string())
}
