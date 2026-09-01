//! Renders a SolCut timeline to an MP4 with ffmpeg.
//!
//! Two passes: every clip is normalised to identical codec/size/rate parameters, then the
//! normalised parts are stitched with the concat demuxer. That is slower than one giant
//! filter graph but it keeps each clip's failure isolated and reportable, and it lets the
//! UI show real per-clip progress.
//!
//! A clip carries the time it starts at, so the track may have gaps in it. A gap becomes a
//! part like any other — black picture, silent bed, same encoder settings — which is what
//! lets the concat stay a stream copy.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tokio::process::Command;

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

    /// A transition name that is not in [`TRANSITIONS`]. Refused before ffmpeg is spawned,
    /// so a model that answered with a motion this build cannot render is reported as that
    /// rather than as an ffmpeg parse failure sixty frames in.
    #[error("{0:?} is not a transition SolCut can render")]
    UnknownTransition(String),

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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Source {
    /// A still, held for the clip's duration.
    Photo { path: PathBuf },
    /// A video — including a clip Higgsfield generated — played from `trim_start_ms`.
    Video { path: PathBuf, trim_start_ms: u32 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportClip {
    pub name: String,
    /// Where on the timeline the clip starts. Defaulted so a spec from an editor that laid
    /// its clips end to end — every `start_ms` zero — still stitches in list order.
    #[serde(default)]
    pub start_ms: u32,
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

/// One sound lane, mixed under the stitched film. The editor drops muted lanes before the
/// spec is sent, so every track here is meant to be heard.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioTrack {
    pub path: PathBuf,
    /// Where on the timeline the sound starts.
    pub start_ms: u32,
    /// Where playback starts inside the source file.
    pub trim_start_ms: u32,
    pub duration_ms: u32,
    #[serde(default = "full_volume")]
    pub volume: f32,
}

fn full_volume() -> f32 {
    1.0
}

impl AudioTrack {
    fn name(&self) -> String {
        self.path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("audio track")
            .to_string()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSpec {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub clips: Vec<ExportClip>,
    /// Defaulted so a spec from an editor that predates audio still deserialises.
    #[serde(default)]
    pub audio: Vec<AudioTrack>,
}

impl Default for ExportSpec {
    fn default() -> Self {
        Self {
            width: 1920,
            height: 1080,
            fps: 30,
            clips: Vec::new(),
            audio: Vec::new(),
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

/// The filter chain that renders one photo: scaled to *cover* the export frame, cropped to
/// it, and held still for the clip's duration.
pub fn photo_filter(spec: &ExportSpec) -> String {
    let (w, h) = (spec.width, spec.height);
    format!(
        "scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1,\
         fps={fps},format=yuv420p",
        fps = spec.fps
    )
}

/// ffmpeg's argument parser is locale-independent and wants a plain decimal; make sure
/// we never emit scientific notation or a bare `-`.
fn num(v: f32) -> String {
    let v = if v.is_finite() { v } else { 0.0 };
    let s = format!("{:.6}", v);
    let s = s.trim_end_matches('0').trim_end_matches('.').to_string();
    if s.is_empty() || s == "-" || s == "-0" {
        "0".to_string()
    } else {
        s
    }
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

/// The size of an anchor still handed to Higgsfield. Matches `FRAME_WIDTH`/`FRAME_HEIGHT`
/// in `src/lib/frames.ts`, so a frame grabbed out of a video and one drawn from a photo
/// reach the API as the same shape.
pub const STILL_WIDTH: u32 = 1280;
pub const STILL_HEIGHT: u32 = 720;

/// How far back from a source's end a tail anchor is taken.
///
/// It has to be a margin rather than one frame: ffmpeg's accurate seek discards frames
/// whose timestamp falls *before* the target, so landing between the last frame's start and
/// the end of the file decodes nothing at all — and nothing here knows the source's frame
/// rate to aim at its last frame exactly. A tenth of a second clears the final frame at
/// every rate down to 12 fps, and three frames of slack costs a motion anchor nothing.
pub const TAIL_MARGIN_SECS: f32 = 0.1;

/// Where a still request may actually seek to: never negative, and never past the last
/// frame there is. `duration_secs` is `None` when the source could not be probed, in which
/// case the request stands as asked and ffmpeg decides.
///
/// This is the whole reason the clamp lives on this side: the editor's idea of a clip's
/// length is provisional until the file has been probed, so only the file itself knows
/// where its last frame is.
pub fn still_seek_secs(at_ms: u32, duration_secs: Option<f32>) -> f32 {
    let asked = at_ms as f32 / 1000.0;
    let capped = match duration_secs {
        Some(d) if d.is_finite() && d > 0.0 => asked.min(d - TAIL_MARGIN_SECS),
        _ => asked,
    };
    capped.max(0.0)
}

/// ffmpeg argv for pulling one frame out of `path` at `at_secs`, cover-cropped to
/// `width`x`height` and written to stdout as a JPEG.
///
/// The crop matches `renderPhotoJpeg` in `src/lib/frames.ts` rather than the export's
/// letterbox, because these two frames are the *ends of one motion* — Higgsfield is given
/// a still from each side and they have to be framed alike. `-ss` before `-i` seeks the
/// input, which ffmpeg still resolves to the exact timestamp, and autorotation applies the
/// display matrix, so a phone clip's anchor stands the same way up as its export does.
pub fn still_args(path: &Path, at_secs: f32, width: u32, height: u32) -> Vec<String> {
    vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-ss".into(),
        num(at_secs),
        "-i".into(),
        path.display().to_string(),
        "-frames:v".into(),
        "1".into(),
        "-vf".into(),
        format!(
            "scale={width}:{height}:force_original_aspect_ratio=increase,\
             crop={width}:{height},setsar=1"
        ),
        "-q:v".into(),
        "2".into(),
        "-f".into(),
        "mjpeg".into(),
        "-".into(),
    ]
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
        Source::Photo { path } => {
            args.extend(["-loop".into(), "1".into()]);
            args.extend(["-framerate".into(), spec.fps.to_string()]);
            args.extend(["-t".into(), duration.clone()]);
            args.extend(["-i".into(), path.display().to_string()]);
            photo_filter(spec)
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

    args.extend(encode_args(spec, &duration, out));
    args
}

/// Full ffmpeg argv for the part that fills a gap between two clips: black picture, silent
/// bed, and the encoder settings every other part uses, so the concat is still a copy.
pub fn gap_args(spec: &ExportSpec, duration_ms: u32, out: &Path) -> Vec<String> {
    let duration = num(duration_ms as f32 / 1000.0);
    let mut args: Vec<String> = vec!["-hide_banner".into(), "-nostdin".into(), "-y".into()];

    args.extend([
        "-f".into(),
        "lavfi".into(),
        "-t".into(),
        duration.clone(),
        "-i".into(),
        format!(
            "color=c=black:s={w}x{h}:r={fps}",
            w = spec.width,
            h = spec.height,
            fps = spec.fps
        ),
    ]);
    args.extend([
        "-f".into(),
        "lavfi".into(),
        "-t".into(),
        duration.clone(),
        "-i".into(),
        "anullsrc=channel_layout=stereo:sample_rate=48000".into(),
    ]);
    args.extend([
        "-filter_complex".into(),
        "[0:v]setsar=1,format=yuv420p[v]".into(),
    ]);
    args.extend(["-map".into(), "[v]".into(), "-map".into(), "1:a:0".into()]);
    args.extend(encode_args(spec, &duration, out));
    args
}

/// The encoder settings shared by every part. They have to match exactly, or the concat
/// demuxer cannot stream-copy the parts into one film.
fn encode_args(spec: &ExportSpec, duration: &str, out: &Path) -> Vec<String> {
    vec![
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
        duration.to_string(),
        "-movflags".into(),
        "+faststart".into(),
        out.display().to_string(),
    ]
}

// ---------------------------------------------------------------- agent transitions

/// The motions a locally composited transition may be, and the only strings that ever
/// reach ffmpeg's `xfade=transition=` from a model's answer.
///
/// A closed list rather than a filter graph: an agent CLI picks one of these by name, so
/// nothing it writes is ever parsed as ffmpeg syntax and there is no injection surface to
/// guard. Two rules picked the sixteen.
///
/// **They all predate the ffmpeg the user is likely to have.** `xfade` landed in 4.3 with
/// transitions 0–34; `hblur`, the wipe corners, `zoomin` and the wind/cover/reveal family
/// came later. Everything here is in that original set, so a recipe cannot outrun an
/// older build and fail at the last step of a render the user already paid for.
///
/// **They are visually distinct.** ffmpeg also offers `smoothleft`, `hlslice` and
/// `diagtl`, but "slide left" versus "smooth left" versus "hl slice" is a distinction no
/// prompt can make reliably and no test can score — so the near-duplicates are left out
/// and the vocabulary stays one a human can review by eye.
pub const TRANSITIONS: &[&str] = &[
    "fade",
    "dissolve",
    "fadeblack",
    "fadewhite",
    "wipeleft",
    "wiperight",
    "wipeup",
    "wipedown",
    "slideleft",
    "slideright",
    "slideup",
    "slidedown",
    "circleopen",
    "circleclose",
    "radial",
    "pixelize",
];

/// The shortest a composited transition may run.
///
/// A floor rather than a formality: between two photos the finished clip **stands in their
/// place** and both stills leave the track, so a transition shorter than this replaces two
/// five-second photos with a blink and there is no undo for the span it consumed. One
/// second is the least that still reads as motion.
pub const MIN_TRANSITION_SECS: f32 = 1.0;

/// The longest. Past this it stops being a cut and starts being the film.
pub const MAX_TRANSITION_SECS: f32 = 8.0;

/// Whether `name` is a motion this crate will render.
pub fn is_transition(name: &str) -> bool {
    TRANSITIONS.contains(&name)
}

/// A duration the renderer will accept, whatever was asked for.
pub fn clamp_transition_secs(secs: f32) -> f32 {
    if !secs.is_finite() {
        return MIN_TRANSITION_SECS;
    }
    secs.clamp(MIN_TRANSITION_SECS, MAX_TRANSITION_SECS)
}

/// Full ffmpeg argv for compositing one transition between two stills.
///
/// The timing is the whole trick. Each still is held for exactly `secs` and the crossfade
/// is `duration=secs:offset=0`, so the output is `2·secs − secs = secs` long and **every
/// frame of it is mid-transition** — there is no held still at either end. That is what
/// lets the result stand in for the two photos it replaces rather than being inserted
/// between them, which is the landing a photo-to-photo cut already defaults to.
///
/// Both sides go through [`photo_filter`], the same cover-crop the export gives a photo,
/// so two sources of different shapes meet `xfade` at identical size, rate and pixel
/// aspect — which it requires — and the motion is framed the way the finished film is.
pub fn transition_args(
    spec: &ExportSpec,
    start: &Path,
    end: &Path,
    transition: &str,
    secs: f32,
    out: &Path,
) -> Vec<String> {
    let secs = num(clamp_transition_secs(secs));
    let filter = photo_filter(spec);
    let mut args: Vec<String> = vec!["-hide_banner".into(), "-nostdin".into(), "-y".into()];

    for path in [start, end] {
        args.extend(["-loop".into(), "1".into()]);
        args.extend(["-framerate".into(), spec.fps.to_string()]);
        args.extend(["-t".into(), secs.clone()]);
        args.extend(["-i".into(), path.display().to_string()]);
    }

    // A silent stereo bed, exactly as `normalize_args` gives every other part: the clip
    // this produces is imported like any other video, and one that arrives with no audio
    // stream at all is a shape the rest of the pipeline never has to meet.
    args.extend([
        "-f".into(),
        "lavfi".into(),
        "-t".into(),
        secs.clone(),
        "-i".into(),
        "anullsrc=channel_layout=stereo:sample_rate=48000".into(),
    ]);

    args.extend([
        "-filter_complex".into(),
        format!(
            "[0:v]{filter}[a];[1:v]{filter}[b];             [a][b]xfade=transition={transition}:duration={secs}:offset=0,format=yuv420p[v]"
        ),
    ]);
    args.extend(["-map".into(), "[v]".into()]);
    args.extend(["-map".into(), "2:a:0".into()]);
    args.extend(encode_args(spec, &secs, out));
    args
}

/// One piece of the finished film, in play order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimelinePart {
    /// Empty track: black for this many milliseconds.
    Gap(u32),
    /// The clip at this index in `ExportSpec::clips`.
    Clip(usize),
}

/// The film as a run of parts: every clip in time order, with a black gap wherever the
/// track is empty — including in front of a first clip that does not start at 0:00.
///
/// Clips that claim the same instant (an older spec, where every `start_ms` is zero) simply
/// follow each other: `start_ms` behind the cursor produces no gap, never a negative one.
pub fn timeline_parts(spec: &ExportSpec) -> Vec<TimelinePart> {
    let mut order: Vec<usize> = (0..spec.clips.len()).collect();
    order.sort_by_key(|i| spec.clips[*i].start_ms);

    let mut parts = Vec::with_capacity(order.len());
    let mut cursor = 0u32;
    for i in order {
        let clip = &spec.clips[i];
        if clip.start_ms > cursor {
            parts.push(TimelinePart::Gap(clip.start_ms - cursor));
            cursor = clip.start_ms;
        }
        parts.push(TimelinePart::Clip(i));
        cursor += clip.duration_ms;
    }
    parts
}

/// The filter graph that lays every audio track over the stitched film's own sound.
///
/// Track `i` is ffmpeg input `i + 1` (the film is input 0): trimmed to the segment the
/// lane plays, converted to the bed's layout so `amix` never guesses, and delayed to its
/// place on the timeline. `duration=first` pins the output to the film's length — a music
/// bed running past the last clip is cut, never padded — and `normalize=0` keeps the
/// levels as authored instead of dividing everything by the track count.
pub fn audio_mix_filter(tracks: &[AudioTrack]) -> String {
    let mut parts = Vec::new();
    let mut labels = vec!["[0:a]".to_string()];

    for (i, track) in tracks.iter().enumerate() {
        let input = i + 1;
        let from = num(track.trim_start_ms as f32 / 1000.0);
        let to = num((track.trim_start_ms + track.duration_ms) as f32 / 1000.0);
        let mut chain = vec![
            format!("atrim=start={from}:end={to}"),
            "asetpts=PTS-STARTPTS".to_string(),
            "aformat=sample_rates=48000:channel_layouts=stereo".to_string(),
        ];
        if (track.volume - 1.0).abs() > f32::EPSILON {
            chain.push(format!("volume={}", num(track.volume.clamp(0.0, 1.0))));
        }
        if track.start_ms > 0 {
            chain.push(format!("adelay={ms}|{ms}", ms = track.start_ms));
        }
        parts.push(format!("[{input}:a]{}[mix{input}]", chain.join(",")));
        labels.push(format!("[mix{input}]"));
    }

    parts.push(format!(
        "{}amix=inputs={}:duration=first:normalize=0[aout]",
        labels.join(""),
        labels.len(),
    ));
    parts.join(";")
}

/// Full ffmpeg argv for the mixing pass. The picture is already final, so it is
/// stream-copied; only the mixed audio is encoded.
pub fn mix_args(stitched: &Path, tracks: &[AudioTrack], out: &Path) -> Vec<String> {
    let mut args: Vec<String> = vec!["-hide_banner".into(), "-nostdin".into(), "-y".into()];
    args.extend(["-i".into(), stitched.display().to_string()]);
    for track in tracks {
        args.extend(["-i".into(), track.path.display().to_string()]);
    }
    args.extend(["-filter_complex".into(), audio_mix_filter(tracks)]);
    args.extend(["-map".into(), "0:v".into(), "-map".into(), "[aout]".into()]);
    args.extend([
        "-c:v".into(),
        "copy".into(),
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        "128k".into(),
        "-ar".into(),
        "48000".into(),
        "-ac".into(),
        "2".into(),
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

    /// The source's real length in seconds, read with ffprobe. `None` whenever ffprobe
    /// cannot say — a missing binary, an unreadable container — so the caller falls back to
    /// asking for the timestamp it was given rather than refusing outright.
    pub async fn duration_secs(&self, path: &Path) -> Option<f32> {
        let output = Command::new(&self.ffprobe)
            .args([
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "csv=p=0",
            ])
            .arg(path)
            .kill_on_drop(true)
            .output()
            .await
            .ok()?;
        if !output.status.success() {
            return None;
        }
        String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse::<f32>()
            .ok()
            .filter(|d| d.is_finite() && *d > 0.0)
    }

    /// One frame of `path` as JPEG bytes — the anchor a video side of a transition is
    /// animated from or to.
    ///
    /// The request is clamped against the file's own duration, because the editor's idea of
    /// a clip's length is provisional until its probe lands: asking for the tail frame of a
    /// video that turned out to be shorter must give the last frame there is, not nothing.
    pub async fn capture_frame(
        &self,
        path: &Path,
        at_ms: u32,
        width: u32,
        height: u32,
    ) -> Result<Vec<u8>> {
        // No `is_available` preflight here, unlike `export`: that one guards a long
        // multi-step job whose failure halfway through would waste minutes. This is a
        // single call, and a missing binary already surfaces as `FfmpegMissing` through
        // `From<io::Error>` — a second process spawned to ask first would buy nothing.
        if !path.exists() {
            return Err(RenderError::SourceMissing {
                clip: file_name(path),
                path: path.display().to_string(),
            });
        }

        let at_secs = still_seek_secs(at_ms, self.duration_secs(path).await);
        let args = still_args(path, at_secs, width, height);
        let output = Command::new(&self.ffmpeg)
            .args(&args)
            .kill_on_drop(true)
            .output()
            .await?;

        if !output.status.success() {
            return Err(RenderError::Ffmpeg {
                stage: "grabbing a frame".into(),
                code: output.status.code().unwrap_or(-1),
                stderr: tail(&String::from_utf8_lossy(&output.stderr), 20),
            });
        }
        if output.stdout.is_empty() {
            // ffmpeg reports success having decoded nothing when the seek lands in a hole.
            return Err(RenderError::Ffmpeg {
                stage: "grabbing a frame".into(),
                code: 0,
                stderr: format!("no frame at {at_secs}s in {}", file_name(path)),
            });
        }
        Ok(output.stdout)
    }

    /// Composite one transition between two stills and write it to `out`.
    ///
    /// The single-call sibling of [`Self::capture_frame`], and it takes the same view of a
    /// missing binary: no `is_available` preflight, because `From<io::Error>` already turns
    /// that into [`RenderError::FfmpegMissing`] and a second spawned process would buy
    /// nothing.
    ///
    /// The transition name is checked here as well as where the recipe was parsed. It costs
    /// one list lookup and it means this function cannot be handed a string that reaches
    /// ffmpeg's filter parser unvetted, whoever calls it.
    pub async fn render_transition(
        &self,
        spec: &ExportSpec,
        start: &Path,
        end: &Path,
        transition: &str,
        secs: f32,
        out: &Path,
    ) -> Result<()> {
        if !is_transition(transition) {
            return Err(RenderError::UnknownTransition(transition.to_string()));
        }
        for path in [start, end] {
            if !path.exists() {
                return Err(RenderError::SourceMissing {
                    clip: file_name(path),
                    path: path.display().to_string(),
                });
            }
        }
        if let Some(parent) = out.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| RenderError::Io(e.to_string()))?;
        }

        let args = transition_args(spec, start, end, transition, secs, out);
        let output = Command::new(&self.ffmpeg)
            .args(&args)
            .kill_on_drop(true)
            .output()
            .await?;

        if !output.status.success() {
            return Err(RenderError::Ffmpeg {
                stage: "compositing a transition".into(),
                code: output.status.code().unwrap_or(-1),
                stderr: tail(&String::from_utf8_lossy(&output.stderr), 20),
            });
        }
        Ok(())
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
        for track in &spec.audio {
            if !track.path.exists() {
                return Err(RenderError::SourceMissing {
                    clip: track.name(),
                    path: track.path.display().to_string(),
                });
            }
        }

        tokio::fs::create_dir_all(workdir).await?;
        let timeline = timeline_parts(spec);
        let total = timeline.len() + 1 + usize::from(!spec.audio.is_empty());
        let mut parts = Vec::with_capacity(timeline.len());

        for (i, part) in timeline.iter().enumerate() {
            let out_part = workdir.join(format!("part-{i:03}.mp4"));
            let count = timeline.len();

            match part {
                TimelinePart::Gap(duration_ms) => {
                    on_progress(Progress {
                        stage: format!("Rendering the gap ({} of {count})", i + 1),
                        done: i,
                        total,
                    });
                    self.run(&gap_args(spec, *duration_ms, &out_part), "rendering a gap")
                        .await?;
                }
                TimelinePart::Clip(index) => {
                    let clip = &spec.clips[*index];
                    on_progress(Progress {
                        stage: format!("Rendering {} ({} of {count})", clip.name, i + 1),
                        done: i,
                        total,
                    });
                    let has_audio = matches!(clip.source, Source::Video { .. })
                        && self.has_audio(clip.path()).await;
                    let args = normalize_args(spec, clip, has_audio, &out_part);
                    self.run(&args, &format!("rendering {}", clip.name)).await?;
                }
            }
            parts.push(out_part);
        }

        on_progress(Progress {
            stage: "Joining clips".into(),
            done: timeline.len(),
            total,
        });

        // With audio lanes to mix, the stitch is an intermediate; without, it is the file.
        let stitched = if spec.audio.is_empty() {
            out.to_path_buf()
        } else {
            workdir.join("stitched.mp4")
        };
        let list = workdir.join("concat.txt");
        tokio::fs::write(&list, concat_list(&parts)).await?;
        self.run(&concat_args(&list, &stitched), "joining the clips")
            .await?;

        if !spec.audio.is_empty() {
            on_progress(Progress {
                stage: "Mixing audio".into(),
                done: timeline.len() + 1,
                total,
            });
            self.run(
                &mix_args(&stitched, &spec.audio, out),
                "mixing the audio tracks",
            )
            .await?;
        }

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

/// The bare file name, for an error a human can place without reading a whole path.
fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.display().to_string())
}

/// ffmpeg's stderr is enormous; the last few lines carry the actual reason.
fn tail(s: &str, lines: usize) -> String {
    let all: Vec<&str> = s.lines().filter(|l| !l.trim().is_empty()).collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_transition_offered_predates_the_ffmpeg_a_user_is_likely_to_have() {
        // `xfade` shipped in ffmpeg 4.3 with transitions 0-34; `hblur` (35), the wipe
        // corners, `zoomin` and the wind/cover/reveal families all came later. A recipe
        // naming one of those would compose fine here and die on an older build at the last
        // step of a render the user had already waited for.
        const AFTER_4_3: &[&str] = &[
            "hblur",
            "fadegrays",
            "wipetl",
            "squeezeh",
            "zoomin",
            "fadefast",
            "hlwind",
            "coverleft",
            "revealright",
        ];
        for name in TRANSITIONS {
            assert!(
                !AFTER_4_3.contains(name),
                "{name} postdates the 4.3 xfade set this vocabulary is pinned to"
            );
        }
        assert!(is_transition("slideleft"));
        assert!(
            !is_transition("zoomin"),
            "a real filter, but not one of ours"
        );
        assert!(!is_transition(""));
    }

    #[test]
    fn a_transition_is_never_short_enough_to_swallow_the_photos_it_replaces() {
        // The failure this guards: between two photos the finished clip stands in their
        // place and both stills leave the track. A model answering 0.2 s would trade two
        // five-second photos for a blink, and the span it consumed does not come back.
        assert_eq!(clamp_transition_secs(0.2), MIN_TRANSITION_SECS);
        assert_eq!(clamp_transition_secs(-4.0), MIN_TRANSITION_SECS);
        assert_eq!(clamp_transition_secs(f32::NAN), MIN_TRANSITION_SECS);
        assert_eq!(clamp_transition_secs(99.0), MAX_TRANSITION_SECS);
        assert_eq!(clamp_transition_secs(3.5), 3.5);
    }

    #[test]
    fn a_transition_holds_each_still_for_exactly_its_own_length() {
        // `2D - D = D`: hold each still for D and crossfade for D from offset 0, and every
        // frame of the output is mid-motion. Getting either number wrong shows up as a held
        // frame at one end, which is the one thing a replace landing may not have.
        let spec = ExportSpec::default();
        let args = transition_args(
            &spec,
            Path::new("/m/a.jpg"),
            Path::new("/m/b.jpg"),
            "slideleft",
            3.0,
            Path::new("/m/out.mp4"),
        );
        assert_eq!(
            args.iter().filter(|a| *a == "-t").count(),
            4,
            "two stills, the silent bed, and the encoder cap"
        );
        assert_eq!(args.iter().filter(|a| *a == "3").count(), 4);
        let filter = args
            .iter()
            .position(|a| a == "-filter_complex")
            .map(|i| args[i + 1].clone())
            .expect("a filter graph");
        assert!(
            filter.contains("xfade=transition=slideleft:duration=3:offset=0"),
            "{filter}"
        );
        // Both sides get the export's own cover-crop, or xfade refuses the pair outright.
        assert_eq!(filter.matches(&photo_filter(&spec)).count(), 2, "{filter}");
    }

    #[test]
    fn a_transition_takes_its_frame_from_the_export_rather_than_a_constant_of_its_own() {
        // A hardcoded 1920x1080 here would silently disagree with the export the day the
        // spec's default moves, and the transition would be the one clip that got scaled.
        let spec = ExportSpec {
            width: 1280,
            height: 720,
            fps: 24,
            ..ExportSpec::default()
        };
        let args = transition_args(
            &spec,
            Path::new("/m/a.jpg"),
            Path::new("/m/b.jpg"),
            "fade",
            2.0,
            Path::new("/m/out.mp4"),
        );
        let joined = args.join(" ");
        assert!(joined.contains("scale=1280:720"), "{joined}");
        assert!(joined.contains("fps=24"), "{joined}");
    }

    #[test]
    fn a_transition_argv_clamps_before_it_is_built() {
        let args = transition_args(
            &ExportSpec::default(),
            Path::new("/m/a.jpg"),
            Path::new("/m/b.jpg"),
            "fade",
            0.2,
            Path::new("/m/out.mp4"),
        );
        assert!(
            !args.iter().any(|a| a == "0.2"),
            "a sub-floor ask must not reach ffmpeg"
        );
        assert!(
            args.iter().any(|a| a == "1"),
            "it is clamped to the floor instead"
        );
    }

    #[test]
    fn a_still_request_never_seeks_past_the_last_frame_there_is() {
        // The editor asks for a video's tail at `trimStart + duration`, and that length is
        // provisional until the file has been probed — so a 12 s ask against a 4 s file
        // must land on the last frame, not in the void after it.
        assert_eq!(still_seek_secs(12_000, Some(4.0)), 4.0 - TAIL_MARGIN_SECS);
        // Comfortably inside the file: asked for is given.
        assert_eq!(still_seek_secs(1500, Some(4.0)), 1.5);
        // Nothing known about the file: ffmpeg decides, we do not invent a cap.
        assert_eq!(still_seek_secs(12_000, None), 12.0);
        // A zero-length or nonsense probe is the same as no probe.
        assert_eq!(still_seek_secs(2000, Some(0.0)), 2.0);
        // The head of a source that is shorter than one frame still cannot go negative.
        assert_eq!(still_seek_secs(0, Some(0.01)), 0.0);
    }

    #[test]
    fn a_still_is_cover_cropped_to_the_anchor_size_and_written_to_stdout() {
        let args = still_args(Path::new("/m/surf.mp4"), 2.5, STILL_WIDTH, STILL_HEIGHT);
        let line = args.join(" ");
        // Seeking before -i, so ffmpeg seeks the input rather than decoding up to the mark.
        assert!(line.contains("-ss 2.5 -i /m/surf.mp4"), "{line}");
        assert!(line.contains("-frames:v 1"), "{line}");
        // Cover-cropped like a photo still, NOT letterboxed like the export: the two ends
        // of one motion have to be framed alike.
        assert!(
            line.contains("scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720"),
            "{line}"
        );
        assert!(line.ends_with("-f mjpeg -"), "{line}");
    }

    fn spec() -> ExportSpec {
        ExportSpec {
            width: 640,
            height: 360,
            fps: 30,
            clips: vec![],
            audio: vec![],
        }
    }

    fn track(start_ms: u32, trim_start_ms: u32, duration_ms: u32, volume: f32) -> AudioTrack {
        AudioTrack {
            path: "/tmp/theme.mp3".into(),
            start_ms,
            trim_start_ms,
            duration_ms,
            volume,
        }
    }

    #[test]
    fn a_photo_is_covered_cropped_and_held_still() {
        let f = photo_filter(&spec());
        assert!(f.contains("force_original_aspect_ratio=increase"), "{f}");
        assert!(f.contains("crop=640:360"), "{f}");
        assert!(f.contains("fps=30"), "{f}");
        assert!(f.contains("format=yuv420p"), "{f}");
    }

    #[test]
    fn emits_plain_decimals_ffmpeg_can_parse() {
        assert_eq!(num(1.0), "1", "whole numbers lose their .0");
        assert_eq!(num(1.5), "1.5");
        assert_eq!(num(0.000001), "0.000001", "six decimals survive");
        assert_eq!(
            num(1.0e-7),
            "0",
            "anything finer rounds to zero, never to 1e-7"
        );
        assert_eq!(num(-0.0), "0", "ffmpeg has no use for a signed zero");
        assert_eq!(
            num(f32::NAN),
            "0",
            "a non-finite value never reaches the arguments"
        );
        assert!(!num(1.0e-7).contains('e'));
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
            start_ms: 0,
            duration_ms: 2500,
            source: Source::Photo {
                path: "/tmp/a.jpg".into(),
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
            start_ms: 0,
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
            start_ms: 0,
            duration_ms: 1000,
            source: Source::Photo {
                path: "/tmp/a.jpg".into(),
            },
        };
        let video = ExportClip {
            name: "b".into(),
            start_ms: 1000,
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

    fn photo_at(start_ms: u32, duration_ms: u32) -> ExportClip {
        ExportClip {
            name: format!("photo-{start_ms}.jpg"),
            start_ms,
            duration_ms,
            source: Source::Photo {
                path: "/tmp/a.jpg".into(),
            },
        }
    }

    #[test]
    fn the_holes_in_the_track_become_parts_of_their_own() {
        let mut s = spec();
        // A late first clip, then a hole, and the clips arrive out of order.
        s.clips = vec![photo_at(6000, 1000), photo_at(1000, 2000)];

        assert_eq!(
            timeline_parts(&s),
            vec![
                TimelinePart::Gap(1000),
                TimelinePart::Clip(1),
                TimelinePart::Gap(3000),
                TimelinePart::Clip(0),
            ]
        );
    }

    #[test]
    fn a_gapless_track_is_nothing_but_its_clips() {
        let mut s = spec();
        s.clips = vec![photo_at(0, 1000), photo_at(1000, 1000)];
        assert_eq!(
            timeline_parts(&s),
            vec![TimelinePart::Clip(0), TimelinePart::Clip(1)]
        );

        // An older spec has no positions at all: every clip claims 0:00 and they simply
        // follow one another, exactly as they used to.
        s.clips = vec![photo_at(0, 1000), photo_at(0, 1000)];
        assert_eq!(
            timeline_parts(&s),
            vec![TimelinePart::Clip(0), TimelinePart::Clip(1)]
        );
    }

    #[test]
    fn a_gap_part_is_black_silent_and_encoded_like_every_other_part() {
        let args = gap_args(&spec(), 1500, Path::new("/tmp/gap.mp4"));
        assert!(
            args.iter()
                .any(|a| a.starts_with("color=c=black:s=640x360")),
            "{args:?}"
        );
        assert!(args.contains(&"anullsrc=channel_layout=stereo:sample_rate=48000".to_string()));
        assert!(
            args.windows(2).any(|w| w[0] == "-t" && w[1] == "1.5"),
            "{args:?}"
        );

        // Concat can only stream-copy parts that agree on every encoder setting.
        let clip = normalize_args(&spec(), &photo_at(0, 1000), false, Path::new("/tmp/1.mp4"));
        for key in ["-c:v", "-pix_fmt", "-c:a", "-ar", "-ac", "-r"] {
            let val = |args: &[String]| {
                args.iter()
                    .position(|x| x == key)
                    .map(|i| args[i + 1].clone())
            };
            assert_eq!(val(&args), val(&clip), "{key} must match the clip parts");
        }
    }

    #[test]
    fn the_concat_list_escapes_quotes_in_paths() {
        let list = concat_list(&[PathBuf::from("/tmp/it's here/part-000.mp4")]);
        assert!(list.starts_with("file '"), "{list}");
        assert!(list.contains(r"'\''"), "{list}");
    }

    #[test]
    fn each_audio_lane_is_trimmed_delayed_and_mixed_over_the_films_own_sound() {
        let f = audio_mix_filter(&[track(1500, 500, 2000, 1.0), track(0, 0, 3000, 0.5)]);

        // Lane 1: playback window inside the source, then its place on the timeline.
        assert!(f.contains("[1:a]atrim=start=0.5:end=2.5"), "{f}");
        assert!(f.contains("adelay=1500|1500"), "{f}");
        // Lane 2 starts at zero, so no delay filter — but its volume is not unity.
        assert!(f.contains("[2:a]atrim=start=0:end=3"), "{f}");
        assert!(f.contains("volume=0.5"), "{f}");
        // The film's own bed plus both lanes, pinned to the film's length.
        assert!(f.contains("[0:a][mix1][mix2]amix=inputs=3"), "{f}");
        assert!(f.contains("duration=first"), "{f}");
        assert!(f.contains("normalize=0"), "{f}");
    }

    #[test]
    fn a_lane_at_full_volume_from_zero_gets_no_needless_filters() {
        let f = audio_mix_filter(&[track(0, 0, 2000, 1.0)]);
        assert!(!f.contains("volume="), "{f}");
        assert!(!f.contains("adelay"), "{f}");
        // Every lane still lands on the bed's layout so amix never has to guess.
        assert!(
            f.contains("aformat=sample_rates=48000:channel_layouts=stereo"),
            "{f}"
        );
    }

    #[test]
    fn the_mix_pass_copies_the_picture_and_encodes_only_the_sound() {
        let args = mix_args(
            Path::new("/tmp/stitched.mp4"),
            &[track(0, 0, 2000, 1.0)],
            Path::new("/tmp/out.mp4"),
        );

        // The film first, then one input per lane.
        assert_eq!(args.iter().filter(|a| *a == "-i").count(), 2, "{args:?}");
        assert!(
            args.windows(2).any(|w| w[0] == "-c:v" && w[1] == "copy"),
            "{args:?}"
        );
        assert!(
            args.windows(2).any(|w| w[0] == "-map" && w[1] == "[aout]"),
            "{args:?}"
        );
        // The audio parameters match the parts', so nothing about the format drifts.
        assert!(
            args.windows(2).any(|w| w[0] == "-c:a" && w[1] == "aac"),
            "{args:?}"
        );
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
            start_ms: 0,
            duration_ms: 1000,
            source: Source::Photo {
                path: "/tmp/a.jpg".into(),
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
            "audio": [
                {"path": "/tmp/theme.mp3", "startMs": 1500, "trimStartMs": 250, "durationMs": 8000, "volume": 0.8}
            ],
            "clips": [
                {
                    "name": "sunset.jpg", "startMs": 500, "durationMs": 6000, "kind": "photo",
                    "path": "/tmp/sunset.jpg"
                },
                {
                    "name": "surf.mp4", "startMs": 8000, "durationMs": 9000, "kind": "video",
                    "path": "/tmp/surf.mp4", "trimStartMs": 1500
                }
            ]
        }"#;

        let spec: ExportSpec = serde_json::from_str(json).expect("the editor's json parses");
        assert_eq!(spec.clips.len(), 2);
        // A clip that starts late leaves a hole in front of it, and one after the clip before.
        assert_eq!(spec.clips[0].start_ms, 500);
        assert_eq!(spec.clips[1].start_ms, 8000);
        assert_eq!(
            timeline_parts(&spec),
            vec![
                TimelinePart::Gap(500),
                TimelinePart::Clip(0),
                TimelinePart::Gap(1500),
                TimelinePart::Clip(1),
            ]
        );

        let Source::Photo { path } = &spec.clips[0].source else {
            panic!("first clip is a photo");
        };
        assert_eq!(path, Path::new("/tmp/sunset.jpg"));

        let Source::Video { trim_start_ms, .. } = &spec.clips[1].source else {
            panic!("second clip is a video");
        };
        assert_eq!(*trim_start_ms, 1500);

        assert_eq!(spec.audio.len(), 1);
        assert_eq!(spec.audio[0].start_ms, 1500);
        assert_eq!(spec.audio[0].trim_start_ms, 250);
        assert_eq!(spec.audio[0].volume, 0.8);
    }

    /// A spec with no `audio` key — from before the lanes existed — still parses.
    #[test]
    fn a_spec_without_audio_lanes_still_parses() {
        let json = r#"{"width": 640, "height": 360, "fps": 30, "clips": []}"#;
        let spec: ExportSpec = serde_json::from_str(json).expect("parses");
        assert!(spec.audio.is_empty());
    }

    /// And one with no `startMs` — from before clips could be placed — packs end to end.
    #[test]
    fn a_spec_without_positions_still_parses_and_stitches_in_order() {
        let json = r#"{
            "width": 640, "height": 360, "fps": 30,
            "clips": [
                {"name": "a.jpg", "durationMs": 1000, "kind": "photo", "path": "/tmp/a.jpg"},
                {"name": "b.jpg", "durationMs": 1000, "kind": "photo", "path": "/tmp/b.jpg"}
            ]
        }"#;
        let spec: ExportSpec = serde_json::from_str(json).expect("parses");
        assert_eq!(spec.clips[0].start_ms, 0);
        assert_eq!(
            timeline_parts(&spec),
            vec![TimelinePart::Clip(0), TimelinePart::Clip(1)],
            "no positions means no gaps"
        );
    }

    /// A spec from an editor that still sends fields this crate no longer models — the
    /// removed per-photo animation track included — parses, with the extras ignored.
    #[test]
    fn a_spec_with_fields_from_an_older_editor_still_parses() {
        let json = r#"{
            "width": 640, "height": 360, "fps": 30,
            "clips": [
                {
                    "name": "a.jpg", "durationMs": 1000, "kind": "photo", "path": "/tmp/a.jpg",
                    "legacyAnimation": [{"timeMs": 0, "scale": 1.0}]
                }
            ]
        }"#;
        let spec: ExportSpec = serde_json::from_str(json).expect("unknown fields are ignored");
        assert!(matches!(spec.clips[0].source, Source::Photo { .. }));
    }
}
