use std::{
    collections::{BTreeMap, BTreeSet},
    time::Duration,
};

use nucleus_core::WaitReason;
use nucleus_hosts::T3_RETRY_DELAY;
use nucleus_store::Store;
use tokio::time::Instant;

use crate::ServiceError;

const SCAN_PAGE: u32 = 32;
pub(crate) const PASS_BATCH: usize = 8;
const SCAN_INTERVAL: Duration = Duration::from_mins(1);
pub(crate) const LIVE_CHECK: Duration = Duration::from_secs(45);
pub(crate) const FORGE_RETRY: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Priority {
    Effect,
    Wake,
    Decision,
    Refresh,
}

pub(crate) struct DueTask {
    pub(crate) id: String,
    pub(crate) priority: Priority,
}

impl Priority {
    const ORDER: [Self; 4] = [Self::Effect, Self::Wake, Self::Decision, Self::Refresh];
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
            | WaitReason::Hold,
        ) => (LIVE_CHECK, Priority::Refresh),
        Some(
            WaitReason::HostUnknown
            | WaitReason::WorkspaceUnknown
            | WaitReason::RetainedThreadBusy
            | WaitReason::Question,
        ) => (T3_RETRY_DELAY, Priority::Decision),
        Some(WaitReason::ForgeUnknown) => (FORGE_RETRY, Priority::Decision),
        Some(
            WaitReason::Capacity
            | WaitReason::Prerequisite
            | WaitReason::AssignmentTooLarge
            | WaitReason::HostObservationBlocked,
        ) => (Duration::from_mins(1), Priority::Refresh),
        Some(WaitReason::ChecksPending) => (Duration::from_secs(15), Priority::Decision),
        _ => (Duration::from_secs(3), Priority::Decision),
    }
}

pub(crate) struct Schedule {
    tasks: BTreeMap<String, Pending>,
    host_retry: BTreeMap<String, HostRecovery>,
    scan_at: Instant,
    cursor: Option<String>,
    archive_cursor: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HostRecovery {
    CheckAt(Instant),
    Blocked,
}

impl Schedule {
    pub(crate) fn new() -> Self {
        Self {
            tasks: BTreeMap::new(),
            host_retry: BTreeMap::new(),
            scan_at: Instant::now(),
            cursor: None,
            archive_cursor: None,
        }
    }

    pub(crate) fn wake(&mut self, id: &str, due: Instant, priority: Priority) {
        let due = match self.host_retry.get(id) {
            Some(HostRecovery::CheckAt(after)) => due.max(*after),
            Some(HostRecovery::Blocked) => return,
            None => due,
        };
        self.tasks.entry(id.into()).or_default().wake(due, priority);
    }

    pub(crate) fn park(&mut self, id: &str) {
        self.tasks.entry(id.into()).or_default();
    }

    pub(crate) fn block_host_observation(&mut self, id: &str) {
        self.host_retry.insert(id.into(), HostRecovery::Blocked);
        self.tasks.insert(id.into(), Pending::default());
    }

    pub(crate) fn recover_host_observation(
        &mut self,
        id: &str,
        now: Instant,
        deferred_until: Option<Instant>,
    ) -> bool {
        let next = match self.host_retry.get(id) {
            Some(HostRecovery::CheckAt(due)) if *due <= now && deferred_until.is_none() => {
                HostRecovery::Blocked
            }
            Some(HostRecovery::CheckAt(due)) => {
                HostRecovery::CheckAt((*due).max(deferred_until.unwrap_or(now)))
            }
            Some(HostRecovery::Blocked) => HostRecovery::Blocked,
            None => {
                HostRecovery::CheckAt((now + T3_RETRY_DELAY).max(deferred_until.unwrap_or(now)))
            }
        };
        self.host_retry.insert(id.into(), next);
        self.tasks.insert(id.into(), Pending::default());
        if let HostRecovery::CheckAt(due) = next {
            self.wake(id, due, Priority::Effect);
        }
        next == HostRecovery::Blocked
    }

    pub(crate) fn reset_host_backoff(&mut self, id: &str) -> bool {
        self.host_retry.remove(id).is_some()
    }

    pub(crate) fn host_session_changed(&mut self, now: Instant) {
        for (id, _) in std::mem::take(&mut self.host_retry) {
            self.wake(&id, now, Priority::Effect);
        }
    }

    pub(crate) fn seed(
        &mut self,
        store: &Store,
        now: Instant,
        parenting: bool,
    ) -> Result<(), ServiceError> {
        if now < self.scan_at {
            return Ok(());
        }
        let ids = store.active_ids(self.cursor.as_deref(), SCAN_PAGE)?;
        let more = ids.len() == SCAN_PAGE as usize;
        self.cursor = ids.last().filter(|_| more).cloned();
        let archival = if parenting {
            store.archive_due_ids(self.archive_cursor.as_deref(), SCAN_PAGE)?
        } else {
            Vec::new()
        };
        let more_archival = archival.len() == SCAN_PAGE as usize;
        self.archive_cursor = archival.last().filter(|_| more_archival).cloned();
        self.scan_at = now
            + if more || more_archival {
                Duration::from_secs(1)
            } else {
                SCAN_INTERVAL
            };
        for id in ids {
            self.tasks.entry(id).or_insert_with(|| {
                let mut pending = Pending::default();
                pending.wake(now, Priority::Decision);
                pending
            });
        }
        for id in archival {
            self.tasks.entry(id).or_insert_with(|| {
                let mut pending = Pending::default();
                pending.wake(now, Priority::Effect);
                pending
            });
        }
        Ok(())
    }

    pub(crate) fn take_ready(
        &mut self,
        now: Instant,
        visited: &BTreeSet<String>,
    ) -> Option<DueTask> {
        let ((priority, _), id) = self
            .tasks
            .iter()
            .filter_map(|(id, pending)| pending.ready(now).map(|ready| (ready, id)))
            .min()?;
        // Start a fresh pass instead of observing the same task again with the
        // census shared by this pass. Lower priority work stays in the queue.
        if visited.contains(id) {
            return None;
        }
        let id = id.clone();
        self.tasks.remove(&id);
        Some(DueTask { id, priority })
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
    use super::*;

    #[test]
    fn unknown_host_gets_one_due_read_then_waits_for_new_authority() {
        let mut schedule = Schedule::new();
        let now = Instant::now();
        let due = now + T3_RETRY_DELAY;
        assert!(!schedule.recover_host_observation("worker", now, None));
        schedule.wake("worker", now, Priority::Effect);
        assert!(schedule.take_ready(now, &BTreeSet::new()).is_none());
        assert_eq!(
            schedule.take_ready(due, &BTreeSet::new()).unwrap().id,
            "worker"
        );
        let deferred = due + T3_RETRY_DELAY;
        assert!(!schedule.recover_host_observation("worker", due, Some(deferred)));
        assert_eq!(schedule.due("worker"), Some(deferred));
        assert!(schedule.recover_host_observation("worker", deferred, None));
        schedule.wake("worker", deferred, Priority::Effect);
        assert!(schedule.take_ready(deferred, &BTreeSet::new()).is_none());
        schedule.host_session_changed(deferred);
        assert_eq!(
            schedule.take_ready(deferred, &BTreeSet::new()).unwrap().id,
            "worker"
        );
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
                .take_ready(later, &BTreeSet::new())
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
        let first = pending.take_ready(now, &visited).expect("first refresh").id;
        assert_eq!(first, "refresh-a");
        visited.insert(first);
        let later = now + Duration::from_secs(1);
        pending.wake("refresh-b", later, Priority::Wake);
        pending.wake("refresh-c", later, Priority::Refresh);
        pending.wake("write", later, Priority::Effect);
        pending.wake("decision", now, Priority::Decision);
        for expected in ["write", "refresh-b", "decision", "refresh-c"] {
            assert_eq!(
                pending.take_ready(later, &visited).expect("ready task").id,
                expected
            );
        }
        assert!(pending.take_ready(later, &visited).is_none());
    }
}
