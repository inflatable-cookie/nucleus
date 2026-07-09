//! Geometry records for local workspace hosting.

/// Pixel bounds for a display or window.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Bounds {
    pub fn is_empty(&self) -> bool {
        self.width == 0 || self.height == 0
    }
}

/// Window geometry captured for one target display.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WindowGeometry {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl WindowGeometry {
    pub fn as_bounds(&self) -> Bounds {
        Bounds {
            x: self.x,
            y: self.y,
            width: self.width,
            height: self.height,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Bounds, WindowGeometry};

    #[test]
    fn window_geometry_converts_to_bounds() {
        let geometry = WindowGeometry {
            x: 12,
            y: 34,
            width: 800,
            height: 600,
        };

        assert_eq!(
            geometry.as_bounds(),
            Bounds {
                x: 12,
                y: 34,
                width: 800,
                height: 600
            }
        );
    }
}
