//! The machine-specific edges of an import.
//!
//! Two things can stand between a file the user pointed at and one the editor can open,
//! and macOS already ships the binary that answers each:
//!
//! - **It may not be here yet.** iCloud evicts a file it thinks you are done with and
//!   leaves a hidden placeholder where it used to be, so the path in the open panel names
//!   a file that does not exist on disk. `brctl` is what asks for the bytes back.
//! - **It may be in a format nothing here reads.** A photo shot on an iPhone is HEIC,
//!   which neither the webview nor an ordinary ffmpeg build decodes. `sips` converts it.
//!
//! Neither is a Tauri concern, and deliberately so: everything below is a plain filesystem
//! question or a subprocess, so all of it is exercised by tests on any machine — including
//! the ones that cannot build the desktop shell at all.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

/// How long one file may take to come down out of iCloud before it is given back to the
/// user as a problem rather than waited on any longer.
///
/// Per file, not per import: the files come down at the same time, so one slow 4K video
/// must not be the reason the four small photos behind it are called failures.
pub const DOWNLOAD_BUDGET: Duration = Duration::from_secs(120);

/// How often the download is looked in on. Short enough that a small photo does not sit
/// finished-but-unnoticed, long enough that two minutes of waiting is not two minutes of
/// spinning.
const POLL_INTERVAL: Duration = Duration::from_millis(250);

/// The extension iCloud gives the placeholder it leaves behind.
const PLACEHOLDER_EXT: &str = "icloud";

/// The photo formats that are readable only after conversion. Kept apart from the editor's
/// own `PHOTO_EXTS` on purpose: these are files the picker must *offer* and the importer
/// must *convert*, which is a different thing from a format the app can open.
pub const CONVERTIBLE_PHOTO_EXTS: &[&str] = &["heic", "heif"];

/// One cloud library this machine actually has.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudLibrary {
    /// Stable across runs; the frontend keys on it, never on the label.
    pub id: String,
    /// What the menu says.
    pub label: String,
    /// Where the file panel opens.
    pub path: String,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum IntakeError {
    #[error("still downloading from iCloud")]
    StillDownloading,
    #[error("the file is no longer in iCloud")]
    Vanished,
    #[error("this Mac has no `sips` to convert it with")]
    NoConverter,
    #[error("{0}")]
    Failed(String),
}

/// Whether the bytes are here, still in the cloud, or gone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Presence {
    /// The file is on disk and can be opened now.
    Here,
    /// Only iCloud's placeholder is there. The bytes can be asked for.
    InCloud,
    /// Neither the file nor a placeholder — nothing to wait for.
    Gone,
}

/// Every cloud library present under `home`.
///
/// The home directory is a parameter rather than something this function goes and finds,
/// which is what makes it answerable in a test: point it at a scratch directory and the
/// answer is about that directory.
///
/// Only iCloud Drive, deliberately. Desktop and Documents, when they are synced, *are*
/// folders inside it, so they need no entries of their own — and the third-party sync
/// clients are a decision this build has not taken.
///
/// This is a `stat` and never a `read_dir`: enumerating a protected location is what
/// raises a permission dialog, and asking whether a folder exists is not something the
/// user should be interrupted about at launch.
pub fn libraries(home: &Path) -> Vec<CloudLibrary> {
    let icloud = home.join("Library/Mobile Documents/com~apple~CloudDocs");
    if !icloud.is_dir() {
        return Vec::new();
    }
    vec![CloudLibrary {
        id: "icloud-drive".into(),
        label: "iCloud Drive".into(),
        path: icloud.display().to_string(),
    }]
}

/// Where iCloud keeps the placeholder for `path`: `/d/a.jpg` → `/d/.a.jpg.icloud`.
///
/// A name that already begins with a dot simply gets another one — `.hidden.jpg` becomes
/// `..hidden.jpg.icloud` — which is what the filesystem actually holds, however odd it
/// reads.
pub fn placeholder_of(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    path.with_file_name(format!(".{name}.{PLACEHOLDER_EXT}"))
}

/// The file a placeholder stands for: `/d/.a.jpg.icloud` → `/d/a.jpg`.
///
/// Anything that is not a placeholder comes back unchanged, so this is safe to run over
/// every path on the way in. It matters because a placeholder *can* be handed to us —
/// dragged in from a terminal, or picked in a panel showing hidden files — and importing
/// it as-is would put a 200-byte plist on the timeline and call it unsupported.
pub fn real_path(path: &Path) -> PathBuf {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return path.to_path_buf();
    };
    let Some(inner) = name.strip_suffix(&format!(".{PLACEHOLDER_EXT}")) else {
        return path.to_path_buf();
    };
    match inner.strip_prefix('.') {
        Some(real) if !real.is_empty() => path.with_file_name(real),
        _ => path.to_path_buf(),
    }
}

/// Whether the bytes for `path` are here, coming, or gone.
pub fn presence(path: &Path) -> Presence {
    if path.is_file() {
        Presence::Here
    } else if placeholder_of(path).is_file() {
        Presence::InCloud
    } else {
        Presence::Gone
    }
}

/// Ask iCloud for the bytes and wait for them.
///
/// The nudge is best-effort — selecting a cloud file in the open panel usually starts the
/// download on its own, and `brctl` is an undocumented binary that may not always be
/// there — so a nudge that fails to spawn is not an error. What decides the outcome is the
/// file: **existence is the completion signal**, because the placeholder is swapped for the
/// real file in one step. Watching the size grow instead would be unable to tell a stalled
/// download from a finished one, and would hand the editor a truncated video.
pub async fn bring_down(path: &Path, budget: Duration) -> Result<(), IntakeError> {
    if path.is_file() {
        return Ok(());
    }
    nudge(path).await;

    let deadline = tokio::time::Instant::now() + budget;
    loop {
        if path.is_file() {
            return Ok(());
        }
        // The placeholder going without the file arriving means the file was deleted or
        // moved while we waited. There is nothing left to come, so saying so now beats
        // spending the rest of the budget on it.
        if !placeholder_of(path).is_file() {
            return Err(IntakeError::Vanished);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(IntakeError::StillDownloading);
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// `brctl download <path>` — argv, never a shell, so a filename with a space or a quote in
/// it is a filename and not a second command. Every failure is swallowed: this only asks,
/// and [`bring_down`] is what decides whether the asking worked.
async fn nudge(path: &Path) {
    let _ = tokio::process::Command::new("brctl")
        .arg("download")
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .status()
        .await;
}

/// Whether this is a photo the editor can only read once it has been converted.
pub fn needs_conversion(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| CONVERTIBLE_PHOTO_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Where the JPEG for `source` lives inside `dir`.
///
/// The source path is folded into the name rather than only its stem, because two phones'
/// worth of `IMG_0001.heic` in two folders are two different photos and must not land on
/// each other. Deterministic, so re-importing the same file finds the conversion already
/// there instead of making a second one.
pub fn converted_path(source: &Path, dir: &Path) -> PathBuf {
    let stem = source
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("photo");
    dir.join(format!("{stem}-{:08x}.jpg", fingerprint(source)))
}

/// FNV-1a over the whole source path. Hand-rolled rather than `DefaultHasher` for one
/// reason: this number ends up in a filename that a saved project points at, so it has to
/// mean the same thing next release as it did last one.
fn fingerprint(path: &Path) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for byte in path.display().to_string().as_bytes() {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

/// Convert a photo the editor cannot read into a JPEG beside the rest of its derived media.
///
/// `sips` rather than ffmpeg: it is part of macOS, so there is nothing to install and no
/// codec to have been compiled in, and HEIC support in a stock ffmpeg build is exactly the
/// thing that cannot be relied on. A conversion that is already on disk is reused.
pub async fn convert_photo(source: &Path, dir: &Path) -> Result<PathBuf, IntakeError> {
    let out = converted_path(source, dir);
    if out.is_file() {
        return Ok(out);
    }
    std::fs::create_dir_all(dir).map_err(|e| IntakeError::Failed(e.to_string()))?;

    let result = tokio::process::Command::new("sips")
        .arg("-s")
        .arg("format")
        .arg("jpeg")
        .arg(source)
        .arg("--out")
        .arg(&out)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .output()
        .await;

    match result {
        Ok(output) if output.status.success() && out.is_file() => Ok(out),
        Ok(output) => {
            // A `sips` that ran and refused says why on stderr; its last line is the part
            // worth repeating to someone who only wanted to add a photo.
            let stderr = String::from_utf8_lossy(&output.stderr);
            let reason = stderr
                .lines()
                .rev()
                .find(|l| !l.trim().is_empty())
                .unwrap_or("it could not be converted")
                .trim()
                .to_string();
            Err(IntakeError::Failed(reason))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(IntakeError::NoConverter),
        Err(e) => Err(IntakeError::Failed(e.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A directory of this test's own. Named after the test rather than shared, because
    /// these run in parallel and a placeholder one test deletes is one another is waiting
    /// for.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("solcut-intake-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn icloud_drive_is_found_under_a_home_that_has_one() {
        let home = scratch("libraries");
        assert_eq!(libraries(&home), Vec::new(), "nothing to offer without one");

        let icloud = home.join("Library/Mobile Documents/com~apple~CloudDocs");
        std::fs::create_dir_all(&icloud).unwrap();

        let found = libraries(&home);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "icloud-drive");
        assert_eq!(found[0].label, "iCloud Drive");
        assert_eq!(found[0].path, icloud.display().to_string());

        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_file_where_icloud_drive_should_be_is_not_a_library() {
        let home = scratch("libraries-file");
        let icloud = home.join("Library/Mobile Documents/com~apple~CloudDocs");
        std::fs::create_dir_all(icloud.parent().unwrap()).unwrap();
        std::fs::write(&icloud, b"not a folder").unwrap();

        assert_eq!(libraries(&home), Vec::new());

        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_placeholder_is_the_name_with_a_dot_in_front_and_icloud_behind() {
        assert_eq!(
            placeholder_of(Path::new("/d/a.jpg")),
            PathBuf::from("/d/.a.jpg.icloud")
        );
        // A hidden file gets a second dot. Odd to read, and exactly what is on disk.
        assert_eq!(
            placeholder_of(Path::new("/d/.hidden.jpg")),
            PathBuf::from("/d/..hidden.jpg.icloud")
        );
    }

    #[test]
    fn a_placeholder_resolves_back_to_the_file_it_stands_for() {
        assert_eq!(
            real_path(Path::new("/d/.a.jpg.icloud")),
            PathBuf::from("/d/a.jpg")
        );
        assert_eq!(
            real_path(Path::new("/d/..hidden.jpg.icloud")),
            PathBuf::from("/d/.hidden.jpg")
        );
        // Anything that is not a placeholder is left exactly as it came in.
        assert_eq!(real_path(Path::new("/d/a.jpg")), PathBuf::from("/d/a.jpg"));
        assert_eq!(
            real_path(Path::new("/d/a.icloud")),
            PathBuf::from("/d/a.icloud"),
            "no leading dot, so this is a file that happens to be named .icloud"
        );
        assert_eq!(real_path(Path::new("/")), PathBuf::from("/"));
    }

    #[test]
    fn presence_tells_here_from_in_the_cloud_from_gone() {
        let dir = scratch("presence");
        let here = dir.join("here.jpg");
        std::fs::write(&here, b"bytes").unwrap();
        assert_eq!(presence(&here), Presence::Here);

        let evicted = dir.join("evicted.jpg");
        std::fs::write(placeholder_of(&evicted), b"plist").unwrap();
        assert_eq!(presence(&evicted), Presence::InCloud);

        assert_eq!(presence(&dir.join("never.jpg")), Presence::Gone);
        // A folder is not a file, and must not read as one that is here.
        assert_eq!(presence(&dir), Presence::Gone);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_file_already_on_disk_is_not_waited_for() {
        let dir = scratch("bring-down-here");
        let path = dir.join("a.jpg");
        std::fs::write(&path, b"bytes").unwrap();

        // A budget of nothing: if this waited even one interval it would fail.
        assert_eq!(bring_down(&path, Duration::ZERO).await, Ok(()));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_file_that_lands_while_we_wait_is_imported() {
        let dir = scratch("bring-down-late");
        let path = dir.join("late.jpg");
        std::fs::write(placeholder_of(&path), b"plist").unwrap();

        let arriving = path.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(60)).await;
            std::fs::write(&arriving, b"bytes").unwrap();
            let _ = std::fs::remove_file(placeholder_of(&arriving));
        });

        assert_eq!(bring_down(&path, Duration::from_secs(5)).await, Ok(()));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_file_that_never_lands_gives_the_budget_back() {
        let dir = scratch("bring-down-never");
        let path = dir.join("never.jpg");
        std::fs::write(placeholder_of(&path), b"plist").unwrap();

        assert_eq!(
            bring_down(&path, Duration::from_millis(300)).await,
            Err(IntakeError::StillDownloading)
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_placeholder_that_disappears_stops_the_wait() {
        let dir = scratch("bring-down-vanish");
        let path = dir.join("gone.jpg");
        let stub = placeholder_of(&path);
        std::fs::write(&stub, b"plist").unwrap();

        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(60)).await;
            let _ = std::fs::remove_file(&stub);
        });

        // The budget is long; what ends this is the placeholder going, not the clock.
        assert_eq!(
            bring_down(&path, Duration::from_secs(30)).await,
            Err(IntakeError::Vanished)
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn heic_and_heif_are_the_photos_that_need_converting() {
        assert!(needs_conversion(Path::new("/d/IMG_0001.heic")));
        assert!(needs_conversion(Path::new("/d/IMG_0001.HEIC")));
        assert!(needs_conversion(Path::new("/d/a.heif")));
        assert!(!needs_conversion(Path::new("/d/a.jpg")));
        assert!(!needs_conversion(Path::new("/d/a.mp4")));
        assert!(!needs_conversion(Path::new("/d/noext")));
    }

    #[test]
    fn two_photos_of_the_same_name_convert_to_two_files() {
        let dir = Path::new("/data/imported");
        let one = converted_path(Path::new("/phone/IMG_0001.heic"), dir);
        let two = converted_path(Path::new("/camera/IMG_0001.heic"), dir);

        assert_ne!(one, two, "same stem, different photo");
        assert!(one.starts_with(dir));
        assert!(one
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("IMG_0001-"));
        assert_eq!(one.extension().unwrap(), "jpg");
        // Deterministic, so a second import of the same photo finds the first conversion.
        assert_eq!(one, converted_path(Path::new("/phone/IMG_0001.heic"), dir));
    }

    #[tokio::test]
    async fn a_conversion_already_on_disk_is_reused() {
        let dir = scratch("convert-reuse");
        let source = dir.join("IMG_0001.heic");
        std::fs::write(&source, b"not really heic").unwrap();
        let out = converted_path(&source, &dir);
        std::fs::write(&out, b"already converted").unwrap();

        // No `sips` on this machine — reaching it at all would be the failure.
        assert_eq!(convert_photo(&source, &dir).await, Ok(out.clone()));
        assert_eq!(std::fs::read(&out).unwrap(), b"already converted");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    #[cfg(not(target_os = "macos"))]
    async fn without_sips_a_conversion_says_so_rather_than_failing_vaguely() {
        let dir = scratch("convert-nosips");
        let source = dir.join("IMG_0002.heic");
        std::fs::write(&source, b"not really heic").unwrap();

        assert_eq!(
            convert_photo(&source, &dir).await,
            Err(IntakeError::NoConverter)
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
