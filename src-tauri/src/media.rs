//! Classifying and validating files dropped onto the timeline.

use serde::Serialize;
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

pub fn supported_extensions() -> Vec<&'static str> {
    PHOTO_EXTS
        .iter()
        .chain(VIDEO_EXTS.iter())
        .chain(AUDIO_EXTS.iter())
        .copied()
        .collect()
}

pub fn import(paths: &[String]) -> ImportResult {
    let mut result = ImportResult::default();

    for raw in paths {
        let path = PathBuf::from(raw);
        let name = file_name(&path);

        let Ok(meta) = std::fs::metadata(&path) else {
            result.rejected.push(RejectedMedia {
                path: raw.clone(),
                name,
                reason: "the file could not be read at that path".into(),
            });
            continue;
        };
        if !meta.is_file() {
            result.rejected.push(RejectedMedia {
                path: raw.clone(),
                name,
                reason: "folders cannot be placed on the timeline".into(),
            });
            continue;
        }

        match classify(&path) {
            Some(kind) => result.imported.push(ImportedMedia {
                path: raw.clone(),
                name,
                kind,
                size_bytes: meta.len(),
            }),
            None => result.rejected.push(RejectedMedia {
                path: raw.clone(),
                name,
                reason: format!(
                    "unsupported format. Supported: {}",
                    supported_extensions().join(", ")
                ),
            }),
        }
    }

    result
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
    fn a_partly_bad_drop_still_imports_the_good_files() {
        let dir = std::env::temp_dir().join(format!("solcut-media-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let good = dir.join("photo.jpg");
        std::fs::write(&good, b"not really a jpeg, but it exists").unwrap();
        let bad = dir.join("notes.tiff");
        std::fs::write(&bad, b"x").unwrap();

        let result = import(&[
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
}
