use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
pub struct Seg {
    pub role: String,
    pub name: String,
}

#[derive(Clone, Serialize)]
pub struct Frame {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Clone, Serialize)]
pub struct Node {
    pub role: String,
    pub subrole: String,
    pub title: String,
    pub description: String,
    pub identifier: String,
    pub name: String,
    pub value: String,
    pub actions: Vec<String>,
    /// Top-left screen points, the space `at-point` expects.
    pub frame: Option<Frame>,
    /// AXPosition and AXSize as the attribute returned them.
    pub ax_frame: Option<Frame>,
    pub path: Vec<Seg>,
    pub pid: i32,
    pub app: String,
    pub useful: bool,
}

#[derive(Clone, Serialize)]
pub struct Geometry {
    pub screen_w: f64,
    pub screen_h: f64,
    pub flip_y: bool,
    pub ax_window: Option<Frame>,
    pub cg_window: Option<Frame>,
}

pub struct Geom {
    pub screen_w: f64,
    pub screen_h: f64,
    pub flip_y: bool,
    pub ax_window: Option<Frame>,
    pub cg_window: Option<Frame>,
}

impl Geom {
    pub fn to_top_left(&self, x: f64, y: f64, h: f64) -> (f64, f64) {
        if self.flip_y {
            (x, self.screen_h - y - h)
        } else {
            (x, y)
        }
    }

    pub fn to_ax_origin(&self, x: f64, y: f64, h: f64) -> (f64, f64) {
        self.to_top_left(x, y, h)
    }

    pub fn report(&self) -> Geometry {
        Geometry {
            screen_w: self.screen_w,
            screen_h: self.screen_h,
            flip_y: self.flip_y,
            ax_window: self.ax_window.clone(),
            cg_window: self.cg_window.clone(),
        }
    }
}
