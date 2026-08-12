//! Browser panel runtime: island lifecycle, native-content protocol hosting,
//! and child-view adaptation.
//!
//! Split from the browser_panel god file; behavior unchanged.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
};

use longhorn_core::{
    ClientPoint, ClientRect, ClientSize, NativeContentRequestId, RoundingMode, ScaleFactor,
    WindowId,
};
use longhorn_native_content::{
    AttachGeneration, DesiredPresence, DesiredState, DesiredUpdate, DesiredVisibility, FocusIntent,
    InputRoutingMode, NativeContentAuthorityEpoch, NativeContentConnectRequest,
    NativeContentConnectResult, NativeContentContentSizeDecisionRequest,
    NativeContentContentSizeDecisionResult, NativeContentCoordinator,
    NativeContentDesiredUpdateRequest, NativeContentDesiredUpdateResult, NativeContentIslandId,
    NativeContentKindId, NativeContentProtocolVersion, NativeContentSnapshotRequest,
    NativeContentSnapshotResult, VisibilityReasonId,
};
use longhorn_tauri_native_content_child_view::{
    ChildViewAdapter, ChildViewAdapterEvent, ChildViewLabel, ChildViewPolicyHooks, ChildViewSpec,
    TauriChildViewRuntime, CHILD_VIEW_CAPABILITIES,
};
use tauri::{AppHandle, Wry};

use super::cursor::{cursor_initialization_script, reset_cursor};
use super::events::{emit_changed, emit_evidence, emit_policy_event};
use super::url::{
    child_label, is_supported_http_url, normalize_http_url, string_error, validate_island_id,
};
use super::{DEFAULT_BROWSER_URL, HOST_WINDOW_ID, HOST_WINDOW_LABEL};

type Adapter = ChildViewAdapter<TauriChildViewRuntime<Wry>>;

pub(super) struct BrowserIsland {
    host: longhorn_native_content::NativeContentProtocolHost,
    adapter: Adapter,
}

pub(super) struct BrowserPanelRuntimeInner {
    islands: HashMap<NativeContentIslandId, BrowserIsland>,
    last_generation: HashMap<NativeContentIslandId, AttachGeneration>,
}

#[derive(Clone)]
pub struct BrowserPanelRuntime {
    app: AppHandle<Wry>,
    inner: Arc<Mutex<BrowserPanelRuntimeInner>>,
}

impl BrowserPanelRuntime {
    pub(super) fn new(app: AppHandle<Wry>) -> Self {
        Self {
            app,
            inner: Arc::new(Mutex::new(BrowserPanelRuntimeInner {
                islands: HashMap::new(),
                last_generation: HashMap::new(),
            })),
        }
    }

    fn ensure_island(&self, island_id: &NativeContentIslandId) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "browser runtime is unavailable")?;
        if inner.islands.contains_key(island_id) {
            return Ok(());
        }
        let generation = inner
            .last_generation
            .get(island_id)
            .copied()
            .map(|value| value.checked_next())
            .transpose()
            .map_err(string_error)?
            .unwrap_or(AttachGeneration::INITIAL);
        let island = self.create_island(island_id.clone(), generation)?;
        inner.last_generation.insert(island_id.clone(), generation);
        inner.islands.insert(island_id.clone(), island);
        Ok(())
    }

    fn create_island(
        &self,
        island_id: NativeContentIslandId,
        generation: AttachGeneration,
    ) -> Result<BrowserIsland, String> {
        validate_island_id(&island_id)?;
        let source = normalize_http_url(DEFAULT_BROWSER_URL)?;
        let app = self.app.clone();
        let observation_app = self.app.clone();
        let weak_inner = Arc::downgrade(&self.inner);
        let observed_island_id = island_id.clone();
        let policy_hooks = ChildViewPolicyHooks::new(
            cursor_initialization_script(),
            Arc::new(move |event| {
                emit_policy_event(&app, &observed_island_id, event.clone());
                if matches!(event, longhorn_tauri_native_content_child_view::ChildViewPolicyEvent::PageLoadFinished { .. }) {
                    queue_observation_refresh(
                        observation_app.clone(),
                        weak_inner.clone(),
                        observed_island_id.clone(),
                    );
                }
            }),
        )
        .map_err(string_error)?;
        let host_window_id = WindowId::new(HOST_WINDOW_ID).map_err(string_error)?;
        let spec = ChildViewSpec::new(
            island_id.clone(),
            host_window_id.clone(),
            ChildViewLabel::new(HOST_WINDOW_LABEL).map_err(string_error)?,
            child_label(&island_id)?,
            source,
            None,
            Arc::new(is_supported_http_url),
            policy_hooks,
        )
        .map_err(string_error)?;
        let evidence_app = self.app.clone();
        let evidence_island_id = island_id.clone();
        let adapter = ChildViewAdapter::new(
            TauriChildViewRuntime::new(self.app.clone()),
            spec,
            Arc::new(move |event: ChildViewAdapterEvent| {
                emit_evidence(&evidence_app, &evidence_island_id, "adapter", event);
            }),
        );
        let desired = DesiredState::new(
            island_id,
            NativeContentKindId::new("nucleus:browser").map_err(string_error)?,
            CHILD_VIEW_CAPABILITIES,
            DesiredUpdate::new(
                generation,
                host_window_id,
                ClientRect::new(
                    ClientPoint::new(0.0, 0.0).map_err(string_error)?,
                    ClientSize::new(1.0, 1.0).map_err(string_error)?,
                ),
                ScaleFactor::from_thousandths(1000).map_err(string_error)?,
                RoundingMode::Nearest,
                DesiredPresence::Present,
                DesiredVisibility::Hidden {
                    reason: VisibilityReasonId::new("nucleus:bootstrap").map_err(string_error)?,
                },
                FocusIntent::Unchanged,
                InputRoutingMode::NativeDirect,
            ),
        )
        .map_err(string_error)?;
        Ok(BrowserIsland {
            host: longhorn_native_content::NativeContentProtocolHost::new(
                NativeContentAuthorityEpoch::new(1).map_err(string_error)?,
                NativeContentCoordinator::new(desired),
            ),
            adapter,
        })
    }

    pub(super) fn connect(
        &self,
        request: NativeContentConnectRequest,
    ) -> Result<NativeContentConnectResult, String> {
        self.ensure_island(&request.island_id)?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "browser runtime is unavailable")?;
        let island = inner
            .islands
            .get_mut(&request.island_id)
            .ok_or("browser island is unavailable")?;
        Ok(island.host.connect(request))
    }

    pub(super) fn snapshot(
        &self,
        request: NativeContentSnapshotRequest,
    ) -> Result<NativeContentSnapshotResult, String> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| "browser runtime is unavailable")?;
        let island = inner
            .islands
            .get(&request.island_id)
            .ok_or("browser island is unavailable")?;
        Ok(island.host.snapshot(request))
    }

    pub(super) fn update_desired(
        &self,
        request: NativeContentDesiredUpdateRequest,
    ) -> Result<NativeContentDesiredUpdateResult, String> {
        let island_id = request.island_id.clone();
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "browser runtime is unavailable")?;
        let island = inner
            .islands
            .get_mut(&island_id)
            .ok_or("browser island is unavailable")?;
        let result = island.host.update_desired(request);
        let NativeContentDesiredUpdateResult::Committed { event, .. } = &result else {
            return Ok(result);
        };
        emit_changed(&self.app, event.as_ref());
        let plan = island.host.coordinator().plan().map_err(string_error)?;
        let receipt = island
            .adapter
            .apply(island.host.coordinator(), &plan)
            .map_err(string_error)?;
        emit_evidence(&self.app, &island_id, "apply", receipt);
        admit_fresh_observation(&self.app, &island_id, island)?;
        Ok(result)
    }

    pub(super) fn decide_content_size(
        &self,
        request: NativeContentContentSizeDecisionRequest,
    ) -> Result<NativeContentContentSizeDecisionResult, String> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| "browser runtime is unavailable")?;
        let island = inner
            .islands
            .get(&request.island_id)
            .ok_or("browser island is unavailable")?;
        Ok(island.host.decide_content_size(request))
    }

    pub(super) fn destroy(&self, island_id: &NativeContentIslandId) -> Result<(), String> {
        validate_island_id(island_id)?;
        let island = self
            .inner
            .lock()
            .map_err(|_| "browser runtime is unavailable")?
            .islands
            .remove(island_id);
        if let Some(island) = island {
            let receipt = island.adapter.teardown().map_err(string_error)?;
            emit_evidence(&self.app, island_id, "teardown", receipt);
        }
        reset_cursor(&self.app)
    }

    pub(super) fn hide_for_unmount(
        &self,
        island_id: &NativeContentIslandId,
    ) -> Result<(), String> {
        let request = {
            let inner = self
                .inner
                .lock()
                .map_err(|_| "browser runtime is unavailable")?;
            let island = inner
                .islands
                .get(island_id)
                .ok_or("browser island is unavailable")?;
            let Some(client_epoch) = island.host.client_epoch() else {
                return Ok(());
            };
            let desired = island.host.coordinator().desired();
            NativeContentDesiredUpdateRequest {
                protocol_version: NativeContentProtocolVersion::CURRENT,
                request_id: NativeContentRequestId::new(format!(
                    "request:nucleus-browser:unmount:{}",
                    desired.revision().get(),
                ))
                .map_err(string_error)?,
                island_id: island_id.clone(),
                client_epoch,
                expected_desired_revision: desired.revision(),
                update: DesiredUpdate::new(
                    desired.generation(),
                    desired.host_window_id().clone(),
                    desired.viewport(),
                    desired.scale(),
                    desired.rounding(),
                    desired.presence(),
                    DesiredVisibility::Hidden {
                        reason: VisibilityReasonId::new("nucleus:unmounted")
                            .map_err(string_error)?,
                    },
                    desired.focus(),
                    desired.input_routing(),
                ),
            }
        };
        match self.update_desired(request)? {
            NativeContentDesiredUpdateResult::Committed { .. } => Ok(()),
            NativeContentDesiredUpdateResult::Rejected { rejection, .. } => Err(rejection.message),
        }
    }

    pub fn teardown(&self) {
        let islands = self
            .inner
            .lock()
            .map(|mut inner| inner.islands.drain().collect::<Vec<_>>())
            .unwrap_or_default();
        for (island_id, island) in islands {
            match island.adapter.teardown() {
                Ok(receipt) => emit_evidence(&self.app, &island_id, "host_teardown", receipt),
                Err(error) => emit_evidence(
                    &self.app,
                    &island_id,
                    "host_teardown_failed",
                    error.to_string(),
                ),
            }
        }
        let _ = reset_cursor(&self.app);
    }
}

pub(super) fn admit_fresh_observation(
    app: &AppHandle,
    island_id: &NativeContentIslandId,
    island: &mut BrowserIsland,
) -> Result<(), String> {
    let generation = island.host.coordinator().desired().generation();
    let update = island.adapter.observe(generation).map_err(string_error)?;
    let expected = island.host.coordinator().observed().revision();
    let (receipt, event) = island
        .host
        .admit_observation(None, expected, update)
        .map_err(string_error)?;
    emit_evidence(app, island_id, "observation", receipt);
    if let Some(event) = event {
        emit_changed(app, &event);
    }
    Ok(())
}

pub(super) fn queue_observation_refresh(
    app: AppHandle,
    inner: Weak<Mutex<BrowserPanelRuntimeInner>>,
    island_id: NativeContentIslandId,
) {
    tauri::async_runtime::spawn(async move {
        let Some(inner) = inner.upgrade() else { return };
        let Ok(mut inner) = inner.lock() else { return };
        let Some(island) = inner.islands.get_mut(&island_id) else {
            return;
        };
        if let Err(error) = admit_fresh_observation(&app, &island_id, island) {
            emit_evidence(&app, &island_id, "observation_failed", error);
        }
    });
}
