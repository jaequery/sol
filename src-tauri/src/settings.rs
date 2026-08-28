//! Higgsfield credentials, stored by the backend so they never reach the webview.
//!
//! A Higgsfield credential is a key *id* plus a *secret* and both are needed to form the
//! `Authorization: Key {id}:{secret}` header, so the dialog asks for both and the
//! connection only counts as configured once it has them.

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
    /// e.g. `••••7fa2` — never the key id itself.
    pub api_key_id_hint: String,
    pub has_secret: bool,
    pub base_url: String,
    /// The model endpoint, e.g. `/higgsfield-ai/dop/standard`.
    pub endpoint: String,
}

impl From<&Config> for SettingsView {
    fn from(c: &Config) -> Self {
        Self {
            configured: c.is_configured(),
            api_key_id_hint: mask(&c.api_key_id),
            has_secret: !c.api_key_secret.trim().is_empty(),
            base_url: c.base_url.clone(),
            endpoint: c.endpoint.clone(),
        }
    }
}

/// What Settings sends back. Blank secret fields mean "leave what is stored alone", so
/// the user can edit the endpoint without retyping their credential.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsInput {
    pub api_key_id: Option<String>,
    pub api_key_secret: Option<String>,
    pub base_url: Option<String>,
    pub endpoint: Option<String>,
}

impl SettingsInput {
    pub fn apply_to(&self, mut config: Config) -> Config {
        if let Some(v) = non_blank(&self.api_key_id) {
            config.api_key_id = v;
        }
        if let Some(v) = non_blank(&self.api_key_secret) {
            config.api_key_secret = v;
        }
        if let Some(v) = non_blank(&self.base_url) {
            config.base_url = v;
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

/// The file holds a credential, so keep it owner-readable.
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

    fn configured() -> Config {
        Config {
            api_key_id: "hf_live_abcdef7fa2".into(),
            api_key_secret: "shh".into(),
            ..Config::default()
        }
    }

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
    fn the_view_never_carries_the_credential_itself() {
        let view = SettingsView::from(&configured());
        assert!(view.configured);
        assert!(view.has_secret);
        let json = serde_json::to_string(&view).unwrap();
        assert!(!json.contains("hf_live_abcdef7fa2"));
        assert!(!json.contains("shh"));
    }

    #[test]
    fn a_key_id_without_a_secret_is_not_configured() {
        let half = Config {
            api_key_id: "id-only".into(),
            ..Config::default()
        };
        assert!(!SettingsView::from(&half).configured);
    }

    #[test]
    fn blank_fields_leave_the_stored_credential_alone() {
        let updated = SettingsInput {
            endpoint: Some("/veo3.1/first-last-frame-to-video".into()),
            ..Default::default()
        }
        .apply_to(configured());
        assert_eq!(updated.api_key_id, "hf_live_abcdef7fa2");
        assert_eq!(updated.api_key_secret, "shh");
        assert_eq!(updated.endpoint, "/veo3.1/first-last-frame-to-video");
    }

    #[test]
    fn settings_round_trip_through_disk() {
        let dir = std::env::temp_dir().join(format!("solcut-settings-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        assert!(
            !load(&dir).is_configured(),
            "a fresh install has no credential"
        );

        save(&dir, &configured()).expect("save");
        let loaded = load(&dir);
        assert_eq!(loaded.api_key_id, "hf_live_abcdef7fa2");
        assert_eq!(loaded.api_key_secret, "shh");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(dir.join(FILE))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "the credential file is owner-only");
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
