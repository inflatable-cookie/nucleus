//! The environment's board theme, from T3's `subscribeServerConfig` stream.
//!
//! The stream's `snapshot` carries the settings (and the published themes when
//! the server includes them), `settingsUpdated` carries changed settings and
//! `environmentThemesUpdated` carries the published theme files. Only the
//! default theme, the default appearance and the selected theme's definition
//! reach the board. The web client turns them into its palette with the same
//! code the TypeScript host uses.

use serde_json::{Map, Value, json};

const MAX_THEME_ID: usize = 64;

/// The theme inputs the board needs, kept between stream events.
#[derive(Debug, Default)]
pub(crate) struct ThemeTracker {
    default_theme: Option<String>,
    default_appearance: Option<String>,
    themes: Vec<Value>,
}

impl ThemeTracker {
    /// Apply one stream event. Returns whether the event was a config event.
    pub(crate) fn apply(&mut self, event: &Value) -> bool {
        match event["type"].as_str() {
            Some("snapshot") => {
                let config = &event["config"];
                self.settings(&config["settings"]);
                if let Some(themes) = config["environmentThemes"].as_array() {
                    self.themes.clone_from(themes);
                }
                true
            }
            Some("settingsUpdated") => {
                self.settings(&event["payload"]["settings"]);
                true
            }
            Some("environmentThemesUpdated") => {
                if let Some(themes) = event["payload"]["themes"].as_array() {
                    self.themes.clone_from(themes);
                }
                true
            }
            _ => false,
        }
    }

    /// A settings payload can be partial. Keep the fields it does not name.
    fn settings(&mut self, settings: &Value) {
        let Some(settings) = settings.as_object() else {
            return;
        };
        if let Some(value) = settings.get("defaultTheme") {
            self.default_theme = text(value);
        }
        if let Some(value) = settings.get("defaultAppearance") {
            self.default_appearance = text(value);
        }
    }

    /// The board's theme inputs: the settings and the selected published theme.
    pub(crate) fn snapshot(&self) -> Value {
        let mut settings = Map::new();
        if let Some(theme) = &self.default_theme {
            settings.insert("defaultTheme".into(), json!(theme));
        }
        if let Some(appearance) = &self.default_appearance {
            settings.insert("defaultAppearance".into(), json!(appearance));
        }
        let selected = self.default_theme.as_ref().and_then(|id| {
            self.themes
                .iter()
                .find(|theme| theme["id"].as_str() == Some(id.as_str()))
                .cloned()
        });
        json!({"settings": settings, "theme": selected})
    }
}

fn text(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|text| text.len() <= MAX_THEME_ID)
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::ThemeTracker;

    #[test]
    fn theme_events_keep_settings_and_select_the_published_theme() {
        let mut tracker = ThemeTracker::default();
        assert!(tracker.apply(&json!({
            "version": 1, "type": "snapshot",
            "config": {"settings": {"defaultTheme": "ocean", "defaultAppearance": "dark", "other": 1}}
        })));
        assert_eq!(
            tracker.snapshot(),
            json!({"settings": {"defaultTheme": "ocean", "defaultAppearance": "dark"}, "theme": null})
        );
        let ocean = json!({"id": "ocean", "appearance": "dark", "canvas": "#001122", "accent": "#3366ff"});
        assert!(tracker.apply(&json!({
            "version": 1, "type": "environmentThemesUpdated",
            "payload": {"themes": [{"id": "forest"}, ocean]}
        })));
        assert_eq!(tracker.snapshot()["theme"], ocean);
        assert!(tracker.apply(&json!({
            "version": 1, "type": "settingsUpdated",
            "payload": {"settings": {"defaultAppearance": "light"}}
        })));
        assert_eq!(
            tracker.snapshot()["settings"],
            json!({"defaultTheme": "ocean", "defaultAppearance": "light"})
        );
        assert!(!tracker.apply(&json!({"version": 1, "type": "keybindingsUpdated", "payload": {}})));
    }
}
