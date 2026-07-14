//! Workspace panel tree types.

use crate::ids::PanelId;

/// Durable panel container in a workspace layout.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Panel {
    pub id: PanelId,
    pub kind: PanelKind,
    pub tab_ids: Vec<PanelId>,
    pub active_tab_id: Option<PanelId>,
    pub split_direction: Option<SplitDirection>,
    pub size_hint: Option<PanelSizeHint>,
    pub child_panel_ids: Vec<PanelId>,
}

/// Panel role in a layout tree.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PanelKind {
    Tabs,
    Split,
    Stack,
}

/// Split direction for split panels.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SplitDirection {
    Horizontal,
    Vertical,
}

/// Advisory size hint before client rendering rules exist.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PanelSizeHint {
    Fraction { numerator: u16, denominator: u16 },
    Pixels(u32),
    Flexible,
}
