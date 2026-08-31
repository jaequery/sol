//! SolCut desktop shell.
//!
//! The interesting logic lives in two dependency-free crates — `solcut-higgsfield` for
//! generation through the official Higgsfield CLI and `solcut-render` for the ffmpeg
//! export — so it can be tested without a GUI toolchain. This file is the Tauri surface
//! over them: commands, background jobs, events.

pub mod media;
pub mod project;
pub mod settings;

use serde::{Deserialize, Serialize};
use settings::{SettingsInput, SettingsView};
use solcut_higgsfield::{
    check_credential, Cli, GenerateRequest, HiggsfieldError, JobState, API_BASE_URL, DEFAULT_MODEL,
};
use solcut_render::{ExportSpec, Progress, Renderer};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

/// The polling cadence: start at two seconds, ease off towards ten, and give up at an
/// application-level timeout. Each poll is one `higgsfield generate get`.
const POLL_INTERVAL_START: Duration = Duration::from_secs(2);
const POLL_INTERVAL_MAX: Duration = Duration::from_secs(10);
const POLL_BACKOFF: f32 = 1.5;
/// The wait is spent in short slices so a cancellation stops the watching promptly.
const CANCEL_CHECK_INTERVAL: Duration = Duration::from_millis(250);
const POLL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// Past this, the UI switches to its "taking longer than usual" copy.
const SLOW_AFTER: Duration = Duration::from_secs(90);

/// `version+commit` of the running backend, stamped at compile time (see `build.rs`).
///
/// Failure reports carry it because "still broken" has twice turned out to mean "a stale
/// backend process was still running": the frontend hot-reloads under `tauri dev`, the
/// Rust side does not, and nothing else in the app says which build actually answered.
pub const BUILD: &str = concat!(env!("CARGO_PKG_VERSION"), "+", env!("SOLCUT_BUILD"));

pub struct AppState {
    config_dir: PathBuf,
    media_dir: PathBuf,
    cancelled: Mutex<HashSet<String>>,
}

impl AppState {
    fn settings(&self) -> settings::Settings {
        settings::load(&self.config_dir)
    }

    fn is_cancelled(&self, id: &str) -> bool {
        self.cancelled
            .lock()
            .map(|s| s.contains(id))
            .unwrap_or(false)
    }

    fn forget(&self, id: &str) {
        if let Ok(mut s) = self.cancelled.lock() {
            s.remove(id);
        }
    }
}

// ---------------------------------------------------------------- event payloads

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationError {
    pub title: String,
    pub message: String,
    pub retryable: bool,
    /// Which backend build produced this report — [`BUILD`].
    pub build: &'static str,
}

impl From<&HiggsfieldError> for GenerationError {
    fn from(e: &HiggsfieldError) -> Self {
        Self {
            title: e.title().to_string(),
            message: e.to_string(),
            retryable: e.is_retryable(),
            build: BUILD,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationUpdate {
    pub generation_id: String,
    /// `queued` | `running` | `succeeded` | `failed` | `cancelled`
    pub status: String,
    pub progress: f32,
    /// The CLI's job id, once the submission has been accepted.
    pub job_id: Option<String>,
    pub elapsed_secs: u64,
    pub slow: bool,
    /// Absolute path of the downloaded MP4, once there is one.
    pub output_path: Option<String>,
    pub error: Option<GenerationError>,
}

impl GenerationUpdate {
    fn new(id: &str, status: &str, elapsed: Duration) -> Self {
        Self {
            generation_id: id.to_string(),
            status: status.to_string(),
            progress: 0.0,
            job_id: None,
            elapsed_secs: elapsed.as_secs(),
            slow: elapsed > SLOW_AFTER,
            output_path: None,
            error: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateInput {
    /// Chosen by the frontend so it can match events to the segment that asked for them.
    pub generation_id: String,
    pub prompt: String,
    /// `data:image/jpeg;base64,…` of the still the motion starts from — a photo drawn in
    /// the webview, or a frame grabbed out of a video by [`capture_video_frame`]. It is
    /// written to a file and handed to the CLI, which uploads it itself.
    pub start_frame: String,
    /// The same for the still the motion ends on, when there is one.
    pub end_frame: Option<String>,
    /// The CLI model id the frontend's per-render selector chose for THIS request.
    /// Absent or blank, the render falls back to the default model — the model choice
    /// travels with the request, it is not a saved setting.
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    pub stage: String,
    pub fraction: f32,
}

fn emit(app: &AppHandle, update: GenerationUpdate) {
    let _ = app.emit("generation:update", update);
}

// ---------------------------------------------------------------- commands

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> SettingsView {
    let cli = Cli::find();
    SettingsView::new(&state.settings(), cli.as_ref().map(|c| c.binary()))
}

#[tauri::command]
fn save_settings(input: SettingsInput, state: State<'_, AppState>) -> Result<SettingsView, String> {
    let settings = input.apply_to(state.settings());
    settings::save(&state.config_dir, &settings)?;
    let cli = Cli::find();
    Ok(SettingsView::new(
        &settings,
        cli.as_ref().map(|c| c.binary()),
    ))
}

/// The project the editor was last holding, or `null` when there is none.
///
/// The shape is the frontend's — see `src/lib/project.ts`. This side only moves bytes.
#[tauri::command]
fn load_project(state: State<'_, AppState>) -> Option<serde_json::Value> {
    project::load(&state.config_dir)
}

/// Store the project. Called on a debounce as the timeline changes, never by a save button.
#[tauri::command]
fn save_project(project: serde_json::Value, state: State<'_, AppState>) -> Result<(), String> {
    project::save(&state.config_dir, &project)
}

/// The Settings dialog's connection check: one free, read-only CLI call
/// (`higgsfield model list --video`) that proves the binary runs, the login is live and
/// a billing workspace is selected — and whose failure message names its own fix.
#[tauri::command]
async fn test_connection() -> Result<String, String> {
    let cli = Cli::find().ok_or_else(|| HiggsfieldError::NotInstalled.to_string())?;
    let started = Instant::now();
    let count = cli.probe().await.map_err(|e| e.to_string())?;
    let models = match count {
        Some(n) => format!("{n} video models available"),
        None => "video models listed".to_string(),
    };
    Ok(format!(
        "Signed in through the Higgsfield CLI — {models} ({} ms).",
        started.elapsed().as_millis()
    ))
}

/// What one API-key check concluded, for the dialog to show.
///
/// The key check reports its own heading rather than borrowing the CLI check's
/// "Connection OK" / "Could not connect": the two prove different things, and a machine
/// with a working CLI and a stale key is not disconnected.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyCheck {
    pub ok: bool,
    pub title: String,
    pub text: String,
}

/// The Settings dialog's **API key** check — separate from [`test_connection`], which
/// proves the CLI that actually renders.
///
/// It proves the credential the dialog is *showing*, overlaid on what is stored: the key
/// boxes mount empty, so a freshly opened dialog proves the stored key, and a typed one
/// proves what was typed — a key can be checked before it is saved. Nothing is written
/// here; the overlay is in memory only.
///
/// One free, read-only call to the documented status route. It generates nothing.
#[tauri::command]
async fn test_api_key(
    input: Option<SettingsInput>,
    state: State<'_, AppState>,
) -> Result<KeyCheck, String> {
    let settings = input.unwrap_or_default().apply_to(state.settings());
    let Some(credential) = settings.credential() else {
        return Ok(KeyCheck {
            ok: false,
            title: "No API key to check".into(),
            text: "A Higgsfield credential is a key id and a secret, and both are needed.                    Mint one at cloud.higgsfield.ai and put both halves in."
                .into(),
        });
    };

    let started = Instant::now();
    let verdict = check_credential(&credential, API_BASE_URL).await;
    Ok(KeyCheck {
        ok: verdict.accepted(),
        title: verdict.title().to_string(),
        text: verdict.describe(started.elapsed()),
    })
}

#[tauri::command]
fn import_media(paths: Vec<String>) -> media::ImportResult {
    media::import(&paths)
}

#[tauri::command]
fn supported_extensions() -> Vec<&'static str> {
    media::supported_extensions()
}

/// Start a generation. Returns as soon as the job is handed to the CLI; everything after
/// that arrives on the `generation:update` event so the editor stays usable.
#[tauri::command]
async fn generate_animation(
    app: AppHandle,
    input: GenerateInput,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let Some(cli) = Cli::find() else {
        return Err(HiggsfieldError::NotInstalled.to_string());
    };
    state.forget(&input.generation_id);

    let media_dir = state.media_dir.clone();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        run_generation(handle, cli, media_dir, input).await;
    });
    Ok(())
}

#[tauri::command]
fn cancel_generation(id: String, state: State<'_, AppState>) {
    if let Ok(mut set) = state.cancelled.lock() {
        set.insert(id);
    }
}

#[tauri::command]
async fn ffmpeg_available() -> bool {
    Renderer::default().is_available().await
}

/// One frame out of a video on disk, as a JPEG data URL — the anchor a video side of an AI
/// transition is animated from, or to.
///
/// A photo is already a still and is drawn in the webview; a video is not. Its frame comes
/// off the same ffmpeg the export uses, so the anchor Higgsfield animates from and the
/// footage that ends up beside it agree on rotation and pixel aspect. That makes ffmpeg a
/// requirement for transitions *involving video* — photo-to-photo transitions still need
/// nothing but the CLI.
#[tauri::command]
async fn capture_video_frame(path: String, at_ms: u32) -> Result<String, String> {
    let bytes = Renderer::default()
        .capture_frame(
            std::path::Path::new(&path),
            at_ms,
            solcut_render::STILL_WIDTH,
            solcut_render::STILL_HEIGHT,
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(solcut_higgsfield::jpeg_data_url(&bytes))
}

#[tauri::command]
async fn export_timeline(
    app: AppHandle,
    spec: ExportSpec,
    out_path: String,
) -> Result<String, String> {
    let out = PathBuf::from(&out_path);
    let workdir = std::env::temp_dir().join(format!("solcut-export-{}", std::process::id()));

    let progress = app.clone();
    let result = Renderer::default()
        .export(&spec, &workdir, &out, move |p: Progress| {
            let _ = progress.emit(
                "export:progress",
                ExportProgress {
                    stage: p.stage.clone(),
                    fraction: p.fraction(),
                },
            );
        })
        .await;

    let _ = tokio::fs::remove_dir_all(&workdir).await;
    result
        .map(|p| p.display().to_string())
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- the job loop

async fn run_generation(app: AppHandle, cli: Cli, media_dir: PathBuf, input: GenerateInput) {
    let started = Instant::now();
    let id = input.generation_id.clone();

    // The stills go to disk so the CLI can upload them itself; they are removed the
    // moment the submission has been answered, accepted or not.
    let frames_dir = media_dir.join("frames");
    let start_image = match solcut_higgsfield::write_frame(
        &frames_dir,
        &format!("{id}-start"),
        &input.start_frame,
    ) {
        Ok(p) => p,
        Err(e) => return fail(&app, &id, started, &e),
    };
    let end_image = match &input.end_frame {
        Some(frame) => {
            match solcut_higgsfield::write_frame(&frames_dir, &format!("{id}-end"), frame) {
                Ok(p) => Some(p),
                Err(e) => return fail(&app, &id, started, &e),
            }
        }
        None => None,
    };

    let model = input
        .model
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .unwrap_or(DEFAULT_MODEL)
        .to_string();
    let request = GenerateRequest {
        model,
        prompt: input.prompt.clone(),
        start_image: start_image.clone(),
        end_image: end_image.clone(),
    };

    emit(
        &app,
        GenerationUpdate::new(&id, "queued", started.elapsed()),
    );

    // `create` uploads both stills before it answers, so this is the slow part.
    let created = cli.create(&request).await;
    let _ = std::fs::remove_file(&start_image);
    if let Some(end) = &end_image {
        let _ = std::fs::remove_file(end);
    }
    let job_id = match created {
        Ok(job_id) => job_id,
        Err(e) => return fail(&app, &id, started, &e),
    };

    emit(&app, update_for(&id, "queued", started.elapsed(), &job_id));

    let mut interval = POLL_INTERVAL_START;
    loop {
        if wait_unless_cancelled(&app, &id, interval).await {
            // The CLI has no cancel operation, so a cancellation stops the watching —
            // the job runs out on Higgsfield's side and its result is simply dropped.
            emit(
                &app,
                update_for(&id, "cancelled", started.elapsed(), &job_id),
            );
            return;
        }
        if started.elapsed() > POLL_TIMEOUT {
            return fail(
                &app,
                &id,
                started,
                &HiggsfieldError::JobFailed(format!(
                    "gave up after {} minutes without a result",
                    POLL_TIMEOUT.as_secs() / 60
                )),
            );
        }
        interval = next_interval(interval);

        match cli.job_state(&job_id).await {
            Ok(JobState::Queued) => {
                emit(&app, update_for(&id, "queued", started.elapsed(), &job_id));
            }
            Ok(JobState::Running { progress }) => {
                let mut u = update_for(&id, "running", started.elapsed(), &job_id);
                u.progress = progress;
                emit(&app, u);
            }
            Ok(JobState::Cancelled) => {
                emit(
                    &app,
                    update_for(&id, "cancelled", started.elapsed(), &job_id),
                );
                return;
            }
            Ok(JobState::Failed { message }) => {
                return fail(&app, &id, started, &HiggsfieldError::JobFailed(message));
            }
            Ok(JobState::Succeeded { video_url }) => {
                let dest = media_dir.join(format!("{id}.mp4"));
                match cli.download(&video_url, &dest).await {
                    Ok(_) => {
                        let mut u = update_for(&id, "succeeded", started.elapsed(), &job_id);
                        u.progress = 1.0;
                        u.output_path = Some(dest.display().to_string());
                        emit(&app, u);
                    }
                    Err(e) => fail(&app, &id, started, &e),
                }
                return;
            }
            // A single failed poll is usually a blip; keep going until the timeout, but
            // surface anything that retrying cannot fix.
            Err(e) if e.is_retryable() => {
                let mut u = update_for(&id, "running", started.elapsed(), &job_id);
                u.error = Some(GenerationError::from(&e));
                emit(&app, u);
            }
            Err(e) => return fail(&app, &id, started, &e),
        }
    }
}

/// An update tagged with the job it belongs to, so the UI can quote the job id in a
/// support request.
fn update_for(id: &str, status: &str, elapsed: Duration, job_id: &str) -> GenerationUpdate {
    let mut update = GenerationUpdate::new(id, status, elapsed);
    update.job_id = Some(job_id.to_string());
    update
}

/// Wait out one polling interval, returning early — and `true` — the moment the user
/// cancels, so the card stops promptly rather than a poll's worth of seconds later.
async fn wait_unless_cancelled(app: &AppHandle, id: &str, interval: Duration) -> bool {
    let deadline = Instant::now() + interval;
    loop {
        if cancelled(app, id) {
            return true;
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return false;
        }
        tokio::time::sleep(left.min(CANCEL_CHECK_INTERVAL)).await;
    }
}

fn next_interval(current: Duration) -> Duration {
    current.mul_f32(POLL_BACKOFF).min(POLL_INTERVAL_MAX)
}

fn cancelled(app: &AppHandle, id: &str) -> bool {
    app.state::<AppState>().is_cancelled(id)
}

fn fail(app: &AppHandle, id: &str, started: Instant, error: &HiggsfieldError) {
    let mut update = GenerationUpdate::new(id, "failed", started.elapsed());
    update.error = Some(GenerationError::from(error));
    emit(app, update);
}

// ---------------------------------------------------------------- entry point

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            // Data, not cache: a saved project points at these files by path, so an OS
            // cache purge would turn finished renders into missing media. Nothing outlived
            // a session before projects were saved, which is why this was ever a cache.
            let media_dir = app.path().app_data_dir()?.join("generated");
            std::fs::create_dir_all(&config_dir)?;
            std::fs::create_dir_all(&media_dir)?;
            app.manage(AppState {
                config_dir,
                media_dir,
                cancelled: Mutex::new(HashSet::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            load_project,
            save_project,
            test_connection,
            test_api_key,
            import_media,
            supported_extensions,
            generate_animation,
            cancel_generation,
            ffmpeg_available,
            capture_video_frame,
            export_timeline,
        ])
        .run(tauri::generate_context!())
        .expect("error while running SolCut");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The regression behind "i still get this error" after the fix had merged: the
    /// report came from a stale backend process, and nothing in it could say so. Every
    /// failure now names the build that produced it.
    #[test]
    fn a_failure_event_names_the_build_that_produced_it() {
        assert!(BUILD.starts_with(env!("CARGO_PKG_VERSION")), "{BUILD}");

        let error = GenerationError::from(&HiggsfieldError::NotInstalled);
        let json = serde_json::to_value(&error).expect("serialize");
        assert_eq!(json["build"], BUILD);
    }

    #[test]
    fn a_generate_input_without_a_model_still_deserializes() {
        // The field replaced `endpoint`; an input naming neither must keep working and
        // fall back to the default model.
        let input: GenerateInput = serde_json::from_str(
            r#"{"generationId":"gen_1","prompt":"drift","startFrame":"data:image/jpeg;base64,AA=="}"#,
        )
        .expect("legacy input");
        assert!(input.model.is_none());

        let input: GenerateInput = serde_json::from_str(
            r#"{"generationId":"gen_1","prompt":"drift","startFrame":"data:image/jpeg;base64,AA==","model":"seedance_2_5"}"#,
        )
        .expect("input with a model choice");
        assert_eq!(input.model.as_deref(), Some("seedance_2_5"));
    }
}
