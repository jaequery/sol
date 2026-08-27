//! SolCut desktop shell.
//!
//! The interesting logic lives in two dependency-free crates — `solcut-higgsfield` for the
//! API and `solcut-render` for the ffmpeg export — so it can be tested without a GUI
//! toolchain. This file is the Tauri surface over them: commands, background jobs, events.

pub mod media;
pub mod settings;

use serde::{Deserialize, Serialize};
use settings::{SettingsInput, SettingsView};
use solcut_higgsfield::{Client, Config, Frame, GenerateRequest, HiggsfieldError, JobState};
use solcut_render::{ExportSpec, Progress, Renderer};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

/// How often a running job is polled, and how long we keep at it before giving up.
const POLL_INTERVAL: Duration = Duration::from_secs(3);
const POLL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// Past this, the UI switches to its "taking longer than usual" copy.
const SLOW_AFTER: Duration = Duration::from_secs(90);

pub struct AppState {
    config_dir: PathBuf,
    media_dir: PathBuf,
    cancelled: Mutex<HashSet<String>>,
}

impl AppState {
    fn config(&self) -> Config {
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
}

impl From<&HiggsfieldError> for GenerationError {
    fn from(e: &HiggsfieldError) -> Self {
        Self {
            title: e.title().to_string(),
            message: e.to_string(),
            retryable: e.is_retryable(),
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
    /// `data:image/jpeg;base64,…` of the photo framed as the first keyframe.
    pub start_frame: String,
    /// The same for the second keyframe, when there is one.
    pub end_frame: Option<String>,
    pub duration_seconds: f32,
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
    SettingsView::from(&state.config())
}

#[tauri::command]
fn save_settings(input: SettingsInput, state: State<'_, AppState>) -> Result<SettingsView, String> {
    let config = input.apply_to(state.config());
    settings::save(&state.config_dir, &config)?;
    Ok(SettingsView::from(&config))
}

#[tauri::command]
async fn test_connection(state: State<'_, AppState>) -> Result<String, String> {
    let config = state.config();
    let started = Instant::now();
    let client = Client::new(config).map_err(|e| e.to_string())?;
    client
        .check_credentials()
        .await
        .map_err(|e| e.to_string())?;
    Ok(format!(
        "Reached the API in {} ms.",
        started.elapsed().as_millis()
    ))
}

#[tauri::command]
fn import_media(paths: Vec<String>) -> media::ImportResult {
    media::import(&paths)
}

#[tauri::command]
fn supported_extensions() -> Vec<&'static str> {
    media::supported_extensions()
}

/// Start a generation. Returns as soon as the job is queued; everything after that
/// arrives on the `generation:update` event so the editor stays usable.
#[tauri::command]
async fn generate_animation(
    app: AppHandle,
    input: GenerateInput,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let config = state.config();
    if !config.is_configured() {
        return Err(HiggsfieldError::NotConfigured.to_string());
    }
    state.forget(&input.generation_id);

    let media_dir = state.media_dir.clone();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        run_generation(handle, config, media_dir, input).await;
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

async fn run_generation(app: AppHandle, config: Config, media_dir: PathBuf, input: GenerateInput) {
    let started = Instant::now();
    let id = input.generation_id.clone();

    let client = match Client::new(config) {
        Ok(c) => c,
        Err(e) => return fail(&app, &id, started, &e),
    };

    let request = GenerateRequest {
        prompt: input.prompt,
        start_frame: Frame::DataUrl(input.start_frame),
        end_frame: input.end_frame.map(Frame::DataUrl),
        duration_seconds: input.duration_seconds,
        seed: None,
    };

    emit(
        &app,
        GenerationUpdate::new(&id, "queued", started.elapsed()),
    );

    let handle = match client.submit(&request).await {
        Ok(h) => h,
        Err(e) => return fail(&app, &id, started, &e),
    };

    let mut queued = GenerationUpdate::new(&id, "queued", started.elapsed());
    queued.job_id = Some(handle.job_set_id.clone());
    emit(&app, queued);

    loop {
        if cancelled(&app, &id) {
            emit(
                &app,
                GenerationUpdate::new(&id, "cancelled", started.elapsed()),
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

        tokio::time::sleep(POLL_INTERVAL).await;

        match client.poll(&handle.job_set_id).await {
            Ok(JobState::Queued) => {
                let mut u = GenerationUpdate::new(&id, "queued", started.elapsed());
                u.job_id = Some(handle.job_set_id.clone());
                emit(&app, u);
            }
            Ok(JobState::Running { progress }) => {
                let mut u = GenerationUpdate::new(&id, "running", started.elapsed());
                u.progress = progress;
                u.job_id = Some(handle.job_set_id.clone());
                emit(&app, u);
            }
            Ok(JobState::Failed { message }) => {
                return fail(&app, &id, started, &HiggsfieldError::JobFailed(message));
            }
            Ok(JobState::Succeeded { video_url }) => {
                let dest = media_dir.join(format!("{id}.mp4"));
                match client.download(&video_url, &dest).await {
                    Ok(_) => {
                        let mut u = GenerationUpdate::new(&id, "succeeded", started.elapsed());
                        u.progress = 1.0;
                        u.job_id = Some(handle.job_set_id.clone());
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
                let mut u = GenerationUpdate::new(&id, "running", started.elapsed());
                u.error = Some(GenerationError::from(&e));
                emit(&app, u);
            }
            Err(e) => return fail(&app, &id, started, &e),
        }
    }
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
            let media_dir = app.path().app_cache_dir()?.join("generated");
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
            test_connection,
            import_media,
            supported_extensions,
            generate_animation,
            cancel_generation,
            ffmpeg_available,
            export_timeline,
        ])
        .run(tauri::generate_context!())
        .expect("error while running SolCut");
}
