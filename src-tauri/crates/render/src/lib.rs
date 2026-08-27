//! Renders a SolCut timeline to an MP4 with ffmpeg.
//!
//! Two passes: every clip is normalised to identical codec/size/rate parameters, then the
//! normalised parts are stitched with the concat demuxer. That is slower than one giant
//! filter graph but it keeps each clip's failure isolated and reportable, and it lets the
//! UI show real per-clip progress.

pub mod expr;

use expr::{is_constant, num, piecewise_linear, Point};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tokio::process::Command;

/// The photo transform range the editor offers. `zoompan` cannot zoom below the frame, so
/// scaling under 1.0 (which would show empty background) is not part of the model.
pub const MIN_SCALE: f32 = 1.0;
pub const MAX_SCALE: f32 = 4.0;

/// Supersampling factor for photo motion. `zoompan` snaps its window to whole pixels, so
/// panning at the output size visibly stair-steps; doing the move at 2x and scaling down
/// hides it.
const SUPERSAMPLE: u32 = 2;

#[derive(Debug, thiserror::Error)]
pub enum RenderError {
    #[error("ffmpeg was not found. Install it and make sure it is on your PATH.")]
    FfmpegMissing,

    #[error("nothing to export — the timeline is empty")]
    EmptyTimeline,

    #[error("{clip} is missing: {path}")]
    SourceMissing { clip: String, path: String },

    #[error("ffmpeg failed while {stage} (exit {code}):\n{stderr}")]
    Ffmpeg {
        stage: String,
        code: i32,
        stderr: String,
    },

    #[error("io error: {0}")]
    Io(String),
}

impl From<std::io::Error> for RenderError {
    fn from(e: std::io::Error) -> Self {
        if e.kind() == std::io::ErrorKind::NotFound {
            Self::FfmpegMissing
        } else {
            Self::Io(e.to_string())
        }
    }
}

pub type Result<T> = std::result::Result<T, RenderError>;

/// A photo's 2D framing at one instant. `x`/`y` are percentages of the canvas so the same
/// numbers survive a change of export resolution.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Keyframe {
    pub time_ms: u32,
    pub scale: f32,
    pub x: f32,
    pub y: f32,
    pub rotation_deg: f32,
    pub opacity: f32,
}

impl Default for Keyframe {
    fn default() -> Self {
        Self {
            time_ms: 0,
            scale: 1.0,
            x: 0.0,
            y: 0.0,
            rotation_deg: 0.0,
            opacity: 1.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Source {
    /// A still, animated by its keyframes.
    Photo {
        path: PathBuf,
        keyframes: Vec<Keyframe>,
    },
    /// A video — including a clip Higgsfield generated — played from `trim_start_ms`.
    Video { path: PathBuf, trim_start_ms: u32 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportClip {
    pub name: String,
    pub duration_ms: u32,
    #[serde(flatten)]
    pub source: Source,
}

impl ExportClip {
    fn path(&self) -> &Path {
        match &self.source {
            Source::Photo { path, .. } | Source::Video { path, .. } => path,
        }
    }

    fn duration_secs(&self) -> f32 {
        self.duration_ms as f32 / 1000.0
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSpec {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub clips: Vec<ExportClip>,
}

impl Default for ExportSpec {
    fn default() -> Self {
        Self {
            width: 1920,
            height: 1080,
            fps: 30,
            clips: Vec::new(),
        }
    }
}

/// What the export dialog shows.
#[derive(Debug, Clone, Serialize)]
pub struct Progress {
    pub stage: String,
    pub done: usize,
    pub total: usize,
}

impl Progress {
    pub fn fraction(&self) -> f32 {
        if self.total == 0 {
            return 0.0;
        }
        (self.done as f32 / self.total as f32).clamp(0.0, 1.0)
    }
}

// ---------------------------------------------------------------- filter graphs

/// The filter chain that animates one photo across its keyframes.
///
/// Only the filters that actually do something are included: a photo with no motion is a
/// plain scale-and-pad, which encodes far faster and cannot go wrong.
pub fn photo_filter(spec: &ExportSpec, keyframes: &[Keyframe], duration_secs: f32) -> String {
    let (w, h) = (spec.width, spec.height);
    let (sw, sh) = (w * SUPERSAMPLE, h * SUPERSAMPLE);
    let frames = ((duration_secs * spec.fps as f32).round() as u32).max(1);

    let kf: Vec<Keyframe> = if keyframes.is_empty() {
        vec![Keyframe::default()]
    } else {
        let mut k = keyframes.to_vec();
        k.sort_by_key(|a| a.time_ms);
        k
    };

    let pts = |f: fn(&Keyframe) -> f32| -> Vec<Point> {
        kf.iter()
            .map(|k| Point {
                t: k.time_ms as f32 / 1000.0,
                v: f(k),
            })
            .collect()
    };

    let scale_pts: Vec<Point> = pts(|k| k.scale.clamp(MIN_SCALE, MAX_SCALE));
    let x_pts = pts(|k| k.x);
    let y_pts = pts(|k| k.y);
    let rot_pts = pts(|k| k.rotation_deg);
    let op_pts = pts(|k| k.opacity.clamp(0.0, 1.0));

    // Cover the frame first, so every later filter works on a known-size image.
    let mut chain = vec![format!(
        "scale={sw}:{sh}:force_original_aspect_ratio=increase,crop={sw}:{sh},setsar=1"
    )];

    let moves =
        !is_constant(&scale_pts, 1.0) || !is_constant(&x_pts, 0.0) || !is_constant(&y_pts, 0.0);
    if moves {
        // zoompan counts output frames, so time is `on/fps`.
        let time = format!("(on/{})", spec.fps);
        let z = piecewise_linear(&scale_pts, &time);
        // Panning the image right by dx means moving the crop window left by dx.
        let dx = piecewise_linear(&scaled(&x_pts, sw as f32 / 100.0), &time);
        let dy = piecewise_linear(&scaled(&y_pts, sh as f32 / 100.0), &time);
        chain.push(format!(
            "zoompan=z='{z}':x='(iw-iw/zoom)/2-({dx})':y='(ih-ih/zoom)/2-({dy})':d=1:s={sw}x{sh}:fps={fps}",
            fps = spec.fps
        ));
        // zoompan restarts its frame counter per input frame unless it is fed one image;
        // trim keeps the clip at exactly the requested length either way.
        chain.push(format!("trim=end_frame={frames}"));
    }

    if !is_constant(&rot_pts, 0.0) {
        let a = piecewise_linear(&rot_pts, "t");
        chain.push(format!("rotate=a='({a})*PI/180':ow=iw:oh=ih:c=black"));
    }

    if !is_constant(&op_pts, 1.0) {
        // The result is composited on black, so fading is a straight RGB multiply.
        let a = piecewise_linear(&op_pts, "t");
        chain.push("format=rgb24".to_string());
        chain.push(format!(
            "geq=r='r(X,Y)*({a})':g='g(X,Y)*({a})':b='b(X,Y)*({a})'"
        ));
    }

    chain.push(format!("scale={w}:{h}"));
    chain.push(format!("fps={}", spec.fps));
    chain.push("format=yuv420p".to_string());
    chain.join(",")
}

fn scaled(points: &[Point], factor: f32) -> Vec<Point> {
    points
        .iter()
        .map(|p| Point {
            t: p.t,
            v: p.v * factor,
        })
        .collect()
}

/// The filter chain that fits a video into the export frame without cropping it.
pub fn video_filter(spec: &ExportSpec) -> String {
    let (w, h) = (spec.width, spec.height);
    format!(
        "scale={w}:{h}:force_original_aspect_ratio=decrease,\
         pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps={fps},format=yuv420p",
        fps = spec.fps
    )
}

/// Full ffmpeg argv for normalising one clip into a standalone MP4 part.
///
/// Every part gets a stereo 48 kHz AAC track — silent for photos and for videos that have
/// none — because the concat demuxer refuses to stitch parts whose stream layout differs.
pub fn normalize_args(
    spec: &ExportSpec,
    clip: &ExportClip,
    clip_has_audio: bool,
    out: &Path,
) -> Vec<String> {
    let mut args: Vec<String> = vec!["-hide_banner".into(), "-nostdin".into(), "-y".into()];
    let duration = num(clip.duration_secs());

    let filter = match &clip.source {
        Source::Photo { path, keyframes } => {
            args.extend(["-loop".into(), "1".into()]);
            args.extend(["-framerate".into(), spec.fps.to_string()]);
            args.extend(["-t".into(), duration.clone()]);
            args.extend(["-i".into(), path.display().to_string()]);
            photo_filter(spec, keyframes, clip.duration_secs())
        }
        Source::Video {
            path,
            trim_start_ms,
        } => {
            if *trim_start_ms > 0 {
                args.extend(["-ss".into(), num(*trim_start_ms as f32 / 1000.0)]);
            }
            args.extend(["-t".into(), duration.clone()]);
            args.extend(["-i".into(), path.display().to_string()]);
            video_filter(spec)
        }
    };

    // Silent bed. It is always present so the mapping below is uniform.
    args.extend([
        "-f".into(),
        "lavfi".into(),
        "-t".into(),
        duration.clone(),
        "-i".into(),
        "anullsrc=channel_layout=stereo:sample_rate=48000".into(),
    ]);

    args.extend(["-filter_complex".into(), format!("[0:v]{filter}[v]")]);
    args.extend(["-map".into(), "[v]".into()]);
    if clip_has_audio {
        args.extend(["-map".into(), "0:a:0".into()]);
    } else {
        args.extend(["-map".into(), "1:a:0".into()]);
    }

    args.extend([
        "-c:v".into(),
        "libx264".into(),
        "-preset".into(),
        "veryfast".into(),
        "-crf".into(),
        "20".into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
        "-r".into(),
        spec.fps.to_string(),
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        "128k".into(),
        "-ar".into(),
        "48000".into(),
        "-ac".into(),
        "2".into(),
        "-t".into(),
        duration,
        "-movflags".into(),
        "+faststart".into(),
        out.display().to_string(),
    ]);
    args
}

/// Full ffmpeg argv for stitching the normalised parts. They share codec parameters by
/// construction, so this is a stream copy.
pub fn concat_args(list_file: &Path, out: &Path) -> Vec<String> {
    vec![
        "-hide_banner".into(),
        "-nostdin".into(),
        "-y".into(),
        "-f".into(),
        "concat".into(),
        "-safe".into(),
        "0".into(),
        "-i".into(),
        list_file.display().to_string(),
        "-c".into(),
        "copy".into(),
        "-movflags".into(),
        "+faststart".into(),
        out.display().to_string(),
    ]
}

/// The concat demuxer's list file. Single quotes are the only escape it understands.
pub fn concat_list(parts: &[PathBuf]) -> String {
    parts
        .iter()
        .map(|p| {
            format!(
                "file '{}'\n",
                p.display().to_string().replace('\'', r"'\''")
            )
        })
        .collect()
}

// ---------------------------------------------------------------- running it

pub struct Renderer {
    pub ffmpeg: String,
    pub ffprobe: String,
}

impl Default for Renderer {
    fn default() -> Self {
        Self {
            ffmpeg: "ffmpeg".into(),
            ffprobe: "ffprobe".into(),
        }
    }
}

impl Renderer {
    /// True when ffmpeg can actually be launched — checked before an export starts so the
    /// user gets "install ffmpeg" rather than a failure halfway through.
    pub async fn is_available(&self) -> bool {
        Command::new(&self.ffmpeg)
            .arg("-version")
            .kill_on_drop(true)
            .output()
            .await
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    async fn has_audio(&self, path: &Path) -> bool {
        let output = Command::new(&self.ffprobe)
            .args([
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "stream=index",
                "-of",
                "csv=p=0",
            ])
            .arg(path)
            .kill_on_drop(true)
            .output()
            .await;
        match output {
            Ok(o) => o.status.success() && !o.stdout.is_empty(),
            Err(_) => false,
        }
    }

    /// Render `spec` to `out`, using `workdir` for the intermediate parts.
    pub async fn export(
        &self,
        spec: &ExportSpec,
        workdir: &Path,
        out: &Path,
        mut on_progress: impl FnMut(Progress),
    ) -> Result<PathBuf> {
        if spec.clips.is_empty() {
            return Err(RenderError::EmptyTimeline);
        }
        if !self.is_available().await {
            return Err(RenderError::FfmpegMissing);
        }
        for clip in &spec.clips {
            if !clip.path().exists() {
                return Err(RenderError::SourceMissing {
                    clip: clip.name.clone(),
                    path: clip.path().display().to_string(),
                });
            }
        }

        tokio::fs::create_dir_all(workdir).await?;
        let total = spec.clips.len() + 1;
        let mut parts = Vec::with_capacity(spec.clips.len());

        for (i, clip) in spec.clips.iter().enumerate() {
            on_progress(Progress {
                stage: format!(
                    "Rendering {} ({} of {})",
                    clip.name,
                    i + 1,
                    spec.clips.len()
                ),
                done: i,
                total,
            });

            let part = workdir.join(format!("part-{i:03}.mp4"));
            let has_audio =
                matches!(clip.source, Source::Video { .. }) && self.has_audio(clip.path()).await;
            let args = normalize_args(spec, clip, has_audio, &part);
            self.run(&args, &format!("rendering {}", clip.name)).await?;
            parts.push(part);
        }

        on_progress(Progress {
            stage: "Joining clips".into(),
            done: spec.clips.len(),
            total,
        });

        let list = workdir.join("concat.txt");
        tokio::fs::write(&list, concat_list(&parts)).await?;
        self.run(&concat_args(&list, out), "joining the clips")
            .await?;

        on_progress(Progress {
            stage: "Done".into(),
            done: total,
            total,
        });
        Ok(out.to_path_buf())
    }

    async fn run(&self, args: &[String], stage: &str) -> Result<()> {
        let output = Command::new(&self.ffmpeg)
            .args(args)
            .kill_on_drop(true)
            .output()
            .await?;

        if output.status.success() {
            return Ok(());
        }
        Err(RenderError::Ffmpeg {
            stage: stage.to_string(),
            code: output.status.code().unwrap_or(-1),
            stderr: tail(&String::from_utf8_lossy(&output.stderr), 20),
        })
    }
}

/// ffmpeg's stderr is enormous; the last few lines carry the actual reason.
fn tail(s: &str, lines: usize) -> String {
    let all: Vec<&str> = s.lines().filter(|l| !l.trim().is_empty()).collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> ExportSpec {
        ExportSpec {
            width: 640,
            height: 360,
            fps: 30,
            clips: vec![],
        }
    }

    fn kf(time_ms: u32, scale: f32, x: f32, y: f32) -> Keyframe {
        Keyframe {
            time_ms,
            scale,
            x,
            y,
            ..Keyframe::default()
        }
    }

    #[test]
    fn a_still_photo_gets_no_motion_filters() {
        let f = photo_filter(
            &spec(),
            &[kf(0, 1.0, 0.0, 0.0), kf(2000, 1.0, 0.0, 0.0)],
            2.0,
        );
        assert!(!f.contains("zoompan"), "no movement means no zoompan: {f}");
        assert!(!f.contains("rotate"), "{f}");
        assert!(!f.contains("geq"), "{f}");
        assert!(f.contains("scale=640:360"), "{f}");
    }

    #[test]
    fn a_scaling_photo_gets_zoompan_driven_by_the_frame_counter() {
        let f = photo_filter(
            &spec(),
            &[kf(0, 1.0, 0.0, 0.0), kf(2000, 1.5, 0.0, 0.0)],
            2.0,
        );
        assert!(f.contains("zoompan"), "{f}");
        assert!(
            f.contains("(on/30)"),
            "zoompan interpolates over output frames: {f}"
        );
        assert!(f.contains("d=1"), "{f}");
    }

    #[test]
    fn panning_converts_percentages_into_supersampled_pixels() {
        // x = +10% of a 640px canvas at 2x supersampling = 128px of window offset.
        let f = photo_filter(
            &spec(),
            &[kf(0, 1.2, 0.0, 0.0), kf(1000, 1.2, 10.0, 0.0)],
            1.0,
        );
        assert!(f.contains("128"), "expected 10% of 1280px: {f}");
        assert!(
            f.contains("(iw-iw/zoom)/2-("),
            "panning moves the crop window: {f}"
        );
    }

    #[test]
    fn scale_is_clamped_to_what_zoompan_can_express() {
        let f = photo_filter(
            &spec(),
            &[kf(0, 0.2, 0.0, 0.0), kf(1000, 99.0, 0.0, 0.0)],
            1.0,
        );
        assert!(f.contains(&num(MAX_SCALE)), "clamped at the top: {f}");
        assert!(!f.contains("0.2"), "clamped at the bottom: {f}");
    }

    #[test]
    fn rotation_is_converted_to_radians() {
        let mut a = Keyframe::default();
        let mut b = Keyframe {
            time_ms: 1000,
            ..Keyframe::default()
        };
        a.rotation_deg = 0.0;
        b.rotation_deg = 90.0;
        let f = photo_filter(&spec(), &[a, b], 1.0);
        assert!(f.contains("rotate=a='"), "{f}");
        assert!(f.contains("*PI/180"), "{f}");
    }

    #[test]
    fn opacity_only_appears_when_it_varies() {
        let solid = photo_filter(&spec(), &[Keyframe::default()], 1.0);
        assert!(!solid.contains("geq"), "{solid}");

        let fading = photo_filter(
            &spec(),
            &[
                Keyframe::default(),
                Keyframe {
                    time_ms: 1000,
                    opacity: 0.0,
                    ..Keyframe::default()
                },
            ],
            1.0,
        );
        assert!(fading.contains("geq="), "{fading}");
    }

    #[test]
    fn videos_are_letterboxed_never_cropped() {
        let f = video_filter(&spec());
        assert!(f.contains("force_original_aspect_ratio=decrease"), "{f}");
        assert!(f.contains("pad=640:360"), "{f}");
    }

    #[test]
    fn a_photo_clip_loops_its_input_for_the_clip_duration() {
        let clip = ExportClip {
            name: "sunset.jpg".into(),
            duration_ms: 2500,
            source: Source::Photo {
                path: "/tmp/a.jpg".into(),
                keyframes: vec![],
            },
        };
        let args = normalize_args(&spec(), &clip, false, Path::new("/tmp/out.mp4"));
        assert!(
            args.windows(2).any(|w| w[0] == "-loop" && w[1] == "1"),
            "{args:?}"
        );
        assert!(
            args.windows(2).any(|w| w[0] == "-t" && w[1] == "2.5"),
            "{args:?}"
        );
        assert!(args.contains(&"anullsrc=channel_layout=stereo:sample_rate=48000".to_string()));
        assert!(
            args.windows(2).any(|w| w[0] == "-map" && w[1] == "1:a:0"),
            "silent bed: {args:?}"
        );
    }

    #[test]
    fn a_video_clip_seeks_before_decoding_and_keeps_its_own_audio() {
        let clip = ExportClip {
            name: "surf.mp4".into(),
            duration_ms: 4000,
            source: Source::Video {
                path: "/tmp/a.mp4".into(),
                trim_start_ms: 1500,
            },
        };
        let args = normalize_args(&spec(), &clip, true, Path::new("/tmp/out.mp4"));
        let ss = args.iter().position(|a| a == "-ss").expect("seek");
        let input = args.iter().position(|a| a == "-i").expect("input");
        assert!(
            ss < input,
            "-ss belongs before -i so the seek is fast: {args:?}"
        );
        assert_eq!(args[ss + 1], "1.5");
        assert!(
            args.windows(2).any(|w| w[0] == "-map" && w[1] == "0:a:0"),
            "{args:?}"
        );
    }

    #[test]
    fn every_part_is_encoded_the_same_way_so_concat_can_stream_copy() {
        let photo = ExportClip {
            name: "a".into(),
            duration_ms: 1000,
            source: Source::Photo {
                path: "/tmp/a.jpg".into(),
                keyframes: vec![],
            },
        };
        let video = ExportClip {
            name: "b".into(),
            duration_ms: 1000,
            source: Source::Video {
                path: "/tmp/b.mp4".into(),
                trim_start_ms: 0,
            },
        };
        let a = normalize_args(&spec(), &photo, false, Path::new("/tmp/1.mp4"));
        let b = normalize_args(&spec(), &video, true, Path::new("/tmp/2.mp4"));
        for key in ["-c:v", "-pix_fmt", "-c:a", "-ar", "-ac", "-r"] {
            let val = |args: &[String]| {
                args.iter()
                    .position(|x| x == key)
                    .map(|i| args[i + 1].clone())
            };
            assert_eq!(val(&a), val(&b), "{key} must match across parts");
        }
        assert!(
            concat_args(Path::new("/tmp/l.txt"), Path::new("/tmp/o.mp4"))
                .windows(2)
                .any(|w| w[0] == "-c" && w[1] == "copy")
        );
    }

    #[test]
    fn the_concat_list_escapes_quotes_in_paths() {
        let list = concat_list(&[PathBuf::from("/tmp/it's here/part-000.mp4")]);
        assert!(list.starts_with("file '"), "{list}");
        assert!(list.contains(r"'\''"), "{list}");
    }

    #[test]
    fn progress_is_a_usable_fraction() {
        assert_eq!(
            Progress {
                stage: "x".into(),
                done: 1,
                total: 4
            }
            .fraction(),
            0.25
        );
        assert_eq!(
            Progress {
                stage: "x".into(),
                done: 0,
                total: 0
            }
            .fraction(),
            0.0
        );
    }

    #[test]
    fn stderr_is_trimmed_to_the_useful_tail() {
        let noisy = (0..200)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let t = tail(&noisy, 20);
        assert_eq!(t.lines().count(), 20);
        assert!(t.ends_with("line 199"));
    }

    #[tokio::test]
    async fn an_empty_timeline_is_refused_before_ffmpeg_is_touched() {
        let r = Renderer {
            ffmpeg: "definitely-not-ffmpeg".into(),
            ffprobe: "nope".into(),
        };
        let err = r
            .export(
                &spec(),
                Path::new("/tmp"),
                Path::new("/tmp/out.mp4"),
                |_| {},
            )
            .await
            .unwrap_err();
        assert!(matches!(err, RenderError::EmptyTimeline), "{err:?}");
    }

    #[tokio::test]
    async fn a_missing_ffmpeg_is_reported_as_such() {
        let r = Renderer {
            ffmpeg: "definitely-not-ffmpeg".into(),
            ffprobe: "nope".into(),
        };
        assert!(!r.is_available().await);

        let mut s = spec();
        s.clips.push(ExportClip {
            name: "a".into(),
            duration_ms: 1000,
            source: Source::Photo {
                path: "/tmp/a.jpg".into(),
                keyframes: vec![],
            },
        });
        let err = r
            .export(&s, Path::new("/tmp"), Path::new("/tmp/out.mp4"), |_| {})
            .await
            .unwrap_err();
        assert!(matches!(err, RenderError::FfmpegMissing), "{err:?}");
    }
}

#[cfg(test)]
mod wire_format {
    use super::*;

    /// The editor builds this JSON in TypeScript; if the field names drift, export breaks
    /// at runtime with an unhelpful deserialisation error. Pin them here instead.
    #[test]
    fn deserialises_the_json_the_editor_sends() {
        let json = r#"{
            "width": 1920, "height": 1080, "fps": 30,
            "clips": [
                {
                    "name": "sunset.jpg", "durationMs": 6000, "kind": "photo",
                    "path": "/tmp/sunset.jpg",
                    "keyframes": [
                        {"timeMs": 0, "scale": 1.0, "x": 0.0, "y": 0.0, "rotationDeg": 0.0, "opacity": 1.0},
                        {"timeMs": 3200, "scale": 1.4, "x": -3.0, "y": 2.0, "rotationDeg": 0.0, "opacity": 1.0}
                    ]
                },
                {
                    "name": "surf.mp4", "durationMs": 9000, "kind": "video",
                    "path": "/tmp/surf.mp4", "trimStartMs": 1500
                }
            ]
        }"#;

        let spec: ExportSpec = serde_json::from_str(json).expect("the editor's json parses");
        assert_eq!(spec.clips.len(), 2);

        let Source::Photo { keyframes, .. } = &spec.clips[0].source else {
            panic!("first clip is a photo");
        };
        assert_eq!(keyframes.len(), 2);
        assert_eq!(keyframes[1].time_ms, 3200);
        assert_eq!(keyframes[1].x, -3.0);

        let Source::Video { trim_start_ms, .. } = &spec.clips[1].source else {
            panic!("second clip is a video");
        };
        assert_eq!(*trim_start_ms, 1500);
    }
}
