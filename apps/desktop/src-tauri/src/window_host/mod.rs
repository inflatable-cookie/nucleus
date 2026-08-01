use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

use longhorn_config::{
    ConfigStore, CoordinationAuthority, DurabilityRequirement, LoadOutcome, MutationOptions,
};
use longhorn_core::{DisplayId, ScreenSize, WindowId, WindowPlacement};
use longhorn_display::{reconcile_displays, DisplayIdAllocator, ObservedDisplay};
use longhorn_tauri_windowing::{
    assemble_tauri_window_host, observe_tauri_desktop, scale_factor_from_tauri,
    DefaultDisplayMetadata, NoWindowFactory, PredeclaredTauriWindow, ProcessMonotonicClock,
    TauriAsyncWindowLifecycleScheduler, TauriDesktopReadback, TauriWindowCaptureBackend,
    TauriWindowHost, TauriWindowLifecycleServices, TauriWindowMutationBackend,
    TauriWindowRevealBackend, UniformScaleMapper, UniformWindowGeometryMapper,
    WindowLifecycleReport, WindowRevealReceipt, WindowUserCloseHandler,
};
use longhorn_windowing::{
    resolve_window_placement, restore_window_placement, ApplyGeneration, DesiredWindow,
    HostWindowHandle, PlacementPolicy, ProtectedPrimaryPolicy, WindowDiffInput,
    WindowLifecycleDuration, WindowLifecyclePolicy, WindowPlacementConfig,
    WindowPlacementResolution, WindowRole,
};
use longhorn_windowing_config::ConfigWindowPlacementSink;
use tauri::{AppHandle, Manager, Wry};

use crate::desktop_profile::DesktopProfile;
mod domain;
mod migration;

use domain::{NucleusWindowDomain, NucleusWindowState};

pub const PRIMARY_WINDOW_ID: &str = "window:primary";
const MAIN_LABEL: &str = "main";
const MAX_RESTORE_ATTEMPTS: u8 = 8;
const RESTORE_RETRY_DELAY: Duration = Duration::from_millis(80);

type PlacementSink = ConfigWindowPlacementSink<NucleusWindowDomain>;
type WindowHost = TauriWindowHost<Wry>;

pub struct NucleusWindowRuntime {
    host: Arc<WindowHost>,
    sink: Arc<PlacementSink>,
    generation: AtomicU64,
    initial_restore_complete: AtomicBool,
    restore_error: Mutex<Option<String>>,
}

impl NucleusWindowRuntime {
    fn next_generation(&self) -> ApplyGeneration {
        ApplyGeneration::new(self.generation.fetch_add(1, Ordering::Relaxed) + 1)
    }

    pub fn mark_page_ready(&self) -> Result<WindowRevealReceipt, String> {
        self.host
            .mark_page_ready(&primary_window_id()?)
            .map_err(|error| format!("mark Nucleus main page ready failed: {error:?}"))
    }

    pub fn restore_error(&self) -> Option<String> {
        self.restore_error
            .lock()
            .ok()
            .and_then(|error| error.clone())
    }

    pub fn initial_restore_complete(&self) -> bool {
        self.initial_restore_complete.load(Ordering::Acquire)
    }

    pub fn teardown(&self) -> Result<String, String> {
        self.host
            .teardown()
            .map(|receipt| format!("{receipt:?}"))
            .map_err(|error| format!("Nucleus window host teardown failed: {error:?}"))
    }
}

pub fn install(app: &mut tauri::App<Wry>, profile: &DesktopProfile) -> Result<(), String> {
    let app_handle = app.handle().clone();
    let roots = profile.storage_roots().clone();
    let target_path = profile
        .workspace_ui_paths()
        .window_placement()
        .to_path_buf();
    let prepared_migration = migration::prepare(
        &target_path,
        &profile.legacy_window_placement_backup_path(),
        &profile.legacy_window_placement_receipt_path(),
    )?;
    let coordination = CoordinationAuthority::new(roots.data())
        .map_err(|error| format!("create Nucleus window placement coordination failed: {error}"))?;
    let sink = Arc::new(
        ConfigWindowPlacementSink::new(
            ConfigStore::new(roots, coordination),
            NucleusWindowDomain::new()?,
            MutationOptions::new(Duration::from_secs(1), DurabilityRequirement::Atomic),
            |state: &mut NucleusWindowState, captured| {
                let saved = captured.saved_with_registry(&state.known_displays);
                state
                    .placements
                    .insert(captured.window_id().as_str().to_owned(), saved);
                Ok(())
            },
        )
        .map_err(|error| format!("register Nucleus window placement domain failed: {error}"))?,
    );

    if let Some(prepared) = prepared_migration {
        let imported = prepared.placement.clone();
        sink.mutate(move |state| {
            if let Some(placement) = imported {
                state
                    .placements
                    .insert(PRIMARY_WINDOW_ID.to_owned(), placement);
            }
            Ok(())
        })
        .map_err(|error| format!("publish migrated Nucleus window placement failed: {error}"))?;
        prepared.complete(&target_path)?;
    }

    let persisted = load_state(&sink)?;
    let main = app
        .get_webview_window(MAIN_LABEL)
        .ok_or_else(|| "predeclared Nucleus main window is missing".to_owned())?;
    let scale = scale_factor_from_tauri(
        main.scale_factor()
            .map_err(|error| format!("probe Nucleus main window scale failed: {error}"))?,
    )
    .map_err(|error| format!("map Nucleus main window scale failed: {error}"))?;
    let geometry_mapper = Arc::new(UniformWindowGeometryMapper::new(scale));
    let capture = Arc::new(TauriWindowCaptureBackend::new(geometry_mapper.clone()));
    let clock = Arc::new(ProcessMonotonicClock::new());
    let scheduler = Arc::new(TauriAsyncWindowLifecycleScheduler::new(clock.clone()));
    let close_app = app_handle.clone();
    let close_handler: Arc<dyn WindowUserCloseHandler> = Arc::new(move |window_id: &WindowId| {
        if window_id.as_str() != PRIMARY_WINDOW_ID {
            return Err(format!("unexpected Nucleus close request for {window_id}"));
        }
        close_app.exit(0);
        Ok(())
    });
    let reporter = Arc::new(move |report: WindowLifecycleReport| {
        let report = serde_json::to_string(&report)
            .unwrap_or_else(|error| format!("{{\"serializationError\":\"{error}\"}}"));
        eprintln!("Nucleus window lifecycle: {report}");
    });
    let services = TauriWindowLifecycleServices::new(
        clock,
        scheduler,
        geometry_mapper,
        capture,
        sink.clone(),
        close_handler,
        reporter,
        Arc::new(TauriWindowRevealBackend),
    );
    let primary_id = primary_window_id()?;
    let predeclared = persisted
        .placements
        .get(PRIMARY_WINDOW_ID)
        .map(|saved| {
            PredeclaredTauriWindow::new(primary_id.clone(), main.clone())
                .with_initial_normal(saved.normal_placement())
        })
        .unwrap_or_else(|| PredeclaredTauriWindow::new(primary_id, main));
    let initialization = assemble_tauri_window_host(
        &app_handle,
        WindowLifecyclePolicy::new(
            WindowLifecycleDuration::from_millis(400),
            WindowLifecycleDuration::from_millis(400),
            WindowLifecycleDuration::from_millis(200),
            WindowLifecycleDuration::from_millis(100),
            WindowLifecycleDuration::from_millis(1_000),
        ),
        services,
        [predeclared],
        Some(main_handle()?),
    )
    .map_err(|error| format!("assemble Nucleus protected window host failed: {error:?}"))?;
    let (host, receipt) = initialization.into_parts();
    eprintln!(
        "Nucleus window host initialized: status={:?}, windows={}, startup_visible=false",
        receipt.status(),
        receipt.registrations().len()
    );
    app.manage(NucleusWindowRuntime {
        host,
        sink,
        generation: AtomicU64::new(0),
        initial_restore_complete: AtomicBool::new(false),
        restore_error: Mutex::new(None),
    });
    schedule_initial_restore(app_handle, 1);
    Ok(())
}

pub fn teardown(app: &AppHandle<Wry>) {
    let Some(runtime) = app.try_state::<NucleusWindowRuntime>() else {
        return;
    };
    if !runtime.host.is_active() {
        return;
    }
    match runtime.teardown() {
        Ok(receipt) => eprintln!("Nucleus window host teardown: {receipt}"),
        Err(error) => eprintln!("{error}"),
    }
}

fn schedule_initial_restore(app: AppHandle<Wry>, attempt: u8) {
    std::thread::spawn(move || {
        std::thread::sleep(RESTORE_RETRY_DELAY);
        let dispatch_app = app.clone();
        if let Err(error) = app.run_on_main_thread(move || {
            run_initial_restore(&dispatch_app, attempt);
        }) {
            eprintln!("schedule Nucleus hidden restore failed: {error}");
        }
    });
}

fn run_initial_restore(app: &AppHandle<Wry>, attempt: u8) {
    let Some(runtime) = app.try_state::<NucleusWindowRuntime>() else {
        return;
    };
    match apply_hidden_restore(app, &runtime) {
        Ok(true) => {
            runtime
                .initial_restore_complete
                .store(true, Ordering::Release);
            if let Ok(mut error) = runtime.restore_error.lock() {
                *error = None;
            }
            eprintln!("Nucleus hidden window restore converged on attempt {attempt}");
        }
        Ok(false) if attempt < MAX_RESTORE_ATTEMPTS => {
            schedule_initial_restore(app.clone(), attempt + 1);
        }
        Err(error) if attempt < MAX_RESTORE_ATTEMPTS => {
            eprintln!(
                "Nucleus hidden window restore attempt {attempt} was not observable yet: {error}"
            );
            schedule_initial_restore(app.clone(), attempt + 1);
        }
        result => {
            let detail = match result {
                Ok(false) => format!(
                    "Nucleus hidden window restore did not converge after {attempt} attempts"
                ),
                Err(error) => {
                    format!("Nucleus hidden window restore failed on attempt {attempt}: {error}")
                }
                Ok(true) => unreachable!(),
            };
            if let Ok(mut error) = runtime.restore_error.lock() {
                *error = Some(detail.clone());
            }
            eprintln!("{detail}");
        }
    }
}

fn apply_hidden_restore(
    app: &AppHandle<Wry>,
    runtime: &NucleusWindowRuntime,
) -> Result<bool, String> {
    let managed = runtime
        .host
        .managed_windows()
        .map_err(|error| format!("read managed Nucleus windows failed: {error:?}"))?;
    let observation = observe_tauri_desktop(
        app,
        &managed,
        &mut DefaultDisplayMetadata,
        &UniformScaleMapper,
    )
    .map_err(|error| format!("observe Nucleus desktop failed: {error:?}"))?;
    let state = load_state(&runtime.sink)?;
    let mut allocator = NucleusDisplayAllocator {
        next: state.next_display_ordinal,
    };
    let reconciliation = reconcile_displays(
        &state.known_displays,
        observation.displays().iter().cloned(),
        &mut allocator,
    )
    .map_err(|error| format!("reconcile Nucleus displays failed: {error:?}"))?;
    let registry = reconciliation.registry().clone();
    let next_display_ordinal = allocator.next;
    runtime
        .sink
        .mutate(move |state| {
            state.known_displays = registry;
            state.next_display_ordinal = next_display_ordinal;
            Ok(())
        })
        .map_err(|error| format!("persist Nucleus display inventory failed: {error}"))?;

    let primary_id = primary_window_id()?;
    let policy = PlacementPolicy::new(ScreenSize::new(900, 620), ScreenSize::new(160, 120));
    let resolution = match state.placements.get(PRIMARY_WINDOW_ID) {
        Some(saved) => restore_window_placement(
            saved,
            reconciliation.inventory(),
            WindowRole::RequiredPrimary,
            policy,
        ),
        None => {
            let live = observation
                .windows()
                .iter()
                .find(|window| window.window_id() == Some(&primary_id))
                .ok_or_else(|| "Nucleus main window observation is missing".to_owned())?;
            resolve_window_placement(
                &WindowPlacementConfig::new(
                    primary_id.clone(),
                    WindowRole::RequiredPrimary,
                    WindowPlacement::new(
                        live.metrics().outer_bounds().origin(),
                        live.metrics().inner_size(),
                    ),
                ),
                reconciliation.inventory(),
                policy,
            )
        }
    }
    .map_err(|error| format!("resolve Nucleus main placement failed: {error}"))?;
    let WindowPlacementResolution::Resolved(resolved) = resolution else {
        return Err(format!(
            "required Nucleus main window placement is unavailable: {resolution:?}"
        ));
    };
    let desired = DesiredWindow::from_resolved(&resolved, true);
    let input = WindowDiffInput::new(
        [desired],
        observation.windows().iter().cloned(),
        runtime.host.capabilities(false),
        runtime.next_generation(),
    )
    .with_protected_primary(ProtectedPrimaryPolicy::Preserve {
        transport_handle: main_handle()?,
    })
    .for_hidden_restore();
    let receipt = runtime
        .host
        .apply(
            app,
            input,
            NoWindowFactory,
            TauriWindowMutationBackend,
            TauriDesktopReadback::new(DefaultDisplayMetadata, UniformScaleMapper),
        )
        .map_err(|error| format!("apply Nucleus hidden restore failed: {error:?}"))?;
    if let Err(error) = receipt.reveal() {
        return Err(format!("guarded Nucleus reveal failed: {error:?}"));
    }
    Ok(receipt.apply().is_converged())
}

fn load_state(sink: &PlacementSink) -> Result<NucleusWindowState, String> {
    match sink
        .load()
        .map_err(|error| format!("load Nucleus window placement domain failed: {error}"))?
    {
        LoadOutcome::Ready(loaded) => Ok(loaded.value),
        other => Err(format!(
            "Nucleus window placement domain requires recovery: {other:?}"
        )),
    }
}

fn primary_window_id() -> Result<WindowId, String> {
    WindowId::new(PRIMARY_WINDOW_ID).map_err(|error| error.to_string())
}

fn main_handle() -> Result<HostWindowHandle, String> {
    HostWindowHandle::new(MAIN_LABEL).map_err(|error| error.to_string())
}

struct NucleusDisplayAllocator {
    next: u64,
}

impl DisplayIdAllocator for NucleusDisplayAllocator {
    type Error = String;

    fn allocate(&mut self, _observation: &ObservedDisplay) -> Result<DisplayId, Self::Error> {
        let id = DisplayId::new(format!("nucleus-display:{}", self.next))
            .map_err(|error| error.to_string())?;
        self.next = self
            .next
            .checked_add(1)
            .ok_or_else(|| "Nucleus display identity allocation exhausted u64".to_owned())?;
        Ok(id)
    }
}
