//! Runs the real ffmpeg binary end to end: build a photo and a video, export a timeline
//! that mixes them, and probe the resulting MP4. Skipped (not failed) where ffmpeg is
//! absent, so the suite still runs on a bare machine.

use solcut_render::{ExportClip, ExportSpec, Keyframe, Renderer, Source};
use std::path::{Path, PathBuf};
use std::process::Command;

fn ffmpeg_present() -> bool {
    Command::new("ffmpeg")
        .arg("-version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn workdir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("solcut-render-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("workdir");
    dir
}

fn make_photo(dir: &Path) -> PathBuf {
    let out = dir.join("photo.jpg");
    let status = Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=1280x720:duration=1:rate=1",
            "-frames:v",
            "1",
        ])
        .arg(&out)
        .status()
        .expect("make photo");
    assert!(status.success());
    out
}

fn make_video(dir: &Path) -> PathBuf {
    let out = dir.join("clip.mp4");
    let status = Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "smptebars=size=640x480:duration=3:rate=25",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=3",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-shortest",
        ])
        .arg(&out)
        .status()
        .expect("make video");
    assert!(status.success());
    out
}

fn probe(path: &Path, entries: &str) -> String {
    let out = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            entries,
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(path)
        .output()
        .expect("ffprobe");
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn probe_format(path: &Path, entries: &str) -> String {
    let out = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            entries,
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(path)
        .output()
        .expect("ffprobe");
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

#[tokio::test]
async fn exports_a_keyframed_photo_and_a_video_into_one_mp4() {
    if !ffmpeg_present() {
        eprintln!("skipping: ffmpeg is not installed");
        return;
    }

    let dir = workdir("mixed");
    let photo = make_photo(&dir);
    let video = make_video(&dir);
    let out = dir.join("timeline.mp4");

    let spec = ExportSpec {
        width: 640,
        height: 360,
        fps: 25,
        clips: vec![
            ExportClip {
                name: "photo.jpg".into(),
                duration_ms: 2000,
                source: Source::Photo {
                    path: photo,
                    // A Ken Burns push with a pan and a slight rotation, so every
                    // expression path in the filter builder is exercised.
                    keyframes: vec![
                        Keyframe {
                            time_ms: 0,
                            scale: 1.0,
                            x: 0.0,
                            y: 0.0,
                            rotation_deg: 0.0,
                            opacity: 1.0,
                        },
                        Keyframe {
                            time_ms: 2000,
                            scale: 1.6,
                            x: 8.0,
                            y: -5.0,
                            rotation_deg: 3.0,
                            opacity: 1.0,
                        },
                    ],
                },
            },
            ExportClip {
                name: "clip.mp4".into(),
                duration_ms: 2000,
                source: Source::Video {
                    path: video,
                    trim_start_ms: 500,
                },
            },
        ],
    };

    let mut stages = Vec::new();
    let result = Renderer::default()
        .export(&spec, &dir.join("work"), &out, |p| {
            stages.push((p.stage.clone(), p.fraction()))
        })
        .await;

    let produced = result.expect("export should succeed");
    assert!(produced.exists(), "an mp4 was written");
    assert!(
        std::fs::metadata(&produced).unwrap().len() > 1_000,
        "and it is not empty"
    );

    assert_eq!(probe(&produced, "stream=width,height"), "640\n360");
    assert_eq!(probe(&produced, "stream=codec_name"), "h264");
    assert_eq!(
        probe_format(&produced, "format=format_name"),
        "mov,mp4,m4a,3gp,3g2,mj2"
    );

    let duration: f32 = probe_format(&produced, "format=duration")
        .parse()
        .unwrap_or(0.0);
    assert!(
        (duration - 4.0).abs() < 0.35,
        "two 2s clips should make a ~4s file, got {duration}s"
    );

    // The audio bed makes photo and video parts concat-compatible.
    let audio = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "a",
            "-show_entries",
            "stream=codec_name",
            "-of",
            "csv=p=0",
        ])
        .arg(&produced)
        .output()
        .expect("ffprobe audio");
    assert!(
        String::from_utf8_lossy(&audio.stdout).contains("aac"),
        "the export carries a single aac track"
    );

    assert!(
        stages.first().unwrap().0.contains("photo.jpg"),
        "progress names each clip"
    );
    assert!(
        stages.iter().any(|(s, _)| s.contains("Joining")),
        "and the join stage"
    );
    assert_eq!(stages.last().unwrap().1, 1.0, "and finishes at 100%");

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn exports_a_photo_with_no_keyframes_at_all() {
    if !ffmpeg_present() {
        eprintln!("skipping: ffmpeg is not installed");
        return;
    }

    let dir = workdir("still");
    let photo = make_photo(&dir);
    let out = dir.join("still.mp4");

    let spec = ExportSpec {
        width: 480,
        height: 270,
        fps: 24,
        clips: vec![ExportClip {
            name: "photo.jpg".into(),
            duration_ms: 1000,
            source: Source::Photo {
                path: photo,
                keyframes: vec![],
            },
        }],
    };

    Renderer::default()
        .export(&spec, &dir.join("work"), &out, |_| {})
        .await
        .expect("a still photo still exports");

    assert_eq!(probe(&out, "stream=width,height"), "480\n270");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_missing_source_file_is_named_in_the_error() {
    if !ffmpeg_present() {
        eprintln!("skipping: ffmpeg is not installed");
        return;
    }

    let dir = workdir("missing");
    let spec = ExportSpec {
        clips: vec![ExportClip {
            name: "gone.jpg".into(),
            duration_ms: 1000,
            source: Source::Photo {
                path: dir.join("nope.jpg"),
                keyframes: vec![],
            },
        }],
        ..ExportSpec::default()
    };

    let err = Renderer::default()
        .export(&spec, &dir.join("work"), &dir.join("out.mp4"), |_| {})
        .await
        .unwrap_err();

    assert!(err.to_string().contains("gone.jpg"), "{err}");
    assert!(
        !dir.join("out.mp4").exists(),
        "nothing half-written is left behind"
    );
    let _ = std::fs::remove_dir_all(&dir);
}
