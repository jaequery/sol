//! What SolCut stores about Higgsfield.
//!
//! Two unrelated things live in one small file, and it is worth being explicit about why:
//!
//! - A **custom model id** — the Model picker's escape hatch, so any job type the CLI's
//!   live catalog offers (`higgsfield model list --video`) can be pointed at without a
//!   new build.
//! - A **Cloud API key** — the `key_id` / `key_secret` pair minted at
//!   `cloud.higgsfield.ai`. It is *not* what renders: generation goes through the
//!   official CLI, which signs in as the user's higgsfield.ai account and bills its
//!   subscription workspace, and which has no notion of an API key at all. The key is
//!   kept so it can be set in one place and proved on demand.
//!
//! The secret half never leaves this process: [`SettingsView`] carries a mask and a
//! boolean, and the file it is written to is created owner-only.

use serde::{Deserialize, Serialize};
use solcut_higgsfield::{mask, Credential};
use std::path::{Path, PathBuf};

const FILE: &str = "higgsfield.json";

/// Everything the app stores.
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Settings {
    /// A CLI job type (e.g. `wan2_7`) offered as the Model picker's Custom entry.
    /// Blank means the picker shows only the built-in models.
    #[serde(default)]
    pub custom_model: String,

    /// The Cloud API key's id. The `api_key` alias reads the field name the very first
    /// build wrote, so a settings file from one of those is not silently emptied.
    #[serde(default, alias = "api_key")]
    pub api_key_id: String,

    /// The other half. Never serialised anywhere but this file, and never handed to the
    /// webview.
    #[serde(default, alias = "api_secret")]
    pub api_key_secret: String,
}

/// Hand-written so a `{:?}` — in a log line, a panic message, an error report — cannot
/// print the credential.
impl std::fmt::Debug for Settings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Settings")
            .field("custom_model", &self.custom_model)
            .field("api_key_id", &mask(&self.api_key_id))
            .field("api_key_secret", &"<redacted>")
            .finish()
    }
}

impl Settings {
    /// The same settings with stray whitespace gone, and a credential pasted whole split
    /// back into its two halves.
    ///
    /// Splitting here is what lets the single `key_id:key_secret` string Higgsfield's own
    /// SDKs take be stored, masked and sent as two halves — a combined string left in the
    /// id field would otherwise mask the tail of the *secret* and show it as the key id.
    pub fn normalized(mut self) -> Self {
        self.custom_model = self.custom_model.trim().to_string();
        match self.credential() {
            Some(credential) => {
                self.api_key_id = credential.id().to_string();
                self.api_key_secret = credential.secret().to_string();
            }
            None => {
                self.api_key_id = self.api_key_id.trim().to_string();
                self.api_key_secret = self.api_key_secret.trim().to_string();
            }
        }
        self
    }

    /// The stored credential, or `None` when what is held is not a whole one — a key id
    /// with no secret is not a credential, and cannot authenticate anything.
    pub fn credential(&self) -> Option<Credential> {
        Credential::parse(&self.api_key_id, &self.api_key_secret)
    }
}

/// What the frontend sees: whether the CLI is reachable (and where), the stored custom
/// model, and *about* the key — never the key.
///
/// `Serialize` only, deliberately. This is a redacted, lossy projection of [`Settings`] —
/// a mask stands where the key id is — so it has no meaningful inverse, and nothing has
/// ever deserialized one. The `Deserialize` it used to carry was free while every field
/// was a primitive and became a hard error the moment one was not: it silently required
/// every future field of an outbound-only view to be deserializable too.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    /// The **Higgsfield** CLI binary was found — a Higgsfield generation can at least be
    /// attempted. Deliberately unrelated to the API key: a stored key renders nothing, so
    /// letting it flip this would offer generations the machine cannot run.
    ///
    /// Equally deliberately unrelated to [`Self::agents`]: a machine with a coding-agent CLI
    /// and no Higgsfield can composite transitions perfectly well, and reading this as
    /// "generation is possible" is what used to gate that off.
    pub configured: bool,
    /// Where the CLI was found, for the dialog to show; `None` when it wasn't.
    pub cli_path: Option<String>,
    pub custom_model: String,
    /// A whole credential is stored — both halves.
    pub has_api_key: bool,
    /// e.g. `••••7fa2`, or blank. Never the key id itself, and never the secret.
    pub api_key_id_hint: String,
    /// Which coding-agent CLIs this machine has, so a render surface can offer the ones
    /// that could actually run and say how to get the ones it cannot.
    pub agents: Vec<AgentStatus>,
}

/// One coding-agent CLI as this machine has it.
///
/// `path` being `Some` means the binary was found, and nothing more — exactly the promise
/// made for the Higgsfield CLI. Whether it is *signed in* costs a process to ask and would
/// be asked on every settings read, so it is left to fail at render time with the CLI's own
/// words, which name their own fix.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    /// The id that travels with a request — `claude-code`, `codex`.
    pub id: String,
    pub label: String,
    /// Where the binary was found, for the dialog to show; `None` when it was not.
    pub path: Option<String>,
    /// Quoted verbatim when it is missing, so the fix can be pasted.
    pub install: String,
    pub login: String,
}

impl SettingsView {
    pub fn new(settings: &Settings, cli_path: Option<&Path>, agents: Vec<AgentStatus>) -> Self {
        let credential = settings.credential();
        Self {
            agents,
            configured: cli_path.is_some(),
            cli_path: cli_path.map(|p| p.display().to_string()),
            custom_model: settings.custom_model.clone(),
            has_api_key: credential.is_some(),
            api_key_id_hint: credential
                .map(|c| c.masked_id())
                .unwrap_or_else(|| mask(&settings.api_key_id)),
        }
    }
}

/// What Settings sends back. An absent field means "leave what is stored alone".
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsInput {
    pub custom_model: Option<String>,
    pub api_key_id: Option<String>,
    pub api_key_secret: Option<String>,
    /// Remove the stored credential. The dialog arms this from its "Forget key" control
    /// and disarms it the moment anything is typed into either key box, so a forget and a
    /// new key can never both apply.
    #[serde(default)]
    pub forget_api_key: bool,
}

impl SettingsInput {
    /// Overlay what the dialog sent onto what is stored, then normalise.
    ///
    /// The two kinds of field deliberately differ, because the dialog treats them
    /// differently:
    ///
    /// - `custom_model` is shown filled in, so a present-but-blank value *clears* it —
    ///   emptying the box is how the Custom entry is retired.
    /// - the key boxes always mount empty (the secret is never sent back to be shown), so
    ///   a blank one means *keep what is stored* — otherwise every save would wipe the
    ///   credential. [`SettingsInput::forget_api_key`] is the way to remove one.
    pub fn apply_to(&self, mut settings: Settings) -> Settings {
        if let Some(v) = &self.custom_model {
            settings.custom_model = v.clone();
        }
        if self.forget_api_key {
            settings.api_key_id = String::new();
            settings.api_key_secret = String::new();
        }
        if let Some(v) = non_blank(&self.api_key_id) {
            settings.api_key_id = v;
            // A fresh id with no secret beside it replaces the whole credential rather
            // than pairing with the old secret — the two halves are issued together, so
            // half of one and half of another authenticates nothing.
            settings.api_key_secret = non_blank(&self.api_key_secret).unwrap_or_default();
        } else if let Some(v) = non_blank(&self.api_key_secret) {
            settings.api_key_secret = v;
        }
        settings.normalized()
    }
}

fn non_blank(v: &Option<String>) -> Option<String> {
    v.as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
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
    write_private(&path, body.as_bytes())
}

/// Write the file owner-only.
///
/// The mode goes on at *open* time rather than as a `chmod` afterwards: the secret must
/// never exist on disk world-readable, not even for the moment between the two calls.
/// `truncate` also repairs the permissions of a file an earlier build left at 0644.
#[cfg(unix)]
fn write_private(path: &Path, body: &[u8]) -> Result<(), String> {
    use std::io::Write as _;
    use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};

    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| e.to_string())?;
    // `mode` only applies when the file is created, so an existing one keeps whatever it
    // had — including the 0644 the credential-free builds wrote.
    let _ = file.set_permissions(std::fs::Permissions::from_mode(0o600));
    file.write_all(body).map_err(|e| e.to_string())
}

#[cfg(not(unix))]
fn write_private(path: &Path, body: &[u8]) -> Result<(), String> {
    std::fs::write(path, body).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_key() -> Settings {
        Settings {
            custom_model: String::new(),
            api_key_id: "hf_live_abcdef7fa2".into(),
            api_key_secret: "shh".into(),
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("solcut-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn the_view_reports_the_cli_when_it_is_found() {
        let view = SettingsView::new(
            &Settings::default(),
            Some(Path::new("/usr/local/bin/higgsfield")),
            Vec::new(),
        );
        assert!(view.configured);
        assert_eq!(view.cli_path.as_deref(), Some("/usr/local/bin/higgsfield"));

        let view = SettingsView::new(&Settings::default(), None, Vec::new());
        assert!(!view.configured);
        assert_eq!(view.cli_path, None);
    }

    /// The key is not what renders — the CLI is — so storing one must not make the app
    /// think it can generate. Every "Connect Higgsfield" gate reads `configured`.
    #[test]
    fn a_stored_key_does_not_make_the_app_look_connected() {
        let view = SettingsView::new(&with_key(), None, Vec::new());
        assert!(view.has_api_key, "the key is stored");
        assert!(!view.configured, "but the CLI is still what renders");
    }

    #[test]
    fn the_view_carries_a_mask_and_never_the_credential() {
        let view = SettingsView::new(&with_key(), None, Vec::new());
        assert!(view.has_api_key);
        assert_eq!(view.api_key_id_hint, "••••••••••••••7fa2");

        let json = serde_json::to_string(&view).expect("serialize");
        assert!(!json.contains("shh"), "the secret never crosses: {json}");
        assert!(
            !json.contains("hf_live_abcdef"),
            "nor does the id itself: {json}"
        );
    }

    /// Both halves are issued together and both are needed to form the header, so a lone
    /// id is not a credential — reporting it as one would offer a Test that cannot pass.
    #[test]
    fn a_key_id_without_a_secret_is_not_a_stored_key() {
        let half = Settings {
            api_key_id: "hf_live_abcdef7fa2".into(),
            ..Settings::default()
        };
        assert!(half.credential().is_none());
        assert!(!SettingsView::new(&half, None, Vec::new()).has_api_key);
    }

    #[test]
    fn a_typed_custom_model_is_stored_trimmed() {
        let saved = SettingsInput {
            custom_model: Some("  wan2_7 \n".into()),
            ..SettingsInput::default()
        }
        .apply_to(Settings::default());
        assert_eq!(saved.custom_model, "wan2_7");
    }

    #[test]
    fn an_absent_custom_model_is_left_alone_and_a_blank_one_clears_it() {
        let stored = Settings {
            custom_model: "wan2_7".into(),
            ..Settings::default()
        };
        let untouched = SettingsInput::default().apply_to(stored.clone());
        assert_eq!(untouched.custom_model, "wan2_7");

        let cleared = SettingsInput {
            custom_model: Some("   ".into()),
            ..SettingsInput::default()
        }
        .apply_to(stored);
        assert_eq!(cleared.custom_model, "");
    }

    /// The key boxes mount empty every time the dialog opens, so a blank one has to mean
    /// "keep" — the opposite of the custom model's rule. Saving an unrelated edit must
    /// not wipe the credential.
    #[test]
    fn blank_key_boxes_leave_the_stored_credential_alone() {
        let saved = SettingsInput {
            custom_model: Some("wan2_7".into()),
            api_key_id: Some(String::new()),
            api_key_secret: Some("  ".into()),
            ..SettingsInput::default()
        }
        .apply_to(with_key());

        assert_eq!(saved.custom_model, "wan2_7");
        assert_eq!(saved.api_key_id, "hf_live_abcdef7fa2");
        assert_eq!(saved.api_key_secret, "shh");
    }

    /// Half of one credential and half of another authenticates nothing, and would report
    /// the *new* key as bad. A new id therefore replaces the pair.
    #[test]
    fn a_new_key_id_does_not_pair_with_the_old_secret() {
        let saved = SettingsInput {
            api_key_id: Some("a-new-id".into()),
            ..SettingsInput::default()
        }
        .apply_to(with_key());

        assert_eq!(saved.api_key_id, "a-new-id");
        assert_eq!(
            saved.api_key_secret, "",
            "the old secret does not carry over"
        );
        assert!(saved.credential().is_none(), "half a credential is not one");
    }

    #[test]
    fn a_credential_pasted_whole_is_stored_and_masked_as_its_two_halves() {
        let saved = SettingsInput {
            api_key_id: Some("  test-id:test-secret \n".into()),
            ..SettingsInput::default()
        }
        .apply_to(Settings::default());

        assert_eq!(saved.api_key_id, "test-id");
        assert_eq!(saved.api_key_secret, "test-secret");
        assert_eq!(
            SettingsView::new(&saved, None, Vec::new()).api_key_id_hint,
            "•••t-id"
        );
    }

    /// Blank-means-keep would otherwise make a stored credential permanent. Forget is the
    /// way out, and it cannot collide with a typed key: the dialog disarms it on any
    /// keystroke, and here a typed id wins regardless.
    #[test]
    fn forget_removes_the_credential_and_a_typed_key_still_wins() {
        let forgotten = SettingsInput {
            forget_api_key: true,
            ..SettingsInput::default()
        }
        .apply_to(with_key());
        assert!(forgotten.credential().is_none());
        assert_eq!(forgotten.api_key_id, "");
        assert_eq!(forgotten.api_key_secret, "");

        let replaced = SettingsInput {
            forget_api_key: true,
            api_key_id: Some("new-id".into()),
            api_key_secret: Some("new-secret".into()),
            ..SettingsInput::default()
        }
        .apply_to(with_key());
        assert_eq!(replaced.api_key_id, "new-id");
        assert_eq!(replaced.api_key_secret, "new-secret");

        // Forgetting leaves the rest of the settings alone.
        let both = SettingsInput {
            forget_api_key: true,
            ..SettingsInput::default()
        }
        .apply_to(Settings {
            custom_model: "wan2_7".into(),
            ..with_key()
        });
        assert_eq!(both.custom_model, "wan2_7");
    }

    #[test]
    fn the_debug_rendering_cannot_leak_the_credential() {
        let shown = format!("{:?}", with_key());
        assert!(!shown.contains("shh"), "{shown}");
        assert!(!shown.contains("hf_live_abcdef"), "{shown}");
    }

    #[test]
    fn settings_round_trip_through_disk() {
        let dir = scratch("settings");
        assert_eq!(
            load(&dir).custom_model,
            "",
            "a fresh install stores nothing"
        );
        assert!(load(&dir).credential().is_none());

        save(
            &dir,
            &Settings {
                custom_model: "wan2_7".into(),
                ..with_key()
            },
        )
        .expect("save");

        let loaded = load(&dir);
        assert_eq!(loaded.custom_model, "wan2_7");
        assert_eq!(loaded.api_key_id, "hf_live_abcdef7fa2");
        assert_eq!(loaded.api_key_secret, "shh");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The file holds a secret, so it is owner-only — including when it is overwriting a
    /// file that a credential-free build had already written world-readable.
    #[cfg(unix)]
    #[test]
    fn the_settings_file_is_owner_only_even_over_a_world_readable_one() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = scratch("perms");
        std::fs::create_dir_all(&dir).unwrap();

        let path = dir.join(FILE);
        std::fs::write(&path, "{}").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        save(&dir, &with_key()).expect("save");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "0o{mode:o}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Settings files from the token-API builds stored a key beside a base URL and an
    /// endpoint. The key comes back — it is the same credential, for the same platform —
    /// while the routing fields, which served a submit path that no longer exists, are
    /// dropped. Note this only reaches installs that never pressed Save on a
    /// credential-free build; those files were rewritten without the key already.
    #[test]
    fn a_settings_file_from_a_token_api_build_brings_its_key_forward() {
        let dir = scratch("legacy");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(FILE),
            r#"{"api_key_id":"old-id","api_key_secret":"old-secret",
                "base_url":"https://api.higgsfield.ai",
                "endpoint":"/bytedance/seedance/v2.5/pro/image-to-video"}"#,
        )
        .unwrap();

        let loaded = load(&dir);
        assert_eq!(loaded.api_key_id, "old-id");
        assert_eq!(loaded.api_key_secret, "old-secret");
        assert_eq!(loaded.custom_model, "", "no endpoint becomes a model id");

        let written = {
            save(&dir, &loaded).expect("save");
            std::fs::read_to_string(dir.join(FILE)).unwrap()
        };
        assert!(!written.contains("base_url"), "{written}");
        assert!(!written.contains("endpoint"), "{written}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The *first* build wrote the halves under different names. Without the serde
    /// aliases such a file would load as empty and quietly lose the key.
    #[test]
    fn a_settings_file_from_the_first_build_is_read_under_its_own_field_names() {
        let dir = scratch("first-build");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(FILE),
            r#"{"api_key":"first-id","api_secret":"first-secret"}"#,
        )
        .unwrap();

        let loaded = load(&dir);
        assert_eq!(loaded.api_key_id, "first-id");
        assert_eq!(loaded.api_key_secret, "first-secret");
        assert!(loaded.credential().is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_settings_file_falls_back_to_defaults() {
        let dir = scratch("bad");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(FILE), "{ not json").unwrap();
        let loaded = load(&dir);
        assert_eq!(loaded.custom_model, "");
        assert!(loaded.credential().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
