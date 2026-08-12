//! Workspace layout domain persistence: migration publication and layout and
//! presentation domain loads and writes.
//!
//! Split from the runtime god file; behavior unchanged.

use longhorn_surfaces::SurfaceDocument;
use longhorn_surfaces_config::load_or_default;

use super::super::migration;
use super::super::product_state::PanelPresentationState;
use super::WorkspaceUiRuntime;

impl WorkspaceUiRuntime {
    pub(super) fn publish_migration(
        &self,
        prepared: &migration::PreparedLayoutMigration,
    ) -> Result<(), String> {
        if prepared.publish_presentations {
            let value = prepared.presentations.clone();
            self.store
                .mutate(&self.presentation_domain, self.options, |current| {
                    *current = value.clone();
                    Ok(())
                })
                .map_err(|error| {
                    format!("publish migrated Nucleus panel presentations failed: {error}")
                })?;
        }
        if prepared.publish_layout {
            let value = prepared.document.clone();
            self.store
                .mutate(&self.layout_domain, self.options, |current| {
                    *current = value.clone();
                    Ok(())
                })
                .map_err(|error| format!("publish migrated Nucleus layouts failed: {error}"))?;
        }
        self.load_layout()?;
        self.load_presentations()?;
        Ok(())
    }

    /// The stored workspace, or the default when it cannot be read.
    ///
    /// A project opens rather than refusing to. Longhorn leaves the unreadable
    /// source on disk untouched, so the arrangement stays recoverable and only
    /// this session falls back. A `StoreError` still propagates: that is the
    /// store failing rather than the document being wrong.
    pub(super) fn load_layout(&self) -> Result<SurfaceDocument, String> {
        let (document, fallback) = load_or_default(&self.store, &self.layout_domain)
            .map_err(|error| format!("load Nucleus layout domain failed: {error}"))?;
        if fallback.discarded_stored_state() {
            eprintln!(
                "the stored Nucleus workspace could not be read ({fallback:?}); opening on the default arrangement"
            );
        }
        Ok(document)
    }

    pub(super) fn load_presentations(&self) -> Result<PanelPresentationState, String> {
        match self
            .store
            .load(&self.presentation_domain)
            .map_err(|error| format!("load Nucleus panel presentations failed: {error}"))?
        {
            longhorn_config::LoadOutcome::Ready(loaded) => Ok(loaded.value),
            other => Err(format!(
                "Nucleus panel presentation domain requires recovery: {other:?}"
            )),
        }
    }

    pub(super) fn publish_presentations(&self, value: PanelPresentationState) -> Result<(), String> {
        self.store
            .mutate(&self.presentation_domain, self.options, |current| {
                *current = value.clone();
                Ok(())
            })
            .map_err(|error| format!("publish Nucleus panel presentations failed: {error}"))?;
        Ok(())
    }
}
