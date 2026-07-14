use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::Duration;

use tauri::{Monitor, PhysicalPosition, PhysicalSize, WebviewWindow, WindowEvent};

use crate::workspace_ui::{self, WorkspaceWindowBoundsDto, WorkspaceWindowPlacementDto};

const PERSIST_DEBOUNCE: Duration = Duration::from_millis(300);

#[derive(Clone, Debug, Eq, PartialEq)]
struct DisplayWorkArea {
    id: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

enum PersistRequest {
    Schedule(WorkspaceWindowPlacementDto),
    Flush(WorkspaceWindowPlacementDto, Sender<()>),
}

pub fn restore_and_track(window: &WebviewWindow) -> Result<(), String> {
    let config = workspace_ui::load_workspace_ui_config()?;
    restore_window(window, &config.window.placement)?;

    let sender = spawn_persistence_worker();
    let tracked_window = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Moved(_)
        | WindowEvent::Resized(_)
        | WindowEvent::ScaleFactorChanged { .. } => {
            if let Some(placement) = capture_placement(&tracked_window) {
                let _ = sender.send(PersistRequest::Schedule(placement));
            }
        }
        WindowEvent::Focused(false) => {
            if let Some(placement) = capture_placement(&tracked_window) {
                let _ = sender.send(PersistRequest::Schedule(placement));
            }
        }
        WindowEvent::CloseRequested { .. } => {
            if let Some(placement) = capture_placement(&tracked_window) {
                let (acknowledge, acknowledged) = mpsc::channel();
                if sender
                    .send(PersistRequest::Flush(placement, acknowledge))
                    .is_ok()
                {
                    let _ = acknowledged.recv_timeout(Duration::from_secs(1));
                }
            }
        }
        _ => {}
    });

    Ok(())
}

fn restore_window(
    window: &WebviewWindow,
    placement: &WorkspaceWindowPlacementDto,
) -> Result<(), String> {
    let Some(saved_bounds) = placement.normal_bounds.as_ref() else {
        return Ok(());
    };

    let monitors = window
        .available_monitors()
        .map_err(|error| format!("read available displays failed: {error}"))?;
    let displays: Vec<_> = monitors.iter().map(display_work_area).collect();
    let primary_id = window
        .primary_monitor()
        .map_err(|error| format!("read primary display failed: {error}"))?
        .as_ref()
        .map(display_id);

    let Some(bounds) = resolve_bounds(
        saved_bounds,
        placement.display_id.as_deref(),
        &displays,
        primary_id.as_deref(),
    ) else {
        return Ok(());
    };

    window
        .set_size(PhysicalSize::new(bounds.width, bounds.height))
        .map_err(|error| format!("restore window size failed: {error}"))?;
    window
        .set_position(PhysicalPosition::new(bounds.x, bounds.y))
        .map_err(|error| format!("restore window position failed: {error}"))?;
    if placement.maximized {
        window
            .maximize()
            .map_err(|error| format!("restore maximized window failed: {error}"))?;
    }

    Ok(())
}

fn capture_placement(window: &WebviewWindow) -> Option<WorkspaceWindowPlacementDto> {
    let maximized = window.is_maximized().ok()?;
    let display_id = window
        .current_monitor()
        .ok()
        .flatten()
        .as_ref()
        .map(display_id);
    let normal_bounds = if maximized {
        None
    } else {
        let position = window.outer_position().ok()?;
        let size = window.outer_size().ok()?;
        Some(WorkspaceWindowBoundsDto {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        })
    };

    Some(WorkspaceWindowPlacementDto {
        display_id,
        normal_bounds,
        maximized,
    })
}

fn spawn_persistence_worker() -> Sender<PersistRequest> {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || persist_requests(receiver));
    sender
}

fn persist_requests(receiver: Receiver<PersistRequest>) {
    while let Ok(request) = receiver.recv() {
        let mut latest = match request {
            PersistRequest::Schedule(placement) => placement,
            PersistRequest::Flush(placement, acknowledge) => {
                persist(placement);
                let _ = acknowledge.send(());
                continue;
            }
        };

        loop {
            match receiver.recv_timeout(PERSIST_DEBOUNCE) {
                Ok(PersistRequest::Schedule(placement)) => latest = placement,
                Ok(PersistRequest::Flush(placement, acknowledge)) => {
                    persist(placement);
                    let _ = acknowledge.send(());
                    break;
                }
                Err(RecvTimeoutError::Timeout) => {
                    persist(latest);
                    break;
                }
                Err(RecvTimeoutError::Disconnected) => {
                    persist(latest);
                    return;
                }
            }
        }
    }
}

fn persist(placement: WorkspaceWindowPlacementDto) {
    if let Err(error) = workspace_ui::update_workspace_window_placement(placement) {
        eprintln!("persist native window placement failed: {error}");
    }
}

fn display_work_area(monitor: &Monitor) -> DisplayWorkArea {
    let work_area = monitor.work_area();
    DisplayWorkArea {
        id: display_id(monitor),
        x: work_area.position.x,
        y: work_area.position.y,
        width: work_area.size.width,
        height: work_area.size.height,
    }
}

fn display_id(monitor: &Monitor) -> String {
    let name = monitor.name().map(String::as_str).unwrap_or("unnamed");
    let position = monitor.position();
    let size = monitor.size();
    format!(
        "display:{name}:{}:{}:{}x{}",
        position.x, position.y, size.width, size.height
    )
}

fn resolve_bounds(
    saved: &WorkspaceWindowBoundsDto,
    saved_display_id: Option<&str>,
    displays: &[DisplayWorkArea],
    primary_id: Option<&str>,
) -> Option<WorkspaceWindowBoundsDto> {
    let display = saved_display_id
        .and_then(|id| displays.iter().find(|display| display.id == id))
        .or_else(|| {
            displays
                .iter()
                .max_by_key(|display| intersection_area(saved, display))
                .filter(|display| intersection_area(saved, display) > 0)
        })
        .or_else(|| primary_id.and_then(|id| displays.iter().find(|display| display.id == id)))
        .or_else(|| displays.first())?;

    Some(clamp_to_display(saved, display))
}

fn intersection_area(bounds: &WorkspaceWindowBoundsDto, display: &DisplayWorkArea) -> u64 {
    let left = i64::from(bounds.x).max(i64::from(display.x));
    let top = i64::from(bounds.y).max(i64::from(display.y));
    let right = (i64::from(bounds.x) + i64::from(bounds.width))
        .min(i64::from(display.x) + i64::from(display.width));
    let bottom = (i64::from(bounds.y) + i64::from(bounds.height))
        .min(i64::from(display.y) + i64::from(display.height));

    u64::try_from((right - left).max(0) * (bottom - top).max(0)).unwrap_or(0)
}

fn clamp_to_display(
    saved: &WorkspaceWindowBoundsDto,
    display: &DisplayWorkArea,
) -> WorkspaceWindowBoundsDto {
    let width = saved.width.min(display.width);
    let height = saved.height.min(display.height);
    let max_x = i64::from(display.x) + i64::from(display.width.saturating_sub(width));
    let max_y = i64::from(display.y) + i64::from(display.height.saturating_sub(height));

    WorkspaceWindowBoundsDto {
        x: i64::from(saved.x).clamp(i64::from(display.x), max_x) as i32,
        y: i64::from(saved.y).clamp(i64::from(display.y), max_y) as i32,
        width,
        height,
    }
}

#[cfg(test)]
mod tests {
    use super::{resolve_bounds, DisplayWorkArea};
    use crate::workspace_ui::WorkspaceWindowBoundsDto;

    fn display(id: &str, x: i32, width: u32) -> DisplayWorkArea {
        DisplayWorkArea {
            id: id.to_owned(),
            x,
            y: 0,
            width,
            height: 900,
        }
    }

    #[test]
    fn saved_display_wins_and_bounds_are_clamped_inside_its_work_area() {
        let saved = WorkspaceWindowBoundsDto {
            x: 1800,
            y: -40,
            width: 1400,
            height: 1000,
        };
        let displays = vec![display("primary", 0, 1600), display("side", 1600, 1200)];

        let resolved = resolve_bounds(&saved, Some("side"), &displays, Some("primary")).unwrap();

        assert_eq!(resolved.x, 1600);
        assert_eq!(resolved.y, 0);
        assert_eq!(resolved.width, 1200);
        assert_eq!(resolved.height, 900);
    }

    #[test]
    fn missing_display_uses_intersection_before_primary() {
        let saved = WorkspaceWindowBoundsDto {
            x: 1700,
            y: 50,
            width: 1000,
            height: 700,
        };
        let displays = vec![display("primary", 0, 1600), display("side", 1600, 1200)];

        let resolved = resolve_bounds(&saved, Some("gone"), &displays, Some("primary")).unwrap();

        assert_eq!(resolved.x, 1700);
    }

    #[test]
    fn offscreen_bounds_fall_back_to_primary() {
        let saved = WorkspaceWindowBoundsDto {
            x: 9000,
            y: 9000,
            width: 1000,
            height: 700,
        };
        let displays = vec![display("primary", 0, 1600), display("side", 1600, 1200)];

        let resolved = resolve_bounds(&saved, Some("gone"), &displays, Some("primary")).unwrap();

        assert_eq!(resolved.x, 600);
        assert_eq!(resolved.y, 200);
    }
}
