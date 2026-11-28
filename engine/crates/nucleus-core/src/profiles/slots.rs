use serde::{Deserialize, Serialize};

/// How much of the host a task's runs take, from `queue.weight` (ruling 63).
/// The heaviest sorts first.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskWeight {
    Heavy,
    #[default]
    Normal,
    Light,
}

/// A count of slots per weight: either the configured limits or the runs in progress.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Slots {
    pub heavy: u32,
    pub normal: u32,
    pub light: u32,
}

/// The cap which keeps a run of some weight from starting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlotBlock {
    /// Every slot is in use.
    Total,
    /// Slots are free, but none that this weight may use. `weight` names the
    /// full cap: heavy runs, or heavy and normal runs together.
    Weight {
        weight: TaskWeight,
        running: u32,
        limit: u32,
    },
}

impl Slots {
    /// Divide one slot count: up to five heavy, then up to five light, and
    /// the rest normal.
    #[must_use]
    pub fn split(total: u32) -> Self {
        let heavy = total.min(5);
        let light = (total - heavy).min(5);
        Self {
            heavy,
            normal: total - heavy - light,
            light,
        }
    }

    #[must_use]
    pub const fn total(self) -> u32 {
        self.heavy
            .saturating_add(self.normal)
            .saturating_add(self.light)
    }

    pub fn add(&mut self, weight: TaskWeight) {
        let count = match weight {
            TaskWeight::Heavy => &mut self.heavy,
            TaskWeight::Normal => &mut self.normal,
            TaskWeight::Light => &mut self.light,
        };
        *count = count.saturating_add(1);
    }

    /// Check one more run against these limits. The caps nest: heavy runs fit
    /// in H, heavy and normal runs in H + M, and all runs in H + M + L.
    #[must_use]
    pub fn blocks(self, running: Self, weight: TaskWeight) -> Option<SlotBlock> {
        if running.total() >= self.total() {
            return Some(SlotBlock::Total);
        }
        let full = |weight, running: u32, limit: u32| {
            (running >= limit).then_some(SlotBlock::Weight {
                weight,
                running,
                limit,
            })
        };
        let upper = || {
            full(
                TaskWeight::Normal,
                running.heavy.saturating_add(running.normal),
                self.heavy.saturating_add(self.normal),
            )
        };
        match weight {
            TaskWeight::Heavy => full(TaskWeight::Heavy, running.heavy, self.heavy).or_else(upper),
            TaskWeight::Normal => upper(),
            TaskWeight::Light => None,
        }
    }
}
