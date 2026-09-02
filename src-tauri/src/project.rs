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

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};

const FILE: &str = "project.json";
const CURRENT: &str = "current.txt";
const RECENTS: &str = "recents.json";

/// How many projects the menu remembers.
///
/// Small on purpose. The list hangs inside a popover that also has to hold the three
/// project actions, and twenty near-identical rows would push `New project…` off the
/// bottom of the window — the one thing on that surface that must always be reachable.
const MAX_RECENTS: usize = 8;

/// The extension a project file carries. Mirrors `PROJECT_EXT` in `src/lib/backend.ts`.
const EXT: &str = "solcut";

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
    let previous = remembered(dir);
    if previous.as_deref().unwrap_or("") == wanted {
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

    // The recents list moves with the pointer, and this early-out is why it can: the one
    // moment a project actually *becomes* the open one, rather than every autosave tick.
    //
    // The project being left is pushed first so the incoming one ends up in front of it —
    // and so an install that predates this list does not lose the project it was in the
    // instant its owner switches away from it. Best-effort in both directions: the project
    // is safely on disk by now, and a menu that is one entry short is not worth failing a
    // save over.
    if let Some(previous) = previous.as_deref() {
        let _ = push_recent(dir, previous);
    }
    let _ = push_recent(dir, wanted);

    std::fs::write(&file, wanted).map_err(|e| e.to_string())
}

/// The projects this install has worked in, most recent first.
///
/// Two things it deliberately does *not* do.
///
/// It does not fail: a missing or corrupt list is an empty one, exactly as [`load`] treats
/// a missing scratch, because there is no version of "the menu could not be listed" worth
/// interrupting someone for.
///
/// And **it never writes the pruning back.** Entries whose file is not there are dropped
/// from what the caller sees, but they stay in the file — a project on an unplugged drive
/// is hidden while the drive is away and comes back with it, where persisting the prune
/// would forget it for good the first time someone opened the menu on a laptop.
pub fn recents(dir: &Path) -> Vec<String> {
    let mut paths = stored_recents(dir);

    // An install from before this list existed has its project in `current.txt` and nowhere
    // else. Without this the feature would ship invisible to exactly the people who already
    // had a project — and their first switch would leave it with no way back but Open….
    if let Some(current) = remembered(dir) {
        if !paths.contains(&current) {
            paths.insert(0, current);
        }
    }

    paths.retain(|p| Path::new(p).exists());
    paths.truncate(MAX_RECENTS);
    paths
}

/// The list as it is on disk — no seeding, no pruning. What [`recents`] and [`push_recent`]
/// both start from.
fn stored_recents(dir: &Path) -> Vec<String> {
    std::fs::read_to_string(dir.join(RECENTS))
        .ok()
        .and_then(|raw| serde_json::from_str::<Recents>(&raw).ok())
        .map(|r| r.paths)
        .unwrap_or_default()
}

/// Move one project to the front of the list.
///
/// Written through [`save_to`] like the project itself: the file is small, but it is
/// rewritten from a full read-modify-write, and a crash mid-write would leave the user with
/// no list rather than a stale one.
fn push_recent(dir: &Path, path: &str) -> Result<(), String> {
    let mut paths = stored_recents(dir);
    paths.retain(|p| p != path);
    paths.insert(0, path.to_string());
    paths.truncate(MAX_RECENTS);

    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let value = serde_json::to_value(Recents { paths }).map_err(|e| e.to_string())?;
    save_to(&dir.join(RECENTS), &value)
}

#[derive(Default, Serialize, Deserialize)]
struct Recents {
    #[serde(default)]
    paths: Vec<String>,
}

/// Where a project called `name` should be created, or why it cannot be.
///
/// All of the path arithmetic lives here rather than in the frontend so separators are
/// `PathBuf`'s problem and not a regex's. `default_dir` is passed in rather than looked up
/// because finding the documents directory needs Tauri, and this module does not have it —
/// which is the whole reason it can be tested without the desktop shell.
///
/// The name is a *file* name and is refused if it tries to be anything else. A separator
/// would let a typed name climb out of the folder the caller chose, and the inline field
/// this feeds has none of the native save panel's protections.
pub fn new_project_path(
    default_dir: &Path,
    name: &str,
    near: Option<&str>,
) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Give the project a name.".to_string());
    }
    if name.contains('/') || name.contains('\\') || name.split('.').all(|part| part.is_empty()) {
        return Err("A project name cannot contain a folder path.".to_string());
    }

    // Forced, exactly as `pickProjectSavePath` forces it on the native panel: a project
    // saved as `beach` is hidden by the very filter Open… opens with, so it becomes a file
    // its owner cannot find again.
    let file = if name.to_ascii_lowercase().ends_with(&format!(".{EXT}")) {
        name.to_string()
    } else {
        format!("{name}.{EXT}")
    };

    // Beside the project the user is in, so a new one lands in the folder they organise the
    // last one in. Only the fallback is created — `save_to`'s rule about never rebuilding a
    // missing parent is about a path the *user* chose, and an unplugged drive must still
    // fail rather than be quietly reinvented on the local disk.
    let dir = match near.map(Path::new).and_then(Path::parent) {
        Some(beside) => beside.to_path_buf(),
        None => {
            std::fs::create_dir_all(default_dir).map_err(|e| e.to_string())?;
            default_dir.to_path_buf()
        }
    };

    let path = dir.join(&file);
    if path.exists() {
        return Err(format!("“{name}” is already in that folder."));
    }
    Ok(path.to_string_lossy().into_owned())
}

/// Write a project to a path that must not already exist.
///
/// The difference from [`save_to`] is `create_new`, and it is the whole point: the name was
/// checked for freedom when it was typed, but the confirm dialog that can follow opens a
/// *native save panel*, so the user has an unbounded window in which to give some other
/// project that exact name. The check and the write have to be the same operation, or a
/// created project can land on top of one saved thirty seconds earlier.
pub fn create(path: &Path, project: &Value) -> Result<(), String> {
    let body = serde_json::to_string_pretty(project).map_err(|e| e.to_string())?;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    file.write_all(body.as_bytes())
        .map_err(|e| format!("{}: {e}", path.display()))
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

    /// A project file that only has to exist — `recents` prunes by existence, so most of
    /// these tests need real files rather than plausible paths.
    fn touch(dir: &Path, name: &str) -> String {
        let path = dir.join(name);
        std::fs::write(&path, "{}").unwrap();
        path.to_string_lossy().into_owned()
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

    // ------------------------------------------------------------ the recents list

    #[test]
    fn a_fresh_install_has_no_recent_projects() {
        assert!(recents(&dir("recents-fresh")).is_empty());
    }

    /// The list is what the menu is made of, so the project just opened has to be first.
    #[test]
    fn the_list_puts_the_newest_project_first_and_never_repeats_one() {
        let dir = dir("recents-order");
        std::fs::create_dir_all(&dir).unwrap();
        let beach = touch(&dir, "beach.solcut");
        let reel = touch(&dir, "reel.solcut");

        remember(&dir, Some(&beach)).expect("beach");
        remember(&dir, Some(&reel)).expect("reel");
        assert_eq!(recents(&dir), vec![reel.clone(), beach.clone()]);

        // Going back to one already in the list moves it, rather than listing it twice.
        remember(&dir, Some(&beach)).expect("beach again");
        assert_eq!(recents(&dir), vec![beach, reel]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The migration. Someone who has been using SolCut has their project in `current.txt`
    /// and in no list at all — and the first switch away from it would be the last time
    /// they saw it, if the pointer were not folded in.
    #[test]
    fn a_project_from_before_the_list_existed_is_still_in_it() {
        let dir = dir("recents-migration");
        std::fs::create_dir_all(&dir).unwrap();
        let beach = touch(&dir, "beach.solcut");
        // Exactly what an older build left behind: a pointer, and no `recents.json`.
        std::fs::write(dir.join(CURRENT), &beach).unwrap();
        assert_eq!(
            recents(&dir),
            vec![beach.clone()],
            "the pointer is seeded in"
        );

        let reel = touch(&dir, "reel.solcut");
        remember(&dir, Some(&reel)).expect("switch away");
        assert_eq!(
            recents(&dir),
            vec![reel, beach],
            "switching away from it did not lose it"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A project whose file has gone is not offered — but it is not forgotten either. The
    /// difference matters for an external drive, which comes back.
    #[test]
    fn a_project_whose_file_is_gone_is_hidden_without_being_erased() {
        let dir = dir("recents-missing");
        std::fs::create_dir_all(&dir).unwrap();
        let beach = touch(&dir, "beach.solcut");
        let reel = touch(&dir, "reel.solcut");
        remember(&dir, Some(&beach)).expect("beach");
        remember(&dir, Some(&reel)).expect("reel");

        std::fs::remove_file(&beach).unwrap();
        assert_eq!(recents(&dir), vec![reel.clone()], "hidden while it is away");

        // The drive comes back. Nothing had to be re-opened for it to be listed again.
        std::fs::write(&beach, "{}").unwrap();
        assert_eq!(recents(&dir), vec![reel, beach]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_list_stops_growing_at_its_cap() {
        let dir = dir("recents-cap");
        std::fs::create_dir_all(&dir).unwrap();
        for n in 0..MAX_RECENTS + 4 {
            let path = touch(&dir, &format!("p{n}.solcut"));
            remember(&dir, Some(&path)).expect("remember");
        }
        let listed = recents(&dir);
        assert_eq!(listed.len(), MAX_RECENTS);
        assert!(
            listed[0].ends_with(&format!("p{}.solcut", MAX_RECENTS + 3)),
            "the newest is still first"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The untitled scratch has no path, so it is not something the menu can offer.
    #[test]
    fn going_back_to_the_untitled_scratch_lists_nothing_new() {
        let dir = dir("recents-scratch");
        std::fs::create_dir_all(&dir).unwrap();
        let beach = touch(&dir, "beach.solcut");
        remember(&dir, Some(&beach)).expect("beach");
        remember(&dir, None).expect("scratch");
        assert_eq!(recents(&dir), vec![beach]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A hand-editable file that is not a list is an empty list, never a panic.
    #[test]
    fn a_corrupt_list_reads_as_no_recent_projects() {
        let dir = dir("recents-bad");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(RECENTS), "{ not json").unwrap();
        assert!(recents(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ------------------------------------------------------------ naming a new project

    #[test]
    fn a_new_project_is_named_beside_the_one_it_was_started_from() {
        let dir = dir("new-beside");
        let films = dir.join("films");
        std::fs::create_dir_all(&films).unwrap();
        let beach = films.join("beach.solcut");
        std::fs::write(&beach, "{}").unwrap();

        let made = new_project_path(&dir, "reel", Some(beach.to_str().unwrap())).expect("path");
        assert_eq!(PathBuf::from(&made), films.join("reel.solcut"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// With nothing open there is nowhere to be beside, so the fallback is used — and it is
    /// the one directory this function is allowed to create.
    #[test]
    fn a_first_project_lands_in_the_default_folder_which_is_created_for_it() {
        let dir = dir("new-default");
        let made = new_project_path(&dir, "reel", None).expect("path");
        assert_eq!(PathBuf::from(&made), dir.join("reel.solcut"));
        assert!(dir.exists(), "the default folder was made ready");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Without this the file is hidden by the very filter Open… opens with — a project its
    /// owner cannot find again.
    #[test]
    fn the_extension_is_forced_but_never_doubled() {
        let dir = dir("new-ext");
        assert!(new_project_path(&dir, "reel", None)
            .unwrap()
            .ends_with("reel.solcut"));
        assert!(new_project_path(&dir, "reel.solcut", None)
            .unwrap()
            .ends_with("reel.solcut"));
        assert!(new_project_path(&dir, "reel.SOLCUT", None)
            .unwrap()
            .ends_with("reel.SOLCUT"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The inline field has none of the native save panel's protections, so a name that
    /// tries to be a path is refused rather than allowed to climb out of the folder.
    #[test]
    fn a_name_that_is_not_a_name_is_refused() {
        let dir = dir("new-refused");
        assert!(new_project_path(&dir, "   ", None).is_err(), "empty");
        assert!(new_project_path(&dir, "../reel", None).is_err(), "a path");
        assert!(
            new_project_path(&dir, "films/reel", None).is_err(),
            "a folder"
        );
        assert!(new_project_path(&dir, "..", None).is_err(), "the parent");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_name_already_in_that_folder_is_refused_rather_than_offered() {
        let dir = dir("new-taken");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("reel.solcut"), "{}").unwrap();
        assert!(new_project_path(&dir, "reel", None).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The name was free when it was typed; the confirm dialog that can follow opens a
    /// native save panel, so it may not be free by the time the project is created. The
    /// check and the write have to be one operation.
    #[test]
    fn creating_over_a_project_that_appeared_in_the_meantime_fails_instead_of_replacing_it() {
        let dir = dir("create-race");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("reel.solcut");

        create(&path, &json!({ "version": 1 })).expect("create");
        assert_eq!(read(&path).unwrap(), json!({ "version": 1 }));

        // Somebody else got there first. The bytes already on disk are theirs.
        assert!(create(&path, &json!({ "version": 1, "clips": [] })).is_err());
        assert_eq!(read(&path).unwrap(), json!({ "version": 1 }));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
