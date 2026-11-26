use std::{
    collections::{BTreeMap, BTreeSet},
    time::Duration,
};

use nucleus_core::{Phase, QueuePriority, WaitReason};
use nucleus_hosts::T3_RETRY_DELAY;
use nucleus_store::Store;
use tokio::time::Instant;

use crate::ServiceError;

const SCAN_PAGE: u32 = 32;
pub(crate) const PASS_BATCH: usize = 8;
const SCAN_INTERVAL: Duration = Duration::from_mins(1);
pub(crate) const LIVE_CHECK: Duration = Duration::from_secs(45);
pub(crate) const RETRY: Duration = Duration::from_secs(3);
/// Interval for re-observing a live role until its parent hold is proven.
pub(crate) const REENTRY_CHECK: Duration = Duration::from_secs(3);
/// Only this long after a role message is sent does the short interval apply.
pub(crate) const REENTRY_WINDOW_MS: u64 = 30_000;
pub(crate) const FORGE_RETRY: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Priority {
    Closeout,
    Effect,
    Wake,
    Decision,
    Refresh,
}

pub(crate) struct DueTask {
    pub(crate) id: String,
    pub(crate) priority: Priority,
    pub(crate) timing: Option<DueTiming>,
}

#[derive(Clone, Copy)]
pub(crate) struct DueTiming {
    due: Instant,
    selected_due: Instant,
    depth: usize,
}

struct Resume {
    at: Instant,
    at_ms: u64,
    served: BTreeSet<String>,
}

pub(crate) struct FirstService {
    resume_at: Instant,
    resume_at_ms: u64,
    timing: DueTiming,
}

impl FirstService {
    pub(crate) fn record(&self, id: &str, phase: Phase, priority: Priority, started: Instant) {
        let timestamp = |at: Instant| {
            let millis = |delay: Duration| u64::try_from(delay.as_millis()).unwrap_or(u64::MAX);
            if at < self.resume_at {
                self.resume_at_ms
                    .saturating_sub(millis(self.resume_at - at))
            } else {
                self.resume_at_ms
                    .saturating_add(millis(at - self.resume_at))
            }
        };
        let eligible = self.timing.due.max(self.resume_at);
        crate::diagnostics::record(&serde_json::json!({
            "kind": "scheduler_first_service",
            "task_id": id,
            "phase": phase,
            "priority": format!("{priority:?}"),
            "resume_at_ms": self.resume_at_ms,
            "due_at_ms": timestamp(self.timing.due),
            "selected_due_at_ms": timestamp(self.timing.selected_due),
            "first_service_at_ms": timestamp(started),
            "eligible_delay_ms": started.saturating_duration_since(eligible).as_millis(),
            "depth": self.timing.depth,
        }));
    }
}

impl Priority {
    const ORDER: [Self; 5] = [
        Self::Closeout,
        Self::Effect,
        Self::Wake,
        Self::Decision,
        Self::Refresh,
    ];

    pub(crate) const fn for_phase(self, phase: Phase) -> Self {
        if matches!(phase, Phase::Closing | Phase::Done | Phase::Cancelled) {
            Self::Closeout
        } else {
            self
        }
    }
}

#[derive(Default)]
struct Pending {
    deadlines: [Option<Instant>; Priority::ORDER.len()],
}

impl Pending {
    fn wake(&mut self, due: Instant, priority: Priority) {
        let slot = &mut self.deadlines[priority as usize];
        *slot = Some(slot.map_or(due, |prior| prior.min(due)));
    }

    fn ready(&self, now: Instant) -> Option<(Priority, Instant)> {
        Priority::ORDER.into_iter().find_map(|priority| {
            self.deadlines[priority as usize]
                .filter(|due| *due <= now)
                .map(|due| (priority, due))
        })
    }

    fn due(&self) -> Option<Instant> {
        self.deadlines.iter().flatten().copied().min()
    }
}

/// Whether a continuation whose parent hold is not yet proven needs a short
/// re-observation. The normal live check can come after a short run has ended,
/// so the first observations after a send recheck sooner, for a bounded window.
pub(crate) fn reentry_recheck_due(unproven: bool, sent_at_ms: Option<u64>, now_ms: u64) -> bool {
    unproven && sent_at_ms.is_some_and(|sent| now_ms.saturating_sub(sent) < REENTRY_WINDOW_MS)
}

pub(crate) const fn retry(wait: Option<WaitReason>) -> (Duration, Priority) {
    match wait {
        Some(
            WaitReason::Running
            | WaitReason::Starting
            | WaitReason::Input
            | WaitReason::Permission
            | WaitReason::UsagePermission
            | WaitReason::IdleWithoutTerminalRun
            | WaitReason::Hold,
        ) => (LIVE_CHECK, Priority::Refresh),
        Some(WaitReason::HostUnknown | WaitReason::RetainedThreadBusy | WaitReason::Question) => {
            (T3_RETRY_DELAY, Priority::Decision)
        }
        Some(WaitReason::ForgeUnknown) => (FORGE_RETRY, Priority::Decision),
        Some(WaitReason::Capacity | WaitReason::Prerequisite | WaitReason::AssignmentTooLarge) => {
            (Duration::from_mins(1), Priority::Refresh)
        }
        Some(WaitReason::ChecksPending) => (Duration::from_secs(15), Priority::Decision),
        _ => (RETRY, Priority::Decision),
    }
}

pub(crate) struct Schedule {
    tasks: BTreeMap<String, Pending>,
    workspace: BTreeMap<String, Recovery>,
    scan_at: Instant,
    cursor: Option<String>,
    archive_cursor: Option<String>,
    resume: Option<Resume>,
    served_closeout: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Recovery {
    CheckAt(Instant),
    Blocked,
}

impl Schedule {
    pub(crate) fn new() -> Self {
        Self {
            tasks: BTreeMap::new(),
            workspace: BTreeMap::new(),
            scan_at: Instant::now(),
            cursor: None,
            archive_cursor: None,
            resume: None,
            served_closeout: false,
        }
    }

    pub(crate) fn dispatch_changed(&mut self, running: bool) {
        self.resume = (running && crate::diagnostics::enabled()).then(|| Resume {
            at: Instant::now(),
            at_ms: crate::now_ms(),
            served: BTreeSet::new(),
        });
    }

    /// The pending deadline for one priority slot of a task.
    #[cfg(test)]
    pub(crate) fn due_at(&self, id: &str, priority: Priority) -> Option<Instant> {
        self.tasks.get(id)?.deadlines[priority as usize]
    }

    pub(crate) fn wake(&mut self, id: &str, due: Instant, priority: Priority) {
        let due = match self.workspace.get(id) {
            Some(Recovery::CheckAt(after)) => due.max(*after),
            Some(Recovery::Blocked) => return,
            None => due,
        };
        self.tasks.entry(id.into()).or_default().wake(due, priority);
    }

    pub(crate) fn park(&mut self, id: &str) {
        self.tasks.insert(id.into(), Pending::default());
    }

    pub(crate) fn defer_effect(&mut self, id: &str, due: Instant) {
        self.reset_workspace(id);
        let mut pending = Pending::default();
        pending.wake(due, Priority::Effect);
        self.tasks.insert(id.into(), pending);
    }

    pub(crate) fn recover_workspace(&mut self, id: &str, now: Instant, phase: Phase) -> bool {
        let next = match self.workspace.get(id).copied() {
            Some(Recovery::CheckAt(due)) if due <= now => Recovery::Blocked,
            Some(prior) => prior,
            None => Recovery::CheckAt(now + T3_RETRY_DELAY),
        };
        self.workspace.insert(id.into(), next);
        self.park(id);
        if let Recovery::CheckAt(due) = next {
            self.wake(id, due, Priority::Effect.for_phase(phase));
        }
        next == Recovery::Blocked
    }

    pub(crate) fn recheck(&mut self, id: &str, now: Instant) {
        if let Some(recovery) = self.workspace.get_mut(id) {
            *recovery = Recovery::CheckAt(now);
        }
        self.wake(id, now, Priority::Effect);
    }

    pub(crate) fn reset_workspace(&mut self, id: &str) {
        self.workspace.remove(id);
    }

    pub(crate) fn seed(
        &mut self,
        store: &Store,
        now: Instant,
        parenting: bool,
        capacity_waiters: &mut BTreeSet<(QueuePriority, i64, String)>,
    ) -> Result<bool, ServiceError> {
        if now < self.scan_at {
            return Ok(false);
        }
        let housekeeping = self.archive_cursor.is_none();
        let ids = store.active_ids(self.cursor.as_deref(), SCAN_PAGE)?;
        let archival =
            store.archive_due_ids(self.archive_cursor.as_deref(), SCAN_PAGE, parenting)?;
        let more = ids.len() == SCAN_PAGE as usize;
        let more_archival = archival.len() == SCAN_PAGE as usize;
        self.cursor = ids.last().filter(|_| more).map(|seed| seed.id.clone());
        self.archive_cursor = archival.last().filter(|_| more_archival).cloned();
        self.scan_at = now
            + if more || more_archival {
                Duration::from_secs(1)
            } else {
                SCAN_INTERVAL
            };
        for seed in ids {
            self.tasks.entry(seed.id.clone()).or_insert_with(|| {
                if let Some(admitted) = seed.admission_order {
                    capacity_waiters.insert((seed.queue_priority, admitted, seed.id));
                }
                let mut pending = Pending::default();
                let priority = if seed.closeout {
                    Priority::Closeout
                } else {
                    Priority::Decision
                };
                pending.wake(now, priority);
                pending
            });
        }
        for id in archival {
            self.tasks.entry(id).or_insert_with(|| {
                let mut pending = Pending::default();
                pending.wake(now, Priority::Closeout);
                pending
            });
        }
        Ok(housekeeping)
    }

    pub(crate) fn take_ready<'a>(
        &mut self,
        now: Instant,
        visited: &BTreeSet<String>,
        waiting: impl IntoIterator<Item = &'a str>,
    ) -> Option<DueTask> {
        let mut closeout = None;
        let mut ordinary = None;
        for (id, pending) in &self.tasks {
            if let Some(ready) = pending.ready(now) {
                let best = if ready.0 == Priority::Closeout {
                    &mut closeout
                } else {
                    &mut ordinary
                };
                let candidate = (ready, id);
                if best.is_none_or(|prior| candidate < prior) {
                    *best = Some(candidate);
                }
            }
        }
        // Give closeout and ordinary work turns while both are ready. FIFO
        // capacity selection applies only on ordinary turns.
        let ((priority, _), id) = if self.served_closeout {
            ordinary.or(closeout)?
        } else {
            closeout.or(ordinary)?
        };
        let (priority, id) = if priority == Priority::Closeout {
            (priority, id)
        } else {
            waiting
                .into_iter()
                .filter_map(|id| self.tasks.get_key_value(id))
                .filter_map(|(id, due)| due.ready(now).map(|(priority, _)| (priority, id)))
                .find(|(candidate, _)| {
                    *candidate != Priority::Closeout
                        && (priority != Priority::Effect || *candidate == Priority::Effect)
                })
                .unwrap_or((priority, id))
        };
        // Start a fresh pass instead of observing the same task again with the
        // census shared by this pass. Lower priority work stays in the queue.
        if visited.contains(id) {
            return None;
        }
        self.served_closeout = priority == Priority::Closeout;
        let depth = self.tasks.len();
        let id = id.clone();
        let pending = self.tasks.remove(&id).expect("selected due task");
        let timing = crate::diagnostics::enabled().then(|| DueTiming {
            due: pending.due().expect("selected task has a deadline"),
            selected_due: pending.deadlines[priority as usize].expect("selected priority is due"),
            depth,
        });
        Some(DueTask {
            id,
            priority,
            timing,
        })
    }

    pub(crate) fn first_service(&mut self, task: &DueTask) -> Option<FirstService> {
        let timing = task.timing?;
        let resume = self.resume.as_mut()?;
        resume
            .served
            .insert(task.id.clone())
            .then_some(FirstService {
                resume_at: resume.at,
                resume_at_ms: resume.at_ms,
                timing,
            })
    }

    pub(crate) fn next(&self) -> Instant {
        self.tasks
            .values()
            .filter_map(Pending::due)
            .min()
            .map_or(self.scan_at, |due| due.min(self.scan_at))
    }

    pub(crate) fn depth(&self) -> usize {
        self.tasks.len()
    }

    pub(crate) fn due(&self, id: &str) -> Option<Instant> {
        self.tasks.get(id).and_then(Pending::due)
    }

    pub(crate) fn effect_ready(&self, id: &str, now: Instant) -> bool {
        self.tasks
            .get(id)
            .and_then(|pending| pending.deadlines[Priority::Effect as usize])
            .is_some_and(|due| due <= now)
    }
}

#[cfg(test)]
mod tests {
    use nucleus_store::SettingsFile;
    use rusqlite::Connection;

    use super::*;

    #[test]
    fn reentry_recheck_is_bounded_to_a_live_recent_send() {
        const SENT: u64 = 1_000_000;
        assert!(REENTRY_CHECK < LIVE_CHECK);
        assert!(reentry_recheck_due(true, Some(SENT), SENT));
        assert!(reentry_recheck_due(
            true,
            Some(SENT),
            SENT + REENTRY_WINDOW_MS - 1
        ));
        assert!(!reentry_recheck_due(
            true,
            Some(SENT),
            SENT + REENTRY_WINDOW_MS
        ));
        assert!(!reentry_recheck_due(false, Some(SENT), SENT));
        assert!(!reentry_recheck_due(true, None, SENT));
    }

    #[test]
    fn archive_read_failure_preserves_the_first_active_page_for_retry() {
        let home = tempfile::tempdir().expect("isolated database home");
        let storage = SettingsFile::open(&home.path().canonicalize().unwrap())
            .unwrap()
            .configured_storage()
            .unwrap();
        let store = Store::open(&storage).unwrap();
        let database = Connection::open(storage.database().path().join("engine.sqlite")).unwrap();
        let insert =
            "INSERT INTO tasks (id, reference, repository, base, entry, brief, phase, threads)
            VALUES (?1, ?1, 'example/fixture', 'main', 'brief', '\"fixture\"', ?2, '{}')";
        for number in 0..=SCAN_PAGE {
            database
                .execute(insert, [format!("active-{number:02}"), "queued".into()])
                .unwrap();
        }
        database.execute(insert, ["archival", "done"]).unwrap();
        // Only the archive page decodes this finished task's invalid UTF-8 ID.
        database
            .execute(
                "UPDATE tasks SET id = CAST(X'80' AS TEXT) WHERE id = 'archival'",
                [],
            )
            .unwrap();
        let active = store.active_ids(None, SCAN_PAGE).unwrap();
        assert_eq!(active.len(), SCAN_PAGE as usize);
        assert!(store.archive_due_ids(None, SCAN_PAGE, true).is_err());

        let mut schedule = Schedule::new();
        let now = schedule.next();
        let mut capacity_waiters = BTreeSet::new();
        assert!(
            schedule
                .seed(&store, now, true, &mut capacity_waiters)
                .is_err()
        );
        assert_eq!(schedule.depth(), 0);
        assert!(capacity_waiters.is_empty());
        assert_eq!(schedule.next(), now);

        database
            .execute(
                "UPDATE tasks SET id = reference WHERE reference = 'archival'",
                [],
            )
            .unwrap();
        schedule
            .seed(&store, now, true, &mut capacity_waiters)
            .unwrap();
        for seed in active {
            assert_eq!(
                schedule.due(&seed.id),
                Some(now),
                "missing active task {}",
                seed.id
            );
            assert!(capacity_waiters.contains(&(
                seed.queue_priority,
                seed.admission_order.expect("admission order"),
                seed.id,
            )));
        }
        assert_eq!(
            schedule
                .take_ready(now, &BTreeSet::new(), None)
                .map(|task| (task.id, task.priority)),
            Some(("archival".into(), Priority::Closeout)),
        );
        assert_eq!(schedule.due(&format!("active-{SCAN_PAGE:02}")), None);
    }

    #[test]
    fn due_closeouts_get_turns_during_a_capacity_backlog() {
        let now = Instant::now();
        let resume = now + Duration::from_millis(1);
        let mut schedule = Schedule::new();
        let waiting: Vec<_> = (0..140)
            .rev()
            .map(|index| format!("queued-{index:03}"))
            .collect();
        for id in &waiting {
            schedule.wake(id, resume, Priority::Effect);
        }
        schedule.wake("closing", now, Priority::Decision.for_phase(Phase::Closing));
        schedule.wake("terminal", now, Priority::Effect.for_phase(Phase::Done));

        let mut visited = BTreeSet::new();
        for (id, priority) in [
            ("closing", Priority::Closeout),
            ("queued-139", Priority::Effect),
            ("terminal", Priority::Closeout),
            ("queued-138", Priority::Effect),
        ] {
            let task = schedule
                .take_ready(resume, &visited, waiting.iter().map(String::as_str))
                .expect("due task");
            assert_eq!((task.id.as_str(), task.priority), (id, priority));
            visited.insert(task.id);
        }
    }

    #[test]
    fn earlier_due_tasks_win_over_more_recent_wakes() {
        let now = Instant::now();
        let mut pending = Schedule::new();
        pending.wake("later-id", now, Priority::Decision);
        let later = now + Duration::from_secs(1);
        for number in 0..PASS_BATCH {
            pending.wake(&format!("first-{number}"), later, Priority::Decision);
        }
        assert_eq!(
            pending
                .take_ready(later, &BTreeSet::new(), None)
                .map(|task| task.id),
            Some("later-id".into())
        );
    }

    #[test]
    fn command_wakes_overtake_backstops_between_task_reads() {
        let now = Instant::now();
        let mut pending = Schedule::new();
        for id in ["refresh-a", "refresh-b", "refresh-c"] {
            pending.wake(id, now, Priority::Refresh);
        }
        let mut visited = BTreeSet::new();
        let first = pending
            .take_ready(now, &visited, None)
            .expect("first refresh")
            .id;
        assert_eq!(first, "refresh-a");
        visited.insert(first);
        let later = now + Duration::from_secs(1);
        pending.wake("refresh-b", later, Priority::Wake);
        pending.wake("refresh-c", later, Priority::Refresh);
        pending.wake("write", later, Priority::Effect);
        pending.wake("decision", now, Priority::Decision);
        for expected in ["write", "refresh-b", "decision", "refresh-c"] {
            assert_eq!(
                pending
                    .take_ready(later, &visited, None)
                    .expect("ready task")
                    .id,
                expected
            );
        }
        assert!(pending.take_ready(later, &visited, None).is_none());
    }
}
