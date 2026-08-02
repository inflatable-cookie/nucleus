use std::time::Duration;

use longhorn_command::{
    CommandBindingDefinition, CommandKeyChord, CommandKeyTrigger, CommandKeymapPreset,
    CommandPhysicalCode, CommandPlatform, CommandPlatformScope, CommandReservedChordPolicy,
    CommandTriggerModifiers,
};
use longhorn_command_config::{
    CommandCatalogueSnapshot, CommandKeymapBackupPolicy, CommandKeymapCommit,
    CommandKeymapLoadOutcome, CommandKeymapMutationResult, CommandKeymapPreview,
    CommandKeymapPreviewResult, CommandKeymapReset, CommandKeymapService, NoCommandKeymapMigration,
    RegisteredCommandKeymapDomain,
};
use longhorn_config::{
    ConfigStore, CoordinationAuthority, DomainDescriptor, DomainFilePath, DurabilityRequirement,
    MutationOptions, StorageClass, StorageRoots,
};
use longhorn_core::{CommandBindingId, CommandContextId, CommandId, DomainId, SchemaVersion};
use longhorn_tauri_command::{CommandHostAuthority, CommandHostError};
use serde_json::Value;

use super::catalogue::build_registry;

const LOCK_TIMEOUT: Duration = Duration::from_secs(1);
const DEFAULT_PRESET_ID: &str = "nucleus:default";

type NucleusKeymapDomain =
    RegisteredCommandKeymapDomain<NucleusReservedChords, NoCommandKeymapMigration>;

pub(super) struct NucleusCommandHostAuthority {
    store: ConfigStore,
    service: CommandKeymapService<NucleusReservedChords, NoCommandKeymapMigration>,
    options: MutationOptions,
}

impl NucleusCommandHostAuthority {
    pub(super) fn new(roots: StorageRoots) -> Result<Self, String> {
        let domain = keymap_domain()?;
        let coordination = CoordinationAuthority::new(roots.data())
            .map_err(|error| format!("command coordination failed: {error}"))?;
        let mut store = ConfigStore::new(roots, coordination);
        store
            .register(&domain)
            .map_err(|error| format!("register command keymap domain failed: {error}"))?;
        Ok(Self {
            store,
            service: CommandKeymapService::new(domain),
            options: MutationOptions::new(LOCK_TIMEOUT, DurabilityRequirement::Durable),
        })
    }

    fn authorize(caller: &str) -> Result<(), CommandHostError> {
        if caller == "main" {
            Ok(())
        } else {
            Err(CommandHostError::authority(
                "command caller is not authorized",
                false,
            ))
        }
    }

    fn operational(error: impl std::fmt::Display) -> CommandHostError {
        CommandHostError::authority(error.to_string(), true)
    }
}

impl CommandHostAuthority for NucleusCommandHostAuthority {
    fn catalogue(&mut self, caller: &str) -> Result<CommandCatalogueSnapshot, CommandHostError> {
        Self::authorize(caller)?;
        Ok(self.service.catalogue())
    }

    fn keymap(&mut self, caller: &str) -> Result<CommandKeymapLoadOutcome, CommandHostError> {
        Self::authorize(caller)?;
        self.service
            .load(&self.store, LOCK_TIMEOUT)
            .map_err(Self::operational)
    }

    fn preview(
        &mut self,
        caller: &str,
        request: CommandKeymapPreview,
    ) -> Result<CommandKeymapPreviewResult, CommandHostError> {
        Self::authorize(caller)?;
        self.service
            .preview(&self.store, &request, LOCK_TIMEOUT)
            .map_err(Self::operational)
    }

    fn commit(
        &mut self,
        caller: &str,
        request: CommandKeymapCommit,
    ) -> Result<CommandKeymapMutationResult, CommandHostError> {
        Self::authorize(caller)?;
        self.service
            .commit(&self.store, &request, self.options)
            .map_err(Self::operational)
    }

    fn reset(
        &mut self,
        caller: &str,
        request: CommandKeymapReset,
    ) -> Result<CommandKeymapMutationResult, CommandHostError> {
        Self::authorize(caller)?;
        self.service
            .reset(&self.store, &request, self.options)
            .map_err(Self::operational)
    }
}

fn keymap_domain() -> Result<NucleusKeymapDomain, String> {
    let descriptor = DomainDescriptor::new(
        id::<DomainId>("nucleus.commands.keymap")?,
        SchemaVersion::new(1).map_err(|error| error.to_string())?,
        StorageClass::UserConfig,
        Some(DomainFilePath::new("commands/keymap.json").map_err(|error| error.to_string())?),
    )
    .map_err(|error| error.to_string())?;
    RegisteredCommandKeymapDomain::new(
        descriptor,
        build_registry()?,
        vec![default_preset()?],
        id(DEFAULT_PRESET_ID)?,
        NucleusReservedChords,
        NoCommandKeymapMigration,
        CommandKeymapBackupPolicy::Include,
    )
    .map_err(|error| error.to_string())
}

fn default_preset() -> Result<CommandKeymapPreset, String> {
    Ok(CommandKeymapPreset {
        id: id(DEFAULT_PRESET_ID)?,
        version: SchemaVersion::new(1).map_err(|error| error.to_string())?,
        bindings: vec![
            binding_with_shift(
                "nucleus:default:show-command-palette",
                "KeyP",
                "global",
                "nucleus:shell.show-command-palette",
            )?,
            binding(
                "nucleus:default:open-settings",
                "Comma",
                "global",
                "nucleus:shell.open-settings",
            )?,
            binding(
                "nucleus:default:quick-open",
                "KeyP",
                "editor",
                "nucleus:editor.quick-open",
            )?,
            binding(
                "nucleus:default:save-editor",
                "KeyS",
                "editor",
                "nucleus:editor.save",
            )?,
        ],
    })
}

fn binding_with_shift(
    binding_id: &str,
    code: &str,
    context_id: &str,
    command_id: &str,
) -> Result<CommandBindingDefinition, String> {
    let mut trigger = primary_trigger(code)?;
    trigger.modifiers.shift = true;
    Ok(CommandBindingDefinition {
        id: id::<CommandBindingId>(binding_id)?,
        platform: CommandPlatformScope::Any,
        trigger,
        context_id: id::<CommandContextId>(context_id)?,
        command_id: id::<CommandId>(command_id)?,
        arguments: Value::Null,
    })
}

fn binding(
    binding_id: &str,
    code: &str,
    context_id: &str,
    command_id: &str,
) -> Result<CommandBindingDefinition, String> {
    Ok(CommandBindingDefinition {
        id: id::<CommandBindingId>(binding_id)?,
        platform: CommandPlatformScope::Any,
        trigger: primary_trigger(code)?,
        context_id: id::<CommandContextId>(context_id)?,
        command_id: id::<CommandId>(command_id)?,
        arguments: Value::Null,
    })
}

fn primary_trigger(code: &str) -> Result<CommandKeyTrigger, String> {
    Ok(CommandKeyTrigger {
        code: CommandPhysicalCode::new(code).map_err(|error| error.to_string())?,
        modifiers: CommandTriggerModifiers {
            primary: true,
            ..CommandTriggerModifiers::default()
        },
    })
}

#[derive(Clone, Copy, Debug)]
struct NucleusReservedChords;

impl CommandReservedChordPolicy for NucleusReservedChords {
    fn is_reserved(&self, platform: CommandPlatform, chord: &CommandKeyChord) -> bool {
        let code = chord.code.as_str();
        let modifiers = chord.modifiers;
        match platform {
            CommandPlatform::MacOs => {
                modifiers.meta
                    && !modifiers.control
                    && !modifiers.alt
                    && !modifiers.shift
                    && matches!(code, "KeyQ" | "KeyH" | "KeyM" | "Space")
            }
            CommandPlatform::Windows => {
                (modifiers.alt
                    && !modifiers.control
                    && !modifiers.shift
                    && !modifiers.meta
                    && code == "F4")
                    || (modifiers.meta
                        && !modifiers.control
                        && !modifiers.alt
                        && !modifiers.shift
                        && code == "KeyL")
            }
            CommandPlatform::Linux => {
                modifiers.alt
                    && !modifiers.control
                    && !modifiers.shift
                    && !modifiers.meta
                    && code == "F4"
            }
        }
    }
}

fn id<T>(value: &str) -> Result<T, String>
where
    T: std::str::FromStr,
    T::Err: std::fmt::Display,
{
    value.parse::<T>().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests;
