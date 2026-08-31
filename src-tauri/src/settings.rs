//! What little SolCut still stores about Higgsfield.
//!
//! Authentication belongs to the Higgsfield CLI (`higgsfield auth login`), so the app
//! keeps no credential at all any more. The one thing worth persisting is the *custom
//! model id* — the Model picker's escape hatch, so any job type the CLI's live catalog
//! offers (`higgsfield model list --video`) can be pointed at without a new build.
//!
//! Settings files written by earlier builds stored API keys and endpoints for the
//! token-metered platform; those fields are simply ignored on load, and the next save
//! drops them.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const FILE: &str = "higgsfield.json";

/// Everything the app stores. One field, and even it is optional.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Settings {
    /// A CLI job type (e.g. `wan2_7`) offered as the Model picker's Custom entry.
    /// Blank means the picker shows only the built-in models.
    #[serde(default)]
    pub custom_model: String,
}

impl Settings {
    /// The same settings with stray whitespace gone.
    pub fn normalized(mut self) -> Self {
        self.custom_model = self.custom_model.trim().to_string();
        self
    }
}

/// What the frontend sees: whether the CLI is reachable (and where), plus the stored
/// custom model. No secret exists any more, so nothing needs masking.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    /// The CLI binary was found — generation can at least be attempted.
    pub configured: bool,
    /// Where it was found, for the dialog to show; `None` when it wasn't.
    pub cli_path: Option<String>,
    pub custom_model: String,
}

impl SettingsView {
    pub fn new(settings: &Settings, cli_path: Option<&Path>) -> Self {
        Self {
            configured: cli_path.is_some(),
            cli_path: cli_path.map(|p| p.display().to_string()),
            custom_model: settings.custom_model.clone(),
        }
    }
}

/// What Settings sends back. An absent field means "leave what is stored alone".
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsInput {
    pub custom_model: Option<String>,
}

impl SettingsInput {
    /// Overlay what the dialog sent onto what is stored, then normalise.
    ///
    /// A present-but-blank custom model *clears* it — blanking the box is how the Custom
    /// entry is retired.
    pub fn apply_to(&self, mut settings: Settings) -> Settings {
        if let Some(v) = &self.custom_model {
            settings.custom_model = v.clone();
        }
        settings.normalized()
    }
}

pub fn load(dir: &Path) -> Settings {
    std::fs::read_to_string(dir.join(FILE))
        .ok()
        .and_then(|raw| serde_json::from_str::<Settings>(&raw).ok())
        .unwrap_or_default()
        .normalized()
}

pub fn save(dir: &Path, settings: &Settings) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path: PathBuf = dir.join(FILE);
    let body = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_view_reports_the_cli_when_it_is_found() {
        let view = SettingsView::new(
            &Settings::default(),
            Some(Path::new("/usr/local/bin/higgsfield")),
        );
        assert!(view.configured);
        assert_eq!(view.cli_path.as_deref(), Some("/usr/local/bin/higgsfield"));

        let view = SettingsView::new(&Settings::default(), None);
        assert!(!view.configured);
        assert_eq!(view.cli_path, None);
    }

    #[test]
    fn a_typed_custom_model_is_stored_trimmed() {
        let saved = SettingsInput {
            custom_model: Some("  wan2_7 \n".into()),
        }
        .apply_to(Settings::default());
        assert_eq!(saved.custom_model, "wan2_7");
    }

    #[test]
    fn an_absent_field_leaves_the_stored_value_and_a_blank_one_clears_it() {
        let stored = Settings {
            custom_model: "wan2_7".into(),
        };
        let untouched = SettingsInput { custom_model: None }.apply_to(stored.clone());
        assert_eq!(untouched.custom_model, "wan2_7");

        let cleared = SettingsInput {
            custom_model: Some("   ".into()),
        }
        .apply_to(stored);
        assert_eq!(cleared.custom_model, "");
    }

    #[test]
    fn settings_round_trip_through_disk() {
        let dir = std::env::temp_dir().join(format!("solcut-settings-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(
            load(&dir).custom_model,
            "",
            "a fresh install stores nothing"
        );

        save(
            &dir,
            &Settings {
                custom_model: "wan2_7".into(),
            },
        )
        .expect("save");
        assert_eq!(load(&dir).custom_model, "wan2_7");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Settings files from the token-API builds stored keys and endpoints. They must
    /// load — as nothing — rather than wedge the app, and the credential is not carried
    /// anywhere new.
    #[test]
    fn a_settings_file_from_a_token_api_build_loads_as_empty() {
        let dir = std::env::temp_dir().join(format!("solcut-legacy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(FILE),
            r#"{"api_key_id":"old-id","api_key_secret":"old-secret","base_url":"https://api.higgsfield.ai","endpoint":"/bytedance/seedance/v2.5/pro/image-to-video"}"#,
        )
        .unwrap();

        let loaded = load(&dir);
        assert_eq!(loaded.custom_model, "");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_settings_file_falls_back_to_defaults() {
        let dir = std::env::temp_dir().join(format!("solcut-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(FILE), "{ not json").unwrap();
        assert_eq!(load(&dir).custom_model, "");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
