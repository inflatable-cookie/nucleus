//! Region ids for the Nucleus workspace shell.

/// Region below a hosted surface.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum RegionId {
    Left,
    Right,
    CenterTop,
    CenterBottom,
}

/// Broad region family for client rendering.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RegionFamily {
    Side,
    Center,
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
            family: RegionFamily::Side,
            label: "Left",
        },
        RegionId::Right => RegionDefinition {
            id: region_id,
            family: RegionFamily::Side,
            label: "Right",
        },
        RegionId::CenterTop => RegionDefinition {
            id: region_id,
            family: RegionFamily::Center,
            label: "Center Top",
        },
        RegionId::CenterBottom => RegionDefinition {
            id: region_id,
            family: RegionFamily::Center,
            label: "Center Bottom",
        },
    }
}

pub fn default_region_order() -> Vec<RegionId> {
    vec![
        RegionId::Left,
        RegionId::Right,
        RegionId::CenterTop,
        RegionId::CenterBottom,
    ]
}

#[cfg(test)]
mod tests {
    use super::{default_region_order, region_definition, RegionFamily, RegionId};

    #[test]
    fn center_top_is_center_family() {
        let definition = region_definition(RegionId::CenterTop);

        assert_eq!(definition.family, RegionFamily::Center);
        assert_eq!(definition.label, "Center Top");
    }

    #[test]
    fn default_region_order_uses_four_regions() {
        assert_eq!(
            default_region_order(),
            vec![
                RegionId::Left,
                RegionId::Right,
                RegionId::CenterTop,
                RegionId::CenterBottom
            ]
        );
    }
}
