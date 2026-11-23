use std::{collections::BTreeMap, time::Duration};

use nucleus_core::WaitReason;
use nucleus_hosts::T3_RETRY_DELAY;
use nucleus_store::Store;
use tokio::time::Instant;

use crate::ServiceError;

const SCAN_PAGE: u32 = 32;
const PASS_BATCH: usize = 8;
const SCAN_INTERVAL: Duration = Duration::from_mins(1);

pub(crate) const fn delay(wait: Option<WaitReason>) -> Duration {
    match wait {
        Some(
            WaitReason::Running
            | WaitReason::Starting
            | WaitReason::Input
            | WaitReason::Permission
            | WaitReason::IdleWithoutTerminalRun
            | WaitReason::Hold,
        ) => Duration::from_secs(45),
        Some(WaitReason::HostUnknown | WaitReason::RetainedThreadBusy | WaitReason::Question) => {
            T3_RETRY_DELAY
        }
        Some(WaitReason::ChecksPending) => Duration::from_secs(15),
        _ => Duration::from_secs(3),
    }
}

pub(crate) struct Schedule {
    tasks: BTreeMap<String, Instant>,
    scan_at: Instant,
    cursor: Option<String>,
}

impl Schedule {
    pub(crate) fn new() -> Self {
        Self {
            tasks: BTreeMap::new(),
            scan_at: Instant::now(),
            cursor: None,
        }
    }

    pub(crate) fn wake(&mut self, id: &str, due: Instant) {
        self.tasks
            .entry(id.into())
            .and_modify(|pending| *pending = (*pending).min(due))
            .or_insert(due);
    }

    pub(crate) fn seed(&mut self, store: &Store, now: Instant) -> Result<(), ServiceError> {
        if now < self.scan_at {
            return Ok(());
        }
        let ids = store.active_ids(self.cursor.as_deref(), SCAN_PAGE)?;
        let more = ids.len() == SCAN_PAGE as usize;
        self.cursor = ids.last().filter(|_| more).cloned();
        self.scan_at = now
            + if more {
                Duration::from_secs(1)
            } else {
                SCAN_INTERVAL
            };
        for id in ids {
            self.tasks.entry(id).or_insert(now);
        }
        Ok(())
    }

    pub(crate) fn ready(&mut self, now: Instant) -> Vec<String> {
        let mut due: Vec<_> = self
            .tasks
            .iter()
            .filter_map(|(id, due)| (*due <= now).then_some((*due, id)))
            .collect();
        due.sort_unstable();
        let ready: Vec<_> = due
            .into_iter()
            .take(PASS_BATCH)
            .map(|(_, id)| id.clone())
            .collect();
        for id in &ready {
            self.tasks.remove(id);
        }
        ready
    }

    pub(crate) fn next(&self) -> Instant {
        self.tasks
            .values()
            .copied()
            .min()
            .map_or(self.scan_at, |due| due.min(self.scan_at))
    }

    pub(crate) fn due(&self, id: &str) -> Option<Instant> {
        self.tasks.get(id).copied()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn earlier_due_tasks_win_over_more_recent_wakes() {
        let now = Instant::now();
        let mut pending = Schedule::new();
        pending.wake("later-id", now);
        let later = now + Duration::from_secs(1);
        for number in 0..PASS_BATCH {
            pending.wake(&format!("first-{number}"), later);
        }
        assert_eq!(
            pending.ready(later).first().map(String::as_str),
            Some("later-id")
        );
        assert_eq!(pending.ready(later).len(), 1);
    }
}
