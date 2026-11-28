use serde::{Deserialize, Serialize};

/// How much of the host a task's runs take, from `queue.weight` (ruling 63).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskWeight {
    Heavy,
    #[default]
    Normal,
    Light,
}

impl TaskWeight {
    #[must_use]
    pub const fn is_heavy(self) -> bool {
        matches!(self, Self::Heavy)
    }
}

/// The configured limits or the runs in progress.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Slots {
    pub heavy: u32,
    pub total: u32,
}

/// The cap which keeps a run of some weight from starting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlotBlock {
    /// Every slot is in use.
    Total,
    /// Total capacity is available but the heavy cap is full.
    Heavy { running: u32, limit: u32 },
}

impl Slots {
    pub fn add(&mut self, weight: TaskWeight) {
        self.total = self.total.saturating_add(1);
        self.heavy = self.heavy.saturating_add(u32::from(weight.is_heavy()));
    }

    /// Check one more run against the total and, for heavy runs, the heavy cap.
    #[must_use]
    pub fn blocks(self, running: Self, weight: TaskWeight) -> Option<SlotBlock> {
        if running.total >= self.total {
            return Some(SlotBlock::Total);
        }
        (weight.is_heavy() && running.heavy >= self.heavy).then_some(SlotBlock::Heavy {
            running: running.heavy,
            limit: self.heavy,
        })
    }
}
