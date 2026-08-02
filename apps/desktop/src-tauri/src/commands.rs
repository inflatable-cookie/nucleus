// Cards 037-038 consume this foundation through the keymap and palette hosts.
// Keep the pre-integration library build quiet without exposing a generic IPC executor.
#![cfg_attr(not(test), allow(dead_code))]

mod catalogue;
mod keymap;
mod runtime;

use std::sync::Arc;

use longhorn_config::StorageRoots;
use longhorn_tauri_command::{CommandHandlerAssembly, CommandHostService, TauriCommandState};
use tauri::Manager;

pub(crate) fn install(app: &tauri::App, roots: StorageRoots) -> Result<(), String> {
    let authority = keymap::NucleusCommandHostAuthority::new(roots)?;
    let service: Arc<dyn CommandHostService> = Arc::new(CommandHandlerAssembly::new(authority));
    app.manage(TauriCommandState::new(service));
    Ok(())
}

#[cfg(test)]
pub(crate) use catalogue::NucleusCommandRoute;
#[cfg(test)]
pub(crate) use runtime::{
    NucleusCommandCapability, NucleusCommandContext, NucleusCommandExecutor, NucleusCommandService,
    NucleusCommandState, NucleusCommandStateSource,
};

#[cfg(test)]
mod tests;
