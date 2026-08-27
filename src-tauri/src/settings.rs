//! Higgsfield credentials, stored by the backend so they never reach the webview.

use serde::{Deserialize, Serialize};
use solcut_higgsfield::Config;
use std::path::{Path, PathBuf};

const FILE: &str = "higgsfield.json";

/// What the frontend is allowed to see: enough to render the Settings dialog, with the
/// secret parts reduced to a hint.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    pub configured: bool,
    /// e.g. `••••7fa2` — never the key itself.
    pub api_key_hint: String,
    pub has_secret: bool,
    pub base_url: String,
    pub model: String,
    pub endpoint: String,
}

impl From<&Config> for SettingsView {
    fn from(c: &Config) -> Self {
        Self {
            configured: c.is_configured(),
            api_key_hint: mask(&c.api_key),
            has_secret: !c.api_secret.trim().is_empty(),
            base_url: c.base_url.clone(),
            model: c.model.clone(),
            endpoint: c.endpoint.clone(),
        }
    }
}

/// What Settings sends back. Blank secret fields mean "leave what is stored alone", so
/// the user can edit the model without retyping their key.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsInput {
    pub api_key: Option<String>,
    pub api_secret: Option<String>,
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub endpoint: Option<String>,
}

impl SettingsInput {
    pub fn apply_to(&self, mut config: Config) -> Config {
        if let Some(v) = non_blank(&self.api_key) {
            config.api_key = v;
        }
        if let Some(v) = &self.api_secret {
            // An explicit empty string clears the secret; `None` leaves it.
            config.api_secret = v.trim().to_string();
        }
        if let Some(v) = non_blank(&self.base_url) {
            config.base_url = v;
        }
        if let Some(v) = non_blank(&self.model) {
            config.model = v;
        }
        if let Some(v) = non_blank(&self.endpoint) {
            config.endpoint = v;
        }
        config
    }
}

fn non_blank(v: &Option<String>) -> Option<String> {
    v.as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Last four characters, everything before them masked.
pub fn mask(key: &str) -> String {
    let key = key.trim();
    if key.is_empty() {
        return String::new();
    }
    let visible: String = key
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!(
        "{}{visible}",
        "•".repeat(key.chars().count().saturating_sub(4).min(20))
    )
}

pub fn load(dir: &Path) -> Config {
    std::fs::read_to_string(dir.join(FILE))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn save(dir: &Path, config: &Config) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path: PathBuf = dir.join(FILE);
    let body = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| e.to_string())?;
    restrict(&path);
    Ok(())
}

/// The file holds an API key, so keep it owner-readable.
#[cfg(unix)]
fn restrict(path: &Path) {
    use std::os::unix::fs::PermissionsExt as _;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masking_keeps_only_the_last_four_characters() {
        let masked = mask("hf_live_abcdef7fa2");
        assert!(masked.ends_with("7fa2"));
        assert!(!masked.contains("abcdef"));
        assert_eq!(mask(""), "");
    }

    #[test]
    fn masking_a_short_key_reveals_no_more_than_it_has() {
        assert_eq!(mask("ab"), "ab");
    }

    #[test]
    fn the_view_never_carries_the_key_itself() {
        let config = Config {
            api_key: "hf_secret_value".into(),
            ..Config::default()
        };
        let view = SettingsView::from(&config);
        assert!(view.configured);
        assert!(!serde_json::to_string(&view)
            .unwrap()
            .contains("hf_secret_value"));
    }

    #[test]
    fn blank_fields_leave_the_stored_key_alone() {
        let stored = Config {
            api_key: "keep-me".into(),
            ..Config::default()
        };
        let updated = SettingsInput {
            model: Some("turbo".into()),
            ..Default::default()
        }
        .apply_to(stored);
        assert_eq!(updated.api_key, "keep-me");
        assert_eq!(updated.model, "turbo");
    }

    #[test]
    fn an_explicit_empty_secret_clears_it() {
        let stored = Config {
            api_secret: "old".into(),
            ..Config::default()
        };
        let updated = SettingsInput {
            api_secret: Some(String::new()),
            ..Default::default()
        }
        .apply_to(stored);
        assert_eq!(updated.api_secret, "");
    }

    #[test]
    fn settings_round_trip_through_disk() {
        let dir = std::env::temp_dir().join(format!("solcut-settings-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        assert!(!load(&dir).is_configured(), "a fresh install has no key");

        let config = Config {
            api_key: "hf_k".into(),
            model: "dop".into(),
            ..Config::default()
        };
        save(&dir, &config).expect("save");
        assert_eq!(load(&dir).api_key, "hf_k");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(dir.join(FILE))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "the key file is owner-only");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_settings_file_falls_back_to_defaults() {
        let dir = std::env::temp_dir().join(format!("solcut-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(FILE), "{ not json").unwrap();
        assert!(!load(&dir).is_configured());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
