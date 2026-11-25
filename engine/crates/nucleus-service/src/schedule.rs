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
pub(crate) const RETRY: Duration = Duration::from_secs(3);
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
        Some(WaitReason::HostUnknown | WaitReason::RetainedThreadBusy | WaitReason::Question) => {
            (T3_RETRY_DELAY, Priority::Decision)
        }
        Some(WaitReason::ForgeUnknown) => (FORGE_RETRY, Priority::Decision),
        Some(WaitReason::Capacity | WaitReason::Prerequisite | WaitReason::AssignmentTooLarge) => {
            (Duration::from_mins(1), Priority::Refresh)
        }
        Some(WaitReason::ChecksPending | WaitReason::ChecksUnreported) => {
            (Duration::from_secs(15), Priority::Decision)
        }
        _ => (RETRY, Priority::Decision),
    }
}

pub(crate) struct Schedule {
    tasks: BTreeMap<String, Pending>,
    workspace: BTreeMap<String, Recovery>,
    scan_at: Instant,
    cursor: Option<String>,
    archive_cursor: Option<String>,
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
        }
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

    pub(crate) fn recover_workspace(&mut self, id: &str, now: Instant) -> bool {
        let next = match self.workspace.get(id).copied() {
            Some(Recovery::CheckAt(due)) if due <= now => Recovery::Blocked,
            Some(prior) => prior,
            None => Recovery::CheckAt(now + T3_RETRY_DELAY),
        };
        self.workspace.insert(id.into(), next);
        self.park(id);
        if let Recovery::CheckAt(due) = next {
            self.wake(id, due, Priority::Effect);
        }
        next == Recovery::Blocked
    }

    pub(crate) fn reset_workspace(&mut self, id: &str) {
        self.workspace.remove(id);
    }

    pub(crate) fn seed(
        &mut self,
        store: &Store,
        now: Instant,
        parenting: bool,
        capacity_waiters: &mut BTreeSet<(i64, String)>,
    ) -> Result<(), ServiceError> {
        if now < self.scan_at {
            return Ok(());
        }
        let ids = store.active_ids(self.cursor.as_deref(), SCAN_PAGE)?;
        let more = ids.len() == SCAN_PAGE as usize;
        self.cursor = ids.last().filter(|_| more).map(|(id, _)| id.clone());
        let archival =
            store.archive_due_ids(self.archive_cursor.as_deref(), SCAN_PAGE, parenting)?;
        let more_archival = archival.len() == SCAN_PAGE as usize;
        self.archive_cursor = archival.last().filter(|_| more_archival).cloned();
        self.scan_at = now
            + if more || more_archival {
                Duration::from_secs(1)
            } else {
                SCAN_INTERVAL
            };
        for (id, admitted) in ids {
            self.tasks.entry(id.clone()).or_insert_with(|| {
                if let Some(admitted) = admitted {
                    capacity_waiters.insert((admitted, id));
                }
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

    pub(crate) fn take_ready<'a>(
        &mut self,
        now: Instant,
        visited: &BTreeSet<String>,
        waiting: impl IntoIterator<Item = &'a str>,
    ) -> Option<DueTask> {
        let ((priority, _), id) = self
            .tasks
            .iter()
            .filter_map(|(id, pending)| pending.ready(now).map(|ready| (ready, id)))
            .min()?;
        let (priority, id) = waiting
            .into_iter()
            .filter_map(|id| self.tasks.get_key_value(id))
            .filter_map(|(id, due)| due.ready(now).map(|(priority, _)| (priority, id)))
            .find(|(candidate, _)| priority != Priority::Effect || *candidate == Priority::Effect)
            .unwrap_or((priority, id));
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
