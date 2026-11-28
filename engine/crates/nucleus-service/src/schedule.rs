use std::{
    cmp::Reverse,
    collections::{BTreeMap, BTreeSet},
    time::Duration,
};

use nucleus_core::{Phase, QueuePriority, WaitReason};
use nucleus_hosts::T3_RETRY_DELAY;
use nucleus_store::Store;
use tokio::time::Instant;

use crate::ServiceError;

/// Stable waiter keys. Live project usage is added when selecting a run.
pub(crate) type CapacityWaiters = BTreeSet<(Reverse<bool>, QueuePriority, i64, String)>;

const SCAN_PAGE: u32 = 32;
pub(crate) const PASS_BATCH: usize = 8;
const SCAN_INTERVAL: Duration = Duration::from_mins(1);
pub(crate) const LIVE_CHECK: Duration = Duration::from_secs(45);
pub(crate) const RETRY: Duration = Duration::from_secs(3);
pub(crate) const FORGE_RETRY: Duration = Duration::from_secs(30);
pub(crate) const VOLUME_RETRY: Duration = Duration::from_mins(1);
/// The longest delay between retries of a failure which keeps repeating.
pub(crate) const LONG_RETRY: Duration = Duration::from_mins(10);

/// [`RETRY`] doubled for each earlier miss, up to `cap`.
fn doubled(misses: u32, cap: Duration) -> Duration {
    RETRY.saturating_mul(1 << misses.min(8)).min(cap)
}

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

pub(crate) const fn retry(wait: Option<WaitReason>) -> (Duration, Priority) {
    match wait {
        Some(
            WaitReason::Running
            | WaitReason::Starting
            | WaitReason::Input
            | WaitReason::Permission
            | WaitReason::UsagePermission
            | WaitReason::IdleWithoutTerminalRun
            | WaitReason::Hold
            | WaitReason::MergeHold,
        ) => (LIVE_CHECK, Priority::Refresh),
        Some(WaitReason::HostUnknown | WaitReason::Question) => {
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
    /// Earlier failures in a row for each task which is backing off.
    failures: BTreeMap<String, u32>,
    scan_at: Instant,
    cursor: Option<String>,
    archive_cursor: Option<String>,
    resume: Option<Resume>,
    served_closeout: bool,
    /// Whether this process has ranked every stored capacity waiter.
    restored: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Recovery {
    CheckAt(Instant),
    Blocked,
    /// The work volume could not be verified `misses` times in a row.
    Volume {
        after: Instant,
        misses: u32,
    },
}

impl Schedule {
    pub(crate) fn new() -> Self {
        Self {
            tasks: BTreeMap::new(),
            workspace: BTreeMap::new(),
            failures: BTreeMap::new(),
            scan_at: Instant::now(),
            cursor: None,
            archive_cursor: None,
            resume: None,
            served_closeout: false,
            restored: false,
        }
    }

    pub(crate) fn dispatch_changed(&mut self, running: bool) {
        if running {
            self.retry_failures(Instant::now());
        }
        self.resume = (running && crate::diagnostics::enabled()).then(|| Resume {
            at: Instant::now(),
            at_ms: crate::now_ms(),
            served: BTreeSet::new(),
        });
    }

    pub(crate) fn wake(&mut self, id: &str, due: Instant, priority: Priority) {
        let due = match self.workspace.get(id) {
            Some(Recovery::CheckAt(after) | Recovery::Volume { after, .. }) => due.max(*after),
            Some(Recovery::Blocked) => return,
            None => due,
        };
        self.tasks.entry(id.into()).or_default().wake(due, priority);
    }

    pub(crate) fn park(&mut self, id: &str) {
        self.tasks.insert(id.into(), Pending::default());
    }

    pub(crate) fn recover_workspace(&mut self, id: &str, now: Instant, phase: Phase) -> bool {
        let next = match self.workspace.get(id).copied() {
            Some(Recovery::CheckAt(due)) if due <= now => Recovery::Blocked,
            Some(prior @ (Recovery::CheckAt(_) | Recovery::Blocked)) => prior,
            Some(Recovery::Volume { .. }) | None => Recovery::CheckAt(now + T3_RETRY_DELAY),
        };
        self.workspace.insert(id.into(), next);
        self.park(id);
        if let Recovery::CheckAt(due) = next {
            self.wake(id, due, Priority::Effect.for_phase(phase));
        }
        next == Recovery::Blocked
    }

    /// Retry a task whose work volume could not be verified, doubling the delay
    /// from [`RETRY`] up to [`VOLUME_RETRY`].
    pub(crate) fn await_volume(&mut self, id: &str, now: Instant, phase: Phase) {
        let misses = match self.workspace.get(id) {
            Some(Recovery::Volume { misses, .. }) => misses.saturating_add(1),
            _ => 0,
        };
        let after = now + doubled(misses, VOLUME_RETRY);
        self.workspace
            .insert(id.into(), Recovery::Volume { after, misses });
        self.park(id);
        self.wake(id, after, Priority::Effect.for_phase(phase));
    }

    /// The delay before retrying a task which failed again, up to [`LONG_RETRY`].
    /// Any other wake can still bring the task forward.
    pub(crate) fn back_off(&mut self, id: &str) -> Duration {
        let misses = self
            .failures
            .entry(id.into())
            .and_modify(|misses| *misses = misses.saturating_add(1))
            .or_insert(0);
        doubled(*misses, LONG_RETRY)
    }

    /// The next failure of this task starts again from [`RETRY`].
    pub(crate) fn reset_failures(&mut self, id: &str) {
        self.failures.remove(id);
    }

    /// Something outside the tasks changed, so retry every failing task now.
    pub(crate) fn retry_failures(&mut self, now: Instant) {
        for id in std::mem::take(&mut self.failures).into_keys() {
            self.wake(&id, now, Priority::Wake);
        }
    }

    pub(crate) fn recheck(&mut self, id: &str, now: Instant) {
        self.reset_failures(id);
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
        capacity_waiters: &mut CapacityWaiters,
    ) -> Result<bool, ServiceError> {
        if now < self.scan_at {
            return Ok(false);
        }
        let housekeeping = self.archive_cursor.is_none();
        // A restart loses the capacity waiters, and the paged scan reaches only
        // first launches, a page at a time. Rank every waiting run before any
        // pass can give one a slot.
        let waiting = if self.restored {
            Vec::new()
        } else {
            store.slot_candidates()?
        };
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
        self.restored = true;
        for seed in waiting {
            self.wake(&seed.id, now, Priority::Decision);
            if let Some(admitted) = seed.admission_order {
                capacity_waiters.insert((
                    Reverse(seed.weight.is_heavy()),
                    seed.queue_priority,
                    admitted,
                    seed.id,
                ));
            }
        }
        for seed in ids {
            self.tasks.entry(seed.id.clone()).or_insert_with(|| {
                if let Some(admitted) = seed.admission_order {
                    capacity_waiters.insert((
                        Reverse(seed.weight.is_heavy()),
                        seed.queue_priority,
                        admitted,
                        seed.id,
                    ));
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

    pub(crate) fn pick_ready<'a>(
        &'a self,
        now: Instant,
        visited: &BTreeSet<String>,
        prefer_capacity: impl FnOnce(Priority, &str) -> Option<(Priority, &'a str)>,
    ) -> Option<(Priority, String)> {
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
        // Give closeout and ordinary work turns while both are ready.
        let ((priority, _), id) = if self.served_closeout {
            ordinary.or(closeout)?
        } else {
            closeout.or(ordinary)?
        };
        let (priority, id) = if priority == Priority::Closeout {
            (priority, id.as_str())
        } else {
            prefer_capacity(priority, id).unwrap_or((priority, id))
        };
        // Start a fresh pass instead of observing the same task again with the
        // census shared by this pass. Lower priority work stays in the queue.
        (!visited.contains(id)).then(|| (priority, id.to_owned()))
    }

    pub(crate) fn capacity_ready(&self, id: &str, now: Instant) -> Option<Priority> {
        let (priority, _) = self.tasks.get(id)?.ready(now)?;
        (priority != Priority::Closeout).then_some(priority)
    }

    pub(crate) fn take(&mut self, priority: Priority, id: String) -> DueTask {
        self.served_closeout = priority == Priority::Closeout;
        let depth = self.tasks.len();
        let pending = self.tasks.remove(&id).expect("selected due task");
        let timing = crate::diagnostics::enabled().then(|| DueTiming {
            due: pending.due().expect("selected task has a deadline"),
            selected_due: pending.deadlines[priority as usize].expect("selected priority is due"),
            depth,
        });
        DueTask {
            id,
            priority,
            timing,
        }
    }

    #[cfg(test)]
    pub(crate) fn take_ready<'a>(
        &mut self,
        now: Instant,
        visited: &BTreeSet<String>,
        waiting: impl IntoIterator<Item = &'a str>,
    ) -> Option<DueTask> {
        let (priority, id) = self.pick_ready(now, visited, |priority, _| {
            waiting.into_iter().find_map(|id| {
                let candidate = self.capacity_ready(id, now)?;
                (priority != Priority::Effect || candidate == Priority::Effect)
                    .then_some((candidate, id))
            })
        })?;
        Some(self.take(priority, id))
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
        let first_page = active.len();
        for seed in active {
            assert_eq!(
                schedule.due(&seed.id),
                Some(now),
                "missing active task {}",
                seed.id
            );
            assert!(capacity_waiters.contains(&(
                Reverse(seed.weight.is_heavy()),
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
        // The next page's waiter is ranked at once, ahead of its page.
        assert_eq!(schedule.due(&format!("active-{SCAN_PAGE:02}")), Some(now));
        assert_eq!(capacity_waiters.len(), first_page + 1);
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
