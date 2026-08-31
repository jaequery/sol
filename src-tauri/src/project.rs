//! The saved project — what the editor was holding when it was last closed.
//!
//! Only ever one, and it is written for the user rather than by them: there is no save
//! action and no file dialog, so the app keeps a single `project.json` beside the settings
//! and rewrites it as the timeline changes.
//!
//! The blob is deliberately **opaque** on this side. What a project contains, which
//! version the schema is at, and what to do with a file that does not validate all live in
//! `src/lib/project.ts` — so the shape is described once, in one language, instead of by
//! two definitions that have to be kept agreeing. This module's whole job is to put bytes
//! on disk and get them back.

use serde_json::Value;
use std::path::{Path, PathBuf};

const FILE: &str = "project.json";

/// The stored project, or `None` when there is nothing to read.
///
/// Infallible, exactly as `settings::load` is: a file that was never written and one that
/// cannot be parsed are the same answer here, because either way there is no project to
/// put on screen. Deciding what an unreadable project *means* is the frontend's job.
pub fn load(dir: &Path) -> Option<Value> {
    std::fs::read_to_string(dir.join(FILE))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
}

/// Write the project, atomically.
///
/// The one deliberate deviation from `settings::save`, which writes straight to its
/// target: this file is rewritten every few seconds while the user works, so a crash
/// during a bare write would truncate *the project* rather than a 30-byte settings file.
/// Writing a sibling temp file and renaming it over the target means a reader only ever
/// sees a whole project — `fs::rename` replaces the destination on every platform SolCut
/// ships to.
pub fn save(dir: &Path, project: &Value) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path: PathBuf = dir.join(FILE);
    let temp: PathBuf = dir.join(format!("{}.writing", FILE));
    let body = serde_json::to_string_pretty(project).map_err(|e| e.to_string())?;
    std::fs::write(&temp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, &path).map_err(|e| {
        // A rename that failed leaves a half-written file next to the real one. It is not
        // the project, and the next load must not find it lying around.
        let _ = std::fs::remove_file(&temp);
        e.to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_fresh_install_has_no_project() {
        let dir = std::env::temp_dir().join(format!("solcut-project-fresh-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(load(&dir).is_none());
    }

    #[test]
    fn a_project_round_trips_through_disk() {
        let dir = std::env::temp_dir().join(format!("solcut-project-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(load(&dir).is_none(), "nothing is stored yet");

        let project = json!({
            "version": 1,
            "assets": [{ "id": "asset_1", "name": "cliff.png", "path": "/tmp/cliff.png" }],
            "clips": [{ "id": "clip_1", "assetId": "asset_1", "startMs": 0 }],
        });
        save(&dir, &project).expect("save");
        assert_eq!(load(&dir), Some(project));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The blob is the frontend's, so a project written by a build that knows more fields
    /// than this one does has to come back byte-for-byte rather than be trimmed to a shape
    /// this side happens to understand.
    #[test]
    fn a_shape_this_build_does_not_know_survives_untouched() {
        let dir =
            std::env::temp_dir().join(format!("solcut-project-future-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        let project = json!({ "version": 99, "somethingNew": { "nested": [1, 2, 3] } });
        save(&dir, &project).expect("save");
        assert_eq!(load(&dir), Some(project));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_project_file_reads_as_nothing() {
        let dir = std::env::temp_dir().join(format!("solcut-project-bad-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(FILE), "{ not json").unwrap();
        assert!(load(&dir).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The atomic write must not leave its temp file sitting next to the project.
    #[test]
    fn a_finished_write_leaves_no_temp_file_behind() {
        let dir = std::env::temp_dir().join(format!("solcut-project-temp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        save(&dir, &json!({ "version": 1 })).expect("save");
        assert!(dir.join(FILE).exists());
        assert!(!dir.join(format!("{}.writing", FILE)).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
