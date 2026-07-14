//! Region ids for the Nucleus workspace shell.

/// Semantic region inside a workspace window.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum RegionId {
    Left,
    CenterTop,
    CenterBottom,
    RightTop,
    RightBottom,
}

/// Broad region family for client rendering.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RegionFamily {
    Activity,
    Workspace,
}

/// Static region definition.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RegionDefinition {
    pub id: RegionId,
    pub family: RegionFamily,
    pub label: &'static str,
}

pub fn region_definition(region_id: RegionId) -> RegionDefinition {
    match region_id {
        RegionId::Left => RegionDefinition {
            id: region_id,
            family: RegionFamily::Activity,
            label: "Left",
        },
        RegionId::CenterTop => RegionDefinition {
            id: region_id,
            family: RegionFamily::Workspace,
            label: "Center Top",
        },
        RegionId::CenterBottom => RegionDefinition {
            id: region_id,
            family: RegionFamily::Workspace,
            label: "Center Bottom",
        },
        RegionId::RightTop => RegionDefinition {
            id: region_id,
            family: RegionFamily::Workspace,
            label: "Right Top",
        },
        RegionId::RightBottom => RegionDefinition {
            id: region_id,
            family: RegionFamily::Workspace,
            label: "Right Bottom",
        },
    }
}

pub fn default_region_order() -> Vec<RegionId> {
    vec![
        RegionId::Left,
        RegionId::CenterTop,
        RegionId::CenterBottom,
        RegionId::RightTop,
        RegionId::RightBottom,
    ]
}

#[cfg(test)]
mod tests {
    use super::{default_region_order, region_definition, RegionFamily, RegionId};

    #[test]
    fn center_top_is_workspace_family() {
        let definition = region_definition(RegionId::CenterTop);

        assert_eq!(definition.family, RegionFamily::Workspace);
        assert_eq!(definition.label, "Center Top");
    }

    #[test]
    fn default_region_order_uses_activity_plus_four_workspace_regions() {
        assert_eq!(
            default_region_order(),
            vec![
                RegionId::Left,
                RegionId::CenterTop,
                RegionId::CenterBottom,
                RegionId::RightTop,
                RegionId::RightBottom,
            ]
        );
    }
}
