//! The saved project — bytes on disk, and where they went.
//!
//! There are two kinds of project and one pointer between them. The **scratch**
//! (`project.json`, beside the settings) is the untitled project: the app has always kept
//! one and rewritten it as the timeline changes, and a first run still starts there. A
//! **named** project is an ordinary `.solcut` file at a path the user picked, and is
//! written to exactly that path. `current.txt` remembers which of the two the last write
//! went to, so the next launch opens the project the user was actually in.
//!
//! The blob is deliberately **opaque** on this side. What a project contains, which
//! version the schema is at, and what to do with a file that does not validate all live in
//! `src/lib/project.ts` — so the shape is described once, in one language, instead of by
//! two definitions that have to be kept agreeing. This module's whole job is to put bytes
//! on disk and get them back.
//!
//! Every command in `lib.rs` is a one-line delegation to something here. That is not
//! tidiness: this module has no Tauri dependency, so it is the half of the feature that
//! can be compiled and tested without the desktop shell.

use serde_json::Value;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

const FILE: &str = "project.json";
const CURRENT: &str = "current.txt";

/// The stored scratch project, or `None` when there is nothing to read.
///
/// Infallible, exactly as `settings::load` is: a file that was never written and one that
/// cannot be parsed are the same answer here, because either way there is no project to
/// put on screen. Deciding what an unreadable project *means* is the frontend's job.
pub fn load(dir: &Path) -> Option<Value> {
    std::fs::read_to_string(dir.join(FILE))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
}

/// The project at a path the user named.
///
/// The one deliberate difference from [`load`]: this one can fail out loud. A file the
/// user *pointed at* is not the same as a scratch that happens to be absent — answering
/// `None` for "there is nothing there" would have the frontend read it as an empty
/// project, open an empty editor still aimed at that path, and overwrite the user's real
/// project with nothing on the first edit. The path is in the message because the dialog
/// that produced it is long gone by the time the error is read.
pub fn read(path: &Path) -> Result<Value, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_str::<Value>(&raw).map_err(|e| format!("{}: {e}", path.display()))
}

/// Write the scratch project.
///
/// Creates the config directory, which on a first run does not exist yet — and which is
/// exactly what [`save_to`] must *not* do for a path of the user's own.
pub fn save(dir: &Path, project: &Value) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    save_to(&dir.join(FILE), project)
}

/// Write a project to exactly this path, atomically.
///
/// The one deliberate deviation from `settings::save`, which writes straight to its
/// target: this file is rewritten every few seconds while the user works, so a crash
/// during a bare write would truncate *the project* rather than a 30-byte settings file.
/// The temp file is the target's own name with `.writing` pushed onto it, so it is always
/// in the target's directory and therefore on the target's filesystem — `fs::rename`
/// replaces the destination atomically on every platform SolCut ships to, but only within
/// one filesystem.
///
/// **No directory is created.** A missing parent means the place the user chose is not
/// there any more — an unplugged drive, most often — and `create_dir_all` would helpfully
/// rebuild the mountpoint on the local disk and write a shadow project underneath it,
/// which vanishes the moment the real drive comes back.
pub fn save_to(path: &Path, project: &Value) -> Result<(), String> {
    let mut name: OsString = path.as_os_str().to_owned();
    name.push(".writing");
    let temp = PathBuf::from(name);

    let body = serde_json::to_string_pretty(project).map_err(|e| e.to_string())?;
    std::fs::write(&temp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, path).map_err(|e| {
        // A rename that failed leaves a half-written file next to the real one. It is not
        // the project, and the next load must not find it lying around.
        let _ = std::fs::remove_file(&temp);
        e.to_string()
    })
}

/// The project the last write went to, or `None` when that was the scratch.
pub fn remembered(dir: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(dir.join(CURRENT)).ok()?;
    let path = raw.trim();
    if path.is_empty() {
        None
    } else {
        Some(path.to_string())
    }
}

/// Record where the last write went, so the next launch opens it.
///
/// Written as a side effect of saving rather than by the actions that change projects, so
/// the pointer cannot name a file the app never managed to write. It only touches the disk
/// when the answer actually changed — otherwise autosave would rewrite it every 500ms for
/// a value that changes when a project is opened, created or named, and no other time.
///
/// Forgetting removes the file rather than blanking it, so a config directory that has
/// only ever held untitled work looks like one.
pub fn remember(dir: &Path, path: Option<&str>) -> Result<(), String> {
    let wanted = path.unwrap_or("").trim();
    if remembered(dir).as_deref().unwrap_or("") == wanted {
        return Ok(());
    }

    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let file = dir.join(CURRENT);
    if wanted.is_empty() {
        return match std::fs::remove_file(&file) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        };
    }
    std::fs::write(&file, wanted).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Each test gets its own directory: they run in one process, in parallel, and a
    /// shared one would have them reading each other's pointer.
    fn dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("solcut-project-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn a_fresh_install_has_no_project() {
        assert!(load(&dir("fresh")).is_none());
    }

    #[test]
    fn a_project_round_trips_through_disk() {
        let dir = dir("roundtrip");
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
        let dir = dir("future");
        let project = json!({ "version": 99, "somethingNew": { "nested": [1, 2, 3] } });
        save(&dir, &project).expect("save");
        assert_eq!(load(&dir), Some(project));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_project_file_reads_as_nothing() {
        let dir = dir("bad");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(FILE), "{ not json").unwrap();
        assert!(load(&dir).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The atomic write must not leave its temp file sitting next to the project.
    #[test]
    fn a_finished_write_leaves_no_temp_file_behind() {
        let dir = dir("temp");
        save(&dir, &json!({ "version": 1 })).expect("save");
        assert!(dir.join(FILE).exists());
        assert!(!dir.join(format!("{FILE}.writing")).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ------------------------------------------------------------ a named project

    #[test]
    fn a_named_project_round_trips_through_the_path_it_was_given() {
        let dir = dir("named");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("beach.solcut");

        let project = json!({ "version": 1, "clips": [{ "id": "clip_1" }] });
        save_to(&path, &project).expect("save_to");
        assert_eq!(read(&path).unwrap(), project);
        // The temp file is the target's own name, so two projects saving at once in one
        // directory cannot collide on it.
        assert!(!dir.join("beach.solcut.writing").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The difference that keeps an Open from emptying a real file: absent and corrupt are
    /// answers here, not silence.
    #[test]
    fn a_project_that_is_not_there_says_so_rather_than_reading_as_empty() {
        let dir = dir("missing");
        let gone = dir.join("gone.solcut");
        assert!(read(&gone).is_err());

        std::fs::create_dir_all(&dir).unwrap();
        let bad = dir.join("bad.solcut");
        std::fs::write(&bad, "{ not json").unwrap();
        assert!(
            read(&bad).is_err(),
            "a file that is not a project is not an empty project"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A path whose directory has gone — an unplugged drive — must fail, not be rebuilt
    /// underneath the user with a shadow file that disappears when the drive returns.
    #[test]
    fn saving_into_a_directory_that_is_not_there_fails_instead_of_creating_it() {
        let dir = dir("unmounted");
        let path = dir.join("volume").join("beach.solcut");

        assert!(save_to(&path, &json!({ "version": 1 })).is_err());
        assert!(!dir.join("volume").exists(), "no directory was invented");
    }

    // ------------------------------------------------------------ the pointer

    #[test]
    fn the_pointer_follows_the_write_and_can_be_forgotten() {
        let dir = dir("pointer");
        assert_eq!(remembered(&dir), None, "a fresh install is on the scratch");

        remember(&dir, Some("/x/beach.solcut")).expect("remember");
        assert_eq!(remembered(&dir), Some("/x/beach.solcut".to_string()));

        remember(&dir, Some("/x/reel.solcut")).expect("re-point");
        assert_eq!(remembered(&dir), Some("/x/reel.solcut".to_string()));

        // Back to untitled: the pointer goes away rather than being blanked, so a config
        // directory that has only ever held untitled work looks like one.
        remember(&dir, None).expect("forget");
        assert_eq!(remembered(&dir), None);
        assert!(!dir.join(CURRENT).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Autosave calls this every few seconds with the same answer. It must not be a write.
    #[test]
    fn re_remembering_the_same_project_does_not_touch_the_file() {
        let dir = dir("pointer-idempotent");
        remember(&dir, Some("/x/beach.solcut")).expect("remember");
        let first = std::fs::metadata(dir.join(CURRENT))
            .unwrap()
            .modified()
            .unwrap();

        remember(&dir, Some("/x/beach.solcut")).expect("again");
        let second = std::fs::metadata(dir.join(CURRENT))
            .unwrap()
            .modified()
            .unwrap();
        assert_eq!(first, second);

        // And forgetting what is already forgotten is not a write either.
        remember(&dir, None).expect("forget");
        remember(&dir, None).expect("forget again");
        assert_eq!(remembered(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
