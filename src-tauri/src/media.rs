//! Classifying and validating files dropped onto the timeline.
//!
//! Two ways in, and the difference between them is the whole point of this module:
//!
//! - [`probe`] only ever *looks*. A restored project asks it whether its media is still
//!   where it was, which must stay a question — a probe that downloaded would turn opening
//!   a project into a download of everything iCloud had evicted since.
//! - [`import`] is the one the user asked for, so it is allowed to act: a file that is only
//!   in the cloud is brought down, and a photo in a format nothing here reads is converted.

use serde::Serialize;
use solcut_intake as intake;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const PHOTO_EXTS: &[&str] = &["jpg", "jpeg", "png", "webp", "bmp", "gif", "avif"];
const VIDEO_EXTS: &[&str] = &["mp4", "mov", "webm", "m4v", "mkv", "avi"];
/// Kept in step with `AUDIO_EXTS` in `src/types/project.ts`.
const AUDIO_EXTS: &[&str] = &["mp3", "wav", "ogg", "flac", "aac", "m4a"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    Photo,
    Video,
    Audio,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedMedia {
    pub path: String,
    pub name: String,
    pub kind: MediaKind,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectedMedia {
    pub path: String,
    pub name: String,
    pub reason: String,
}

/// A drop can be partly good; both halves come back so the UI can import what it can and
/// explain the rest.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub imported: Vec<ImportedMedia>,
    pub rejected: Vec<RejectedMedia>,
}

impl ImportResult {
    /// One path's outcome, filed on whichever side it landed.
    fn push(&mut self, outcome: Result<ImportedMedia, RejectedMedia>) {
        match outcome {
            Ok(media) => self.imported.push(media),
            Err(rejected) => self.rejected.push(rejected),
        }
    }
}

pub fn classify(path: &Path) -> Option<MediaKind> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    if PHOTO_EXTS.contains(&ext.as_str()) {
        Some(MediaKind::Photo)
    } else if VIDEO_EXTS.contains(&ext.as_str()) {
        Some(MediaKind::Video)
    } else if AUDIO_EXTS.contains(&ext.as_str()) {
        Some(MediaKind::Audio)
    } else {
        None
    }
}

pub fn file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("untitled")
        .to_string()
}

/// Everything the file picker should offer, which is deliberately more than [`classify`]
/// accepts: HEIC is on this list because the user must be able to *choose* one, and off
/// `classify`'s because it becomes openable only after [`import`] has converted it.
pub fn supported_extensions() -> Vec<&'static str> {
    PHOTO_EXTS
        .iter()
        .chain(intake::CONVERTIBLE_PHOTO_EXTS.iter())
        .chain(VIDEO_EXTS.iter())
        .chain(AUDIO_EXTS.iter())
        .copied()
        .collect()
}

/// What is at these paths, right now, touching nothing.
pub fn probe(paths: &[String]) -> ImportResult {
    let mut result = ImportResult::default();
    for raw in paths {
        result.push(inspect(raw, &PathBuf::from(raw)));
    }
    result
}

/// The import the user asked for: bring down what is only in iCloud, convert what cannot be
/// read as it stands, and classify the rest.
///
/// The downloads run together rather than one after another. A per-file budget is only
/// fair if the files are waiting at the same time — otherwise one slow 4K video is the
/// reason the four small photos behind it are called failures.
pub async fn import(paths: &[String], converted_dir: &Path) -> ImportResult {
    let mut waiting = tokio::task::JoinSet::new();
    for (i, raw) in paths.iter().enumerate() {
        let path = intake::real_path(Path::new(raw));
        if intake::presence(&path) == intake::Presence::InCloud {
            waiting.spawn(
                async move { (i, intake::bring_down(&path, intake::DOWNLOAD_BUDGET).await) },
            );
        }
    }
    let mut never_came: HashMap<usize, intake::IntakeError> = HashMap::new();
    while let Some(joined) = waiting.join_next().await {
        if let Ok((i, Err(error))) = joined {
            never_came.insert(i, error);
        }
    }

    let mut result = ImportResult::default();
    for (i, raw) in paths.iter().enumerate() {
        // A placeholder handed to us directly — dragged from a terminal, or picked in a
        // panel showing hidden files — names the file it stands for, not itself.
        let path = intake::real_path(Path::new(raw));

        if let Some(error) = never_came.get(&i) {
            result.rejected.push(RejectedMedia {
                path: raw.clone(),
                name: file_name(&path),
                reason: cloud_reason(error),
            });
            continue;
        }

        if intake::needs_conversion(&path) {
            result.push(converted(&path, converted_dir).await);
            continue;
        }

        result.push(inspect(&path.display().to_string(), &path));
    }

    result
}

/// One path, looked at and not touched.
fn inspect(raw: &str, path: &Path) -> Result<ImportedMedia, RejectedMedia> {
    let name = file_name(path);
    let reject = |reason: String| RejectedMedia {
        path: raw.to_string(),
        name: name.clone(),
        reason,
    };

    let Ok(meta) = std::fs::metadata(path) else {
        return Err(reject("the file could not be read at that path".into()));
    };
    if !meta.is_file() {
        return Err(reject("folders cannot be placed on the timeline".into()));
    }
    match classify(path) {
        Some(kind) => Ok(ImportedMedia {
            path: raw.to_string(),
            name,
            kind,
            size_bytes: meta.len(),
        }),
        None => Err(reject(format!(
            "unsupported format. Supported: {}",
            supported_extensions().join(", ")
        ))),
    }
}

/// A photo the editor cannot read, converted into one it can.
///
/// It keeps the name it was picked under, with the extension it now actually has: the user
/// chose `IMG_0001.heic` and the bin says `IMG_0001.jpg`, which is both recognisable and
/// true.
async fn converted(path: &Path, dir: &Path) -> Result<ImportedMedia, RejectedMedia> {
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("photo");
    let name = format!("{stem}.jpg");
    let reject = |reason: String| RejectedMedia {
        path: path.display().to_string(),
        name: name.clone(),
        reason,
    };

    let jpeg =
        match intake::convert_photo(path, dir).await {
            Ok(jpeg) => jpeg,
            Err(intake::IntakeError::NoConverter) => return Err(reject(
                "converting a HEIC photo needs macOS's own `sips`, which is not on this machine"
                    .into(),
            )),
            Err(error) => return Err(reject(error.to_string())),
        };
    let Ok(meta) = std::fs::metadata(&jpeg) else {
        return Err(reject("the converted photo could not be read".into()));
    };
    Ok(ImportedMedia {
        path: jpeg.display().to_string(),
        name,
        kind: MediaKind::Photo,
        size_bytes: meta.len(),
    })
}

/// Why a file that iCloud was holding never arrived, said to someone who only wanted to add
/// a photo.
fn cloud_reason(error: &intake::IntakeError) -> String {
    match error {
        intake::IntakeError::StillDownloading => {
            "still downloading from iCloud — import it again once it has finished coming down"
                .into()
        }
        intake::IntakeError::Vanished => "the file is no longer in iCloud".into(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_photos_videos_and_audio_case_insensitively() {
        assert_eq!(classify(Path::new("/a/b.JPG")), Some(MediaKind::Photo));
        assert_eq!(classify(Path::new("/a/b.webp")), Some(MediaKind::Photo));
        assert_eq!(classify(Path::new("/a/b.MP4")), Some(MediaKind::Video));
        assert_eq!(classify(Path::new("/a/b.mov")), Some(MediaKind::Video));
        assert_eq!(classify(Path::new("/a/b.MP3")), Some(MediaKind::Audio));
        assert_eq!(classify(Path::new("/a/b.wav")), Some(MediaKind::Audio));
        assert_eq!(classify(Path::new("/a/b.flac")), Some(MediaKind::Audio));
        assert_eq!(classify(Path::new("/a/b.tiff")), None);
        assert_eq!(classify(Path::new("/a/noext")), None);
    }

    #[test]
    fn the_picker_filter_offers_audio_too() {
        let exts = supported_extensions();
        for ext in ["mp3", "wav", "ogg", "flac", "aac", "m4a"] {
            assert!(exts.contains(&ext), "{ext} missing from {exts:?}");
        }
    }

    #[test]
    fn the_picker_offers_heic_even_though_nothing_can_open_one_yet() {
        // A photo you cannot select is a photo you cannot import, so the panel has to show
        // it; `classify` is the half that still says no, until `import` has converted it.
        assert!(supported_extensions().contains(&"heic"));
        assert_eq!(classify(Path::new("/a/b.heic")), None);
    }

    #[test]
    fn a_partly_bad_drop_still_imports_the_good_files() {
        let dir = std::env::temp_dir().join(format!("solcut-media-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let good = dir.join("photo.jpg");
        std::fs::write(&good, b"not really a jpeg, but it exists").unwrap();
        let bad = dir.join("notes.tiff");
        std::fs::write(&bad, b"x").unwrap();

        let result = probe(&[
            good.display().to_string(),
            bad.display().to_string(),
            dir.join("ghost.png").display().to_string(),
            dir.display().to_string(),
        ]);

        assert_eq!(result.imported.len(), 1);
        assert_eq!(result.imported[0].name, "photo.jpg");
        assert_eq!(result.imported[0].kind, MediaKind::Photo);
        assert!(result.imported[0].size_bytes > 0);

        assert_eq!(result.rejected.len(), 3);
        assert!(result.rejected[0].reason.contains("unsupported"));
        assert!(result.rejected[1].reason.contains("could not be read"));
        assert!(
            result.rejected[2].reason.contains("Folders")
                || result.rejected[2].reason.contains("folders")
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn names_fall_back_rather_than_panicking() {
        assert_eq!(file_name(Path::new("/")), "untitled");
    }

    /// A directory of this test's own, so tests that create and delete placeholders can run
    /// beside each other.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("solcut-media-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_probe_never_reaches_for_a_file_icloud_is_holding() {
        // The contract `probeRestoredMedia` depends on: opening a project asks where its
        // media is, and must not start downloading everything iCloud has evicted since.
        let dir = scratch("probe-cloud");
        let evicted = dir.join("holiday.jpg");
        std::fs::write(solcut_intake::placeholder_of(&evicted), b"plist").unwrap();

        let result = probe(&[evicted.display().to_string()]);

        assert!(result.imported.is_empty());
        assert_eq!(result.rejected.len(), 1);
        assert!(result.rejected[0].reason.contains("could not be read"));
        assert!(evicted.metadata().is_err(), "nothing was brought down");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn an_import_takes_a_placeholder_to_mean_the_file_it_stands_for() {
        let dir = scratch("import-placeholder");
        let photo = dir.join("holiday.jpg");
        std::fs::write(&photo, b"bytes").unwrap();
        let stub = solcut_intake::placeholder_of(&photo);
        std::fs::write(&stub, b"plist").unwrap();

        // The stub itself is what gets handed in; the real photo is what comes back.
        let result = import(&[stub.display().to_string()], &dir).await;

        assert_eq!(result.rejected.len(), 0, "{:?}", result.rejected);
        assert_eq!(result.imported.len(), 1);
        assert_eq!(result.imported[0].name, "holiday.jpg");
        assert_eq!(result.imported[0].kind, MediaKind::Photo);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn an_import_of_a_file_that_is_simply_gone_does_not_wait_for_it() {
        let dir = scratch("import-gone");
        let missing = dir.join("nothing.jpg");

        // No placeholder beside it, so there is nothing to come: this has to return at once
        // rather than spend the download budget.
        let result = import(&[missing.display().to_string()], &dir).await;

        assert_eq!(result.imported.len(), 0);
        assert_eq!(result.rejected.len(), 1);
        assert!(result.rejected[0].reason.contains("could not be read"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    #[cfg(not(target_os = "macos"))]
    async fn a_heic_that_cannot_be_converted_says_why_in_words() {
        let dir = scratch("import-heic");
        let photo = dir.join("IMG_0001.heic");
        std::fs::write(&photo, b"not really heic").unwrap();

        let result = import(&[photo.display().to_string()], &dir).await;

        assert_eq!(result.imported.len(), 0);
        assert_eq!(result.rejected.len(), 1);
        // Named as the photo it will be, and told what is missing rather than handed the
        // extension list it is already on.
        assert_eq!(result.rejected[0].name, "IMG_0001.jpg");
        assert!(result.rejected[0].reason.contains("sips"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
