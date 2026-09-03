//! Runs the real ffmpeg binary end to end: build a photo and a video, export a timeline
//! that mixes them, and probe the resulting MP4. Skipped (not failed) where ffmpeg is
//! absent, so the suite still runs on a bare machine.

use solcut_render::{
    AudioTrack, ExportClip, ExportSpec, Renderer, Source, STILL_HEIGHT, STILL_WIDTH,
};
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
async fn exports_a_photo_and_a_video_into_one_mp4() {
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
                start_ms: 0,
                duration_ms: 2000,
                transform: None,
                source: Source::Photo { path: photo },
            },
            ExportClip {
                name: "clip.mp4".into(),
                start_ms: 2000,
                duration_ms: 2000,
                transform: None,
                source: Source::Video {
                    path: video,
                    trim_start_ms: 500,
                },
            },
        ],
        audio: vec![],
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
async fn exports_a_lone_still_photo() {
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
            start_ms: 0,
            duration_ms: 1000,
            transform: None,
            source: Source::Photo { path: photo },
        }],
        audio: vec![],
    };

    Renderer::default()
        .export(&spec, &dir.join("work"), &out, |_| {})
        .await
        .expect("a still photo still exports");

    assert_eq!(probe(&out, "stream=width,height"), "480\n270");
    let _ = std::fs::remove_dir_all(&dir);
}

fn make_audio(dir: &Path) -> PathBuf {
    let out = dir.join("theme.wav");
    let status = Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=880:duration=3",
        ])
        .arg(&out)
        .status()
        .expect("make audio");
    assert!(status.success());
    out
}

#[tokio::test]
async fn mixes_an_audio_lane_into_the_export_without_stretching_the_film() {
    if !ffmpeg_present() {
        eprintln!("skipping: ffmpeg is not installed");
        return;
    }

    let dir = workdir("audio");
    let photo = make_photo(&dir);
    let audio = make_audio(&dir);
    let out = dir.join("scored.mp4");

    let spec = ExportSpec {
        width: 480,
        height: 270,
        fps: 24,
        clips: vec![ExportClip {
            name: "photo.jpg".into(),
            start_ms: 0,
            duration_ms: 2000,
            transform: None,
            source: Source::Photo { path: photo },
        }],
        // Starts halfway in, trimmed a little, and would outlast the 2s film if not cut.
        audio: vec![AudioTrack {
            path: audio,
            start_ms: 1000,
            trim_start_ms: 250,
            duration_ms: 2500,
            volume: 0.8,
        }],
    };

    let mut stages = Vec::new();
    Renderer::default()
        .export(&spec, &dir.join("work"), &out, |p| {
            stages.push(p.stage.clone())
        })
        .await
        .expect("the scored export succeeds");

    assert_eq!(probe(&out, "stream=codec_name"), "h264");
    let duration: f32 = probe_format(&out, "format=duration").parse().unwrap_or(0.0);
    assert!(
        (duration - 2.0).abs() < 0.35,
        "the music is cut at the film's end, got {duration}s"
    );
    assert!(
        stages.iter().any(|s| s.contains("Mixing audio")),
        "the mix pass reports itself: {stages:?}"
    );

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
            start_ms: 0,
            duration_ms: 1000,
            transform: None,
            source: Source::Photo {
                path: dir.join("nope.jpg"),
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

/// One AI transition, as Higgsfield hands it back: silent, its own size, its own frame rate.
fn make_transition(dir: &Path, name: &str, pattern: &str) -> PathBuf {
    let out = dir.join(name);
    let status = Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            pattern,
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
        ])
        .arg(&out)
        .status()
        .expect("make transition");
    assert!(status.success());
    out
}

#[tokio::test]
async fn a_gap_between_two_clips_becomes_black_film_of_its_own() {
    if !ffmpeg_present() {
        eprintln!("skipping: ffmpeg is not installed");
        return;
    }

    let dir = workdir("gap");
    let photo = make_photo(&dir);
    let out = dir.join("gapped.mp4");

    // 1s photo, a 1s hole, then the same photo again: a 3s film, not a 2s one.
    let spec = ExportSpec {
        width: 480,
        height: 270,
        fps: 24,
        clips: vec![
            ExportClip {
                name: "first.jpg".into(),
                start_ms: 0,
                duration_ms: 1000,
                transform: None,
                source: Source::Photo {
                    path: photo.clone(),
                },
            },
            ExportClip {
                name: "second.jpg".into(),
                start_ms: 2000,
                duration_ms: 1000,
                transform: None,
                source: Source::Photo { path: photo },
            },
        ],
        audio: vec![],
    };

    let mut stages = Vec::new();
    Renderer::default()
        .export(&spec, &dir.join("work"), &out, |p| {
            stages.push(p.stage.clone())
        })
        .await
        .expect("a timeline with a hole in it exports");

    let duration: f32 = probe_format(&out, "format=duration").parse().unwrap_or(0.0);
    assert!(
        (duration - 3.0).abs() < 0.35,
        "the gap is rendered, not skipped: got {duration}s"
    );
    assert!(
        stages.iter().any(|s| s.contains("gap")),
        "and it reports itself while rendering: {stages:?}"
    );
    assert_eq!(probe(&out, "stream=codec_name"), "h264");

    let _ = std::fs::remove_dir_all(&dir);
}

/// The end of the three-photo pipeline: two AI transitions, one playable film.
///
/// This is the spec the editor hardcodes — `buildExportSpec` in `state/store.ts` — over the
/// clips a finished film assembles, so what is asserted here is what a user actually gets
/// when they press **Export film**: H.264, 1920 × 1080, 30 fps, the two legs back to back
/// and in order, out of silent sources that were never the same size or rate as the output.
#[tokio::test]
async fn exports_an_assembled_three_photo_film() {
    if !ffmpeg_present() {
        eprintln!("skipping: ffmpeg is not installed");
        return;
    }

    let dir = workdir("film");
    let first = make_transition(
        &dir,
        "film-1.mp4",
        "testsrc=size=1024x576:duration=5:rate=24",
    );
    let second = make_transition(
        &dir,
        "film-2.mp4",
        "smptebars=size=854x480:duration=5:rate=25",
    );
    let out = dir.join("my-film.mp4");

    let spec = ExportSpec {
        width: 1920,
        height: 1080,
        fps: 30,
        clips: vec![
            ExportClip {
                name: "film-1.mp4".into(),
                start_ms: 0,
                duration_ms: 5000,
                transform: None,
                source: Source::Video {
                    path: first,
                    trim_start_ms: 0,
                },
            },
            ExportClip {
                name: "film-2.mp4".into(),
                start_ms: 5000,
                duration_ms: 5000,
                transform: None,
                source: Source::Video {
                    path: second,
                    trim_start_ms: 0,
                },
            },
        ],
        audio: vec![],
    };

    let produced = Renderer::default()
        .export(&spec, &dir.join("work"), &out, |_| {})
        .await
        .expect("a whole film exports");

    assert_eq!(probe(&produced, "stream=width,height"), "1920\n1080");
    assert_eq!(probe(&produced, "stream=codec_name"), "h264");
    assert_eq!(probe(&produced, "stream=r_frame_rate"), "30/1");

    let duration: f32 = probe_format(&produced, "format=duration")
        .parse()
        .unwrap_or(0.0);
    assert!(
        (duration - 10.0).abs() < 0.35,
        "two 5s transitions should make a ~10s film, got {duration}s"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// The anchor a video side of an AI transition is animated from or to. This is the whole
/// reason transitions can involve video at all: a photo is already a still, a video is not,
/// and the frame has to come off the same decoder the export uses so the anchor and the
/// footage beside it agree on rotation and pixel aspect.
#[tokio::test]
async fn grabs_one_anchor_still_out_of_a_video() {
    if !ffmpeg_present() {
        eprintln!("skipping: ffmpeg not on PATH");
        return;
    }
    let dir = workdir("anchor");
    let video = make_video(&dir);

    let jpeg = Renderer::default()
        .capture_frame(&video, 1500, STILL_WIDTH, STILL_HEIGHT)
        .await
        .expect("capture a frame");

    // A real JPEG: SOI marker, and enough bytes to be a picture rather than a header.
    assert_eq!(&jpeg[..2], &[0xff, 0xd8], "not a JPEG");
    assert!(
        jpeg.len() > 2000,
        "suspiciously small: {} bytes",
        jpeg.len()
    );

    // Cover-cropped to the anchor size, so it arrives at Higgsfield shaped like a photo
    // still — the 640x480 source is scaled up and cropped, never letterboxed.
    let out = dir.join("still.jpg");
    std::fs::write(&out, &jpeg).expect("write still");
    assert_eq!(probe(&out, "stream=width,height"), "1280\n720");

    let _ = std::fs::remove_dir_all(&dir);
}

/// The tail anchor is asked for at the clip's trimmed-out point, and the editor's idea of a
/// clip's length is provisional until its probe lands — so an ask past the real end has to
/// come back with the last frame there is rather than nothing at all.
#[tokio::test]
async fn an_anchor_asked_for_past_the_end_still_lands_on_the_last_frame() {
    if !ffmpeg_present() {
        eprintln!("skipping: ffmpeg not on PATH");
        return;
    }
    let dir = workdir("anchor-past-end");
    let video = make_video(&dir); // 3 s

    let jpeg = Renderer::default()
        .capture_frame(&video, 30_000, STILL_WIDTH, STILL_HEIGHT)
        .await
        .expect("capture the tail frame");
    assert_eq!(&jpeg[..2], &[0xff, 0xd8], "not a JPEG");

    let _ = std::fs::remove_dir_all(&dir);
}

/// A source that has gone missing is named, exactly as an export names it — the same
/// failure a user can actually act on.
#[tokio::test]
async fn a_missing_video_is_named_when_its_anchor_is_asked_for() {
    if !ffmpeg_present() {
        eprintln!("skipping: ffmpeg not on PATH");
        return;
    }
    let err = Renderer::default()
        .capture_frame(Path::new("/nope/gone.mp4"), 0, STILL_WIDTH, STILL_HEIGHT)
        .await
        .expect_err("a missing file cannot be captured");
    assert!(err.to_string().contains("gone.mp4"), "{err}");
}
