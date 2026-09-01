//! Runs the real ffmpeg binary over the transition compositor: two stills in, one MP4 out,
//! probed for the length and shape the timeline is going to expect.
//!
//! Unlike `export.rs`, a missing ffmpeg here is a **failure, not a skip**. An export has
//! plenty of behaviour worth testing without a renderer; a composited transition is nothing
//! *but* ffmpeg, so a suite that quietly passed on a bare machine would report the feature
//! as covered while proving nothing at all about it.

use solcut_render::{ExportSpec, RenderError, Renderer};
use std::path::{Path, PathBuf};
use std::process::Command;

fn require_ffmpeg() {
    let ok = Command::new("ffmpeg")
        .arg("-version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    assert!(
        ok,
        "ffmpeg is not on PATH. This suite composites real video and cannot prove anything \
         without it — install ffmpeg (see the README's Requirements table)."
    );
}

fn workdir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("solcut-xfade-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("workdir");
    dir
}

/// A still of `size`, so the pair can be deliberately mismatched.
fn still(dir: &Path, name: &str, size: &str) -> PathBuf {
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
            &format!("testsrc=size={size}:duration=1:rate=1"),
            "-frames:v",
            "1",
        ])
        .arg(&out)
        .status()
        .expect("run ffmpeg");
    assert!(status.success(), "could not build the still {name}");
    out
}

fn probe(path: &Path, entries: &str) -> String {
    let output = Command::new("ffprobe")
        .args(["-v", "error", "-show_entries", entries, "-of", "csv=p=0"])
        .arg(path)
        .output()
        .expect("run ffprobe");
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

#[tokio::test]
async fn a_composited_transition_is_the_length_the_recipe_asked_for() {
    require_ffmpeg();
    let dir = workdir("length");
    let spec = ExportSpec::default();
    let a = still(&dir, "a.png", "1280x720");
    let b = still(&dir, "b.png", "1280x720");
    let out = dir.join("out.mp4");

    Renderer::default()
        .render_transition(&spec, &a, &b, "slideleft", 3.0, &out)
        .await
        .expect("composite");

    // The whole point of `duration=D:offset=0` over two stills each held for D: the file is
    // D long and every frame of it is mid-motion. A held frame at either end would show up
    // here as a longer file.
    let duration: f32 = probe(&out, "format=duration").parse().expect("duration");
    let frame = 1.0 / spec.fps as f32;
    assert!(
        (duration - 3.0).abs() <= frame,
        "expected 3 s within one frame, got {duration}"
    );
    assert_eq!(
        probe(&out, "stream=width,height"),
        format!("{},{}", spec.width, spec.height),
        "the transition has to arrive at the frame the export uses"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn two_stills_of_different_shapes_still_meet() {
    require_ffmpeg();
    let dir = workdir("mismatched");
    let spec = ExportSpec::default();
    // `xfade` refuses inputs that differ in size, rate or pixel aspect, and a media bin
    // holds whatever the user imported — a phone portrait beside a panorama is ordinary.
    // Both sides go through the export's own cover-crop, which is what makes them meet.
    let a = still(&dir, "tall.png", "640x1136");
    let b = still(&dir, "wide.png", "3000x1000");
    let out = dir.join("out.mp4");

    Renderer::default()
        .render_transition(&spec, &a, &b, "circleopen", 1.5, &out)
        .await
        .expect("composite mismatched stills");

    assert_eq!(
        probe(&out, "stream=width,height"),
        format!("{},{}", spec.width, spec.height)
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_transition_the_build_does_not_know_never_reaches_ffmpeg() {
    require_ffmpeg();
    let dir = workdir("unknown");
    let spec = ExportSpec::default();
    let a = still(&dir, "a.png", "320x240");
    let b = still(&dir, "b.png", "320x240");
    let out = dir.join("out.mp4");

    // `zoomin` is a real ffmpeg transition — just not one of the sixteen, because it
    // postdates the 4.3 set this vocabulary is pinned to. It is refused by name here rather
    // than by whatever the user's own ffmpeg happens to say about it.
    let error = Renderer::default()
        .render_transition(&spec, &a, &b, "zoomin", 2.0, &out)
        .await
        .expect_err("an unknown transition must be refused");
    assert!(matches!(error, RenderError::UnknownTransition(ref t) if t == "zoomin"));
    assert!(!out.exists(), "nothing may be written for a refused motion");

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_still_that_moved_away_is_named_rather_than_handed_to_ffmpeg() {
    require_ffmpeg();
    let dir = workdir("missing");
    let spec = ExportSpec::default();
    let a = still(&dir, "a.png", "320x240");
    let gone = dir.join("gone.png");

    let error = Renderer::default()
        .render_transition(&spec, &a, &gone, "fade", 2.0, &dir.join("out.mp4"))
        .await
        .expect_err("a missing still must be refused");
    assert!(
        matches!(error, RenderError::SourceMissing { ref clip, .. } if clip == "gone.png"),
        "got {error}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}
