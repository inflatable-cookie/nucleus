//! Local display inventory records.

use crate::geometry::Bounds;
use crate::ids::{DisplayArrangementSignature, DisplayId};

/// Display availability observed by the local client.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DisplayAvailability {
    Available,
    Missing,
    Unknown,
}

/// Machine-local display record used for workspace window placement.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisplayRecord {
    pub id: DisplayId,
    pub host_display_id: Option<String>,
    pub availability: DisplayAvailability,
    pub machine_label: Option<String>,
    pub user_label: Option<String>,
    pub is_main: bool,
    pub is_builtin: bool,
    pub physical_bounds: Bounds,
    pub usable_bounds: Option<Bounds>,
    /// Scale factor multiplied by 1000, avoiding floats in durable records.
    pub scale_factor_millis: Option<u32>,
}

/// Display inventory snapshot for one local arrangement.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisplayInventory {
    pub signature: DisplayArrangementSignature,
    pub displays: Vec<DisplayRecord>,
}

impl DisplayInventory {
    pub fn available_display_ids(&self) -> Vec<DisplayId> {
        self.displays
            .iter()
            .filter(|display| display.availability == DisplayAvailability::Available)
            .map(|display| display.id.clone())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::{DisplayAvailability, DisplayInventory, DisplayRecord};
    use crate::geometry::Bounds;
    use crate::ids::{DisplayArrangementSignature, DisplayId};

    #[test]
    fn available_display_ids_excludes_missing_displays() {
        let inventory = DisplayInventory {
            signature: DisplayArrangementSignature("single-display".to_string()),
            displays: vec![
                DisplayRecord {
                    id: DisplayId("display:1".to_string()),
                    host_display_id: Some("host:1".to_string()),
                    availability: DisplayAvailability::Available,
                    machine_label: Some("Built-in".to_string()),
                    user_label: None,
                    is_main: true,
                    is_builtin: true,
                    physical_bounds: Bounds {
                        x: 0,
                        y: 0,
                        width: 1920,
                        height: 1080,
                    },
                    usable_bounds: None,
                    scale_factor_millis: Some(2000),
                },
                DisplayRecord {
                    id: DisplayId("display:2".to_string()),
                    host_display_id: None,
                    availability: DisplayAvailability::Missing,
                    machine_label: None,
                    user_label: Some("Desk".to_string()),
                    is_main: false,
                    is_builtin: false,
                    physical_bounds: Bounds {
                        x: 1920,
                        y: 0,
                        width: 2560,
                        height: 1440,
                    },
                    usable_bounds: None,
                    scale_factor_millis: None,
                },
            ],
        };

        assert_eq!(
            inventory.available_display_ids(),
            vec![DisplayId("display:1".to_string())]
        );
    }
}
