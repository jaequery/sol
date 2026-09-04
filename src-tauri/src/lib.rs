//! SolCut desktop shell.
//!
//! The interesting logic lives in dependency-free crates — `solcut-higgsfield` for
//! generation through the official Higgsfield CLI, `solcut-render` for the ffmpeg export,
//! `solcut-agent` for the local motion backends and `solcut-intake` for the machine-specific
//! edges of an import — so it can be tested without a GUI toolchain. This file is the Tauri
//! surface over them: commands, background jobs, events.

pub mod media;
pub mod project;
pub mod settings;

use serde::{Deserialize, Serialize};
use settings::{AgentStatus, SettingsInput, SettingsView};
use solcut_agent::{Agent, AgentCli, AgentError, MotionRequest, TransitionJob};
use solcut_higgsfield::{
    check_credential, Cli, GenerateRequest, HiggsfieldError, ImageRequest, JobState,
    VideoPromptRequest, API_BASE_URL, DEFAULT_IMAGE_MODEL, DEFAULT_MODEL,
};
use solcut_render::{ExportSpec, Progress, Renderer};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
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
    /// Where a photo the editor cannot read is put once it has been converted. Beside the
    /// generated media and for the same reason: a saved project points at these files by
    /// path, so they have to outlive the session that made them.
    imported_dir: PathBuf,
    /// Where a project goes when there is no open one to sit beside. Resolved once at
    /// launch because finding it needs Tauri, and `project.rs` — which does the naming —
    /// deliberately has no Tauri dependency.
    documents_dir: PathBuf,
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

impl From<&AgentError> for GenerationError {
    fn from(e: &AgentError) -> Self {
        Self {
            title: e.title(),
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
    /// Absolute path of the downloaded result — an MP4 for a transition, a photo for an
    /// image generation — once there is one.
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
    /// travels with the request, it is not a saved setting. Only Higgsfield reads it.
    #[serde(default)]
    pub model: Option<String>,
    /// Which backend renders this one: absent or `higgsfield` for Higgsfield, or an
    /// [`Agent`] id for a transition composited locally from a coding-agent CLI's answer.
    ///
    /// Absent meaning Higgsfield is what keeps an older frontend — or a replayed request —
    /// working unchanged, and it is the same promise `model` already makes.
    #[serde(default)]
    pub provider: Option<String>,
    /// How long the stretch of timeline this transition will occupy currently runs.
    ///
    /// Only the agent backends use it, and only to choose a length: a photo-to-photo
    /// transition stands in the stills' place, so the length is how much of the film
    /// survives, and a model told what it is replacing answers far better than one guessing.
    #[serde(default)]
    pub span_ms: Option<u32>,
}

/// Which backend a request named.
#[derive(Debug)]
enum Backend {
    Higgsfield,
    Agent(Agent),
}

impl Backend {
    /// The backend an id names. An id that is neither is refused rather than defaulted:
    /// silently falling back to Higgsfield would bill a paid render for a cut the user asked
    /// a local backend to make.
    fn parse(provider: Option<&str>) -> Result<Self, String> {
        match provider.map(str::trim).filter(|p| !p.is_empty()) {
            None | Some("higgsfield") => Ok(Self::Higgsfield),
            Some(id) => Agent::from_id(id)
                .map(Self::Agent)
                .ok_or_else(|| format!("{id:?} is not a generation backend SolCut knows")),
        }
    }
}

/// One "make me a video out of these words" request from the media bin's create sheet.
///
/// The thinnest generation request in the app, and deliberately so: a prompt-only video
/// carries no frames (unlike [`GenerateInput`]), no references and no aspect ratio (unlike
/// [`ImageGenerateInput`]). No `provider` either — the local backends composite between two
/// supplied stills and cannot make a shot from words, so Higgsfield is the only thing that
/// could serve this and naming a choice would imply otherwise.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoGenerateInput {
    /// Chosen by the frontend so it can match events to the generation that asked.
    pub generation_id: String,
    pub prompt: String,
    /// The CLI video job id chosen for THIS request. Absent or blank falls back to the
    /// default model, exactly as the other two paths do.
    #[serde(default)]
    pub model: Option<String>,
}

/// One "make me a photo" request from the media bin's compose panel.
///
/// Unlike [`GenerateInput`] nothing here is a data URL: the references are the media
/// bin's own files, and the CLI uploads a local path itself.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageGenerateInput {
    /// Chosen by the frontend so it can match events to the generation that asked.
    pub generation_id: String,
    pub prompt: String,
    /// Absolute paths of the bin photos to work from. Empty is a plain text-to-image
    /// generation; anything else generates *on top of* those photos.
    #[serde(default)]
    pub references: Vec<String>,
    /// The image job type the panel's selector chose for THIS request. Absent or blank,
    /// it falls back to the default image model — the choice travels with the request.
    #[serde(default)]
    pub model: Option<String>,
    /// e.g. `16:9`. Absent or blank takes the model's own default.
    #[serde(default)]
    pub aspect_ratio: Option<String>,
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

/// Which coding-agent CLIs are on this machine, looked up fresh each time.
///
/// Not cached: installing one is exactly the thing a user does *while* the app is open,
/// having been told to by the dialog, and a cache would make them restart to be believed.
fn agent_statuses() -> Vec<AgentStatus> {
    Agent::ALL
        .iter()
        .map(|agent| AgentStatus {
            id: agent.id().to_string(),
            label: agent.label().to_string(),
            path: AgentCli::find(*agent).map(|c| c.binary().display().to_string()),
            install: agent.install().to_string(),
            login: agent.login().to_string(),
        })
        .collect()
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> SettingsView {
    let cli = Cli::find();
    SettingsView::new(
        &state.settings(),
        cli.as_ref().map(|c| c.binary()),
        agent_statuses(),
    )
}

#[tauri::command]
fn save_settings(input: SettingsInput, state: State<'_, AppState>) -> Result<SettingsView, String> {
    let settings = input.apply_to(state.settings());
    settings::save(&state.config_dir, &settings)?;
    let cli = Cli::find();
    Ok(SettingsView::new(
        &settings,
        cli.as_ref().map(|c| c.binary()),
        agent_statuses(),
    ))
}

/// The untitled scratch project, or `null` when there is none.
///
/// The shape is the frontend's — see `src/lib/project.ts`. This side only moves bytes.
#[tauri::command]
fn load_project(state: State<'_, AppState>) -> Option<serde_json::Value> {
    project::load(&state.config_dir)
}

/// The project at a path the user picked, or why it could not be read.
///
/// Deliberately not `Option` like `load_project`: an Open that answered "nothing here" for
/// a file the user chose would open an empty editor still aimed at that file, and the next
/// autosave would write the emptiness over it.
#[tauri::command]
fn read_project(path: String) -> Result<serde_json::Value, String> {
    project::read(Path::new(&path))
}

/// Where the last write went, so the next launch opens the project the user was in.
#[tauri::command]
fn last_project_path(state: State<'_, AppState>) -> Option<String> {
    project::remembered(&state.config_dir)
}

/// Store the project — at `path`, or in the scratch when there is none.
///
/// Called on a debounce as the timeline changes, and by the switch itself. Recording where
/// the write went is best-effort on purpose: the project is already safely on disk by then,
/// and failing the whole save over the pointer would report a data loss that did not happen.
#[tauri::command]
fn save_project(
    project: serde_json::Value,
    path: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    match path.as_deref() {
        Some(path) => project::save_to(Path::new(path), &project)?,
        None => project::save(&state.config_dir, &project)?,
    }
    let _ = project::remember(&state.config_dir, path.as_deref());
    Ok(())
}

/// The projects to offer in the title bar's menu, most recent first.
///
/// `async` for one reason: it stats every path to drop the ones whose file has gone, and a
/// synchronous command runs on the main thread — so a sleeping external drive would freeze
/// the window in the moment the menu was opening. The same care `probeRestoredMedia` takes
/// on the frontend, for the same reason.
#[tauri::command]
async fn recent_projects(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    Ok(project::recents(&state.config_dir))
}

/// Where a project called `name` would go, or why it cannot go anywhere.
///
/// Nothing is created except, on a first run, the default folder itself. This answers the
/// question the inline name field asks as it is typed; `create_project` is what commits.
#[tauri::command]
fn new_project_path(
    name: String,
    near: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    project::new_project_path(&state.documents_dir, &name, near.as_deref())
}

/// Create a project at a path that must not already exist, and point the app at it.
///
/// Distinct from `save_project` on purpose: that one replaces whatever is there, which is
/// what autosave needs and exactly what creating must never do.
#[tauri::command]
fn create_project(
    path: String,
    project: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<(), String> {
    project::create(Path::new(&path), &project)?;
    // Best-effort, as in `save_project`: the project exists now, and failing the whole
    // creation over the pointer would report a loss that did not happen.
    let _ = project::remember(&state.config_dir, Some(&path));
    Ok(())
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

/// The import the user asked for: anything iCloud is only holding a placeholder for is
/// brought down first, and a photo in a format nothing here reads is converted.
///
/// `async` for the reason `recent_projects` above is: a synchronous command runs on the
/// main thread, and this one can wait minutes on a download.
#[tauri::command]
async fn import_media(
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<media::ImportResult, String> {
    let dir = state.imported_dir.clone();
    Ok(media::import(&paths, &dir).await)
}

/// Where these files are, touching nothing — the question a restored project asks about its
/// own media. Deliberately *not* `import_media`: this runs over every asset at every open,
/// and a probe that downloaded would turn opening a project into pulling back everything
/// iCloud had evicted since it was last edited.
///
/// `async` for the same reason: it stats every path, and a sleeping drive must not freeze
/// the window.
#[tauri::command]
async fn probe_media(paths: Vec<String>) -> Result<media::ImportResult, String> {
    Ok(media::probe(&paths))
}

#[tauri::command]
fn supported_extensions() -> Vec<&'static str> {
    media::supported_extensions()
}

/// The cloud libraries this machine actually has, for the media bin's import menu.
///
/// Empty is the ordinary answer, not a failure: a Mac not signed into iCloud has no library
/// to offer, and the menu simply does not appear.
#[tauri::command]
fn cloud_libraries(app: AppHandle) -> Vec<solcut_intake::CloudLibrary> {
    app.path()
        .home_dir()
        .map(|home| solcut_intake::libraries(&home))
        .unwrap_or_default()
}

/// Start a generation. Returns as soon as the job is handed to the CLI; everything after
/// that arrives on the `generation:update` event so the editor stays usable.
#[tauri::command]
async fn generate_animation(
    app: AppHandle,
    input: GenerateInput,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let backend = Backend::parse(input.provider.as_deref())?;
    state.forget(&input.generation_id);

    let media_dir = state.media_dir.clone();
    let handle = app.clone();
    match backend {
        Backend::Higgsfield => {
            let Some(cli) = Cli::find() else {
                return Err(HiggsfieldError::NotInstalled.to_string());
            };
            tauri::async_runtime::spawn(async move {
                run_generation(handle, cli, media_dir, input).await;
            });
        }
        Backend::Agent(agent) => {
            let Some(cli) = AgentCli::find(agent) else {
                return Err(AgentError::NotInstalled(agent).to_string());
            };
            tauri::async_runtime::spawn(async move {
                run_agent_generation(handle, cli, media_dir, input).await;
            });
        }
    }
    Ok(())
}

/// Start an image generation. Like [`generate_animation`] it returns as soon as the job
/// is handed to the CLI; everything after that arrives on `generation:update`.
///
/// The references are checked **before** anything is sent, so a photo that has moved —
/// or one that never had a file, which a browser drop does not — is named here instead
/// of failing anonymously inside the CLI's uploader.
#[tauri::command]
async fn generate_image(
    app: AppHandle,
    input: ImageGenerateInput,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let Some(cli) = Cli::find() else {
        return Err(HiggsfieldError::NotInstalled.to_string());
    };
    let references =
        solcut_higgsfield::validate_references(&input.references).map_err(|e| e.to_string())?;
    state.forget(&input.generation_id);

    let media_dir = state.media_dir.clone();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        run_image_generation(handle, cli, media_dir, input, references).await;
    });
    Ok(())
}

/// Start a prompt-only video generation. Like the other two it returns as soon as the job
/// is handed to the CLI; everything after that arrives on `generation:update`.
///
/// There is nothing to validate before sending — no frames to write, no references to
/// resolve — so this is only the CLI lookup and the handoff.
#[tauri::command]
async fn generate_video(
    app: AppHandle,
    input: VideoGenerateInput,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let Some(cli) = Cli::find() else {
        return Err(HiggsfieldError::NotInstalled.to_string());
    };
    state.forget(&input.generation_id);

    let media_dir = state.media_dir.clone();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        run_video_generation(handle, cli, media_dir, input).await;
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
///
/// `width`/`height` are the project's frame scaled down — the editor sends them so the two
/// ends of one motion are the same shape as each other and as the frame the result will be
/// shown in. Omitted, the still is the 16:9 [`solcut_render::STILL_WIDTH`] default, which
/// is what every caller asked for before the frame could be reshaped.
#[tauri::command]
async fn capture_video_frame(
    path: String,
    at_ms: u32,
    width: Option<u32>,
    height: Option<u32>,
) -> Result<String, String> {
    let bytes = Renderer::default()
        .capture_frame(
            std::path::Path::new(&path),
            at_ms,
            still_edge(width, solcut_render::STILL_WIDTH),
            still_edge(height, solcut_render::STILL_HEIGHT),
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(solcut_higgsfield::jpeg_data_url(&bytes))
}

/// One edge of a requested still: the caller's, when it is a size ffmpeg can actually
/// scale to, and the default otherwise. Zero is the case that matters — `scale=0:720`
/// means "keep the source's own width" to ffmpeg, so waving it through would hand back a
/// still of some entirely unrelated shape rather than failing.
fn still_edge(asked: Option<u32>, fallback: u32) -> u32 {
    match asked {
        Some(px) if px > 0 => px,
        _ => fallback,
    }
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

    // Uploading the stills can take minutes, and the cancelled set is only consulted
    // inside the poll loop below — so a cancellation during the upload is honoured the
    // moment the submission is answered, rather than after a poll's worth of seconds.
    if cancelled(&app, &id) {
        emit(
            &app,
            update_for(&id, "cancelled", started.elapsed(), &job_id),
        );
        return;
    }

    emit(&app, update_for(&id, "queued", started.elapsed(), &job_id));
    watch_job(app, cli, media_dir, id, job_id, started, Landing::Video).await;
}

/// One transition composited locally from a coding-agent CLI's answer.
///
/// The whole sequence — ask, validate, composite — lives in `solcut-agent`, which has no
/// Tauri dependency and is therefore covered by tests that run on any machine. What is left
/// here is what only the shell can do: turn data URLs into files, translate the crate's
/// steps into `generation:update` events, and clean up.
///
/// There is no job to poll and so no job id: the CLI answers in one call. The `queued` and
/// `running` steps come from the crate, and this side adds the terminal one.
async fn run_agent_generation(
    app: AppHandle,
    cli: AgentCli,
    media_dir: PathBuf,
    input: GenerateInput,
) {
    let started = Instant::now();
    let id = input.generation_id.clone();

    let Some(end_frame) = input.end_frame.as_deref() else {
        // Every transition has two sides; a request with one is a bug on the calling side,
        // and saying so beats compositing something against itself.
        return fail_agent(
            &app,
            &id,
            started,
            &AgentError::Malformed(
                "a composited transition needs a frame on both sides of the cut".into(),
            ),
        );
    };

    // The stills go to disk because ffmpeg reads files. Unlike the Higgsfield path — which
    // can drop them the moment the upload is answered — these have to survive until the
    // composite is done, so they are removed on every way out instead.
    let frames_dir = media_dir.join("frames");
    let frames = match (
        solcut_higgsfield::write_frame(&frames_dir, &format!("{id}-start"), &input.start_frame),
        solcut_higgsfield::write_frame(&frames_dir, &format!("{id}-end"), end_frame),
    ) {
        (Ok(start), Ok(end)) => (start, end),
        (start, end) => {
            for path in [start, end].into_iter().flatten() {
                let _ = std::fs::remove_file(path);
            }
            return fail_agent(
                &app,
                &id,
                started,
                &AgentError::Io("a frame at this cut could not be written to disk".into()),
            );
        }
    };

    let job = TransitionJob {
        request: MotionRequest {
            prompt: input.prompt.clone(),
            span_secs: input.span_ms.map(|ms| ms as f32 / 1000.0),
        },
        start_frame: frames.0.clone(),
        end_frame: frames.1.clone(),
        out: media_dir.join(format!("{id}.mp4")),
    };

    // No `queued` emitted here, unlike the Higgsfield path: `solcut_agent::transition` opens
    // with that step itself, and its own test pins the sequence. Emitting one on both sides
    // would send the card the same status twice for no reason.
    let progress_app = app.clone();
    let progress_id = id.clone();
    let cancel_app = app.clone();
    let cancel_id = id.clone();
    let result = solcut_agent::transition(
        &cli,
        &Renderer::default(),
        &ExportSpec::default(),
        &job,
        &move |step| {
            let mut update = GenerationUpdate::new(&progress_id, step.status, started.elapsed());
            update.progress = step.progress;
            emit(&progress_app, update);
        },
        &move || cancelled(&cancel_app, &cancel_id),
    )
    .await;

    let _ = std::fs::remove_file(&frames.0);
    let _ = std::fs::remove_file(&frames.1);

    match result {
        Ok(_) => {
            let mut update = GenerationUpdate::new(&id, "succeeded", started.elapsed());
            update.progress = 1.0;
            update.output_path = Some(job.out.display().to_string());
            emit(&app, update);
        }
        Err(AgentError::Cancelled) => {
            emit(
                &app,
                GenerationUpdate::new(&id, "cancelled", started.elapsed()),
            );
        }
        Err(e) => fail_agent(&app, &id, started, &e),
    }
}

/// One image generation: submit the prompt and any references, then watch the job.
///
/// Unlike the video path there are no temporary frames to write — the references are the
/// user's own files, and the CLI uploads a local path itself.
async fn run_image_generation(
    app: AppHandle,
    cli: Cli,
    media_dir: PathBuf,
    input: ImageGenerateInput,
    references: Vec<PathBuf>,
) {
    let started = Instant::now();
    let id = input.generation_id.clone();

    let model = input
        .model
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .unwrap_or(DEFAULT_IMAGE_MODEL)
        .to_string();
    let request = ImageRequest {
        model,
        prompt: input.prompt.clone(),
        references,
        aspect_ratio: input
            .aspect_ratio
            .as_deref()
            .map(str::trim)
            .filter(|a| !a.is_empty())
            .map(str::to_string),
    };

    emit(
        &app,
        GenerationUpdate::new(&id, "queued", started.elapsed()),
    );

    // `create` uploads every reference before it answers, so this is the slow part.
    let job_id = match cli.create_image(&request).await {
        Ok(job_id) => job_id,
        Err(e) => return fail(&app, &id, started, &e),
    };

    // Fourteen references is a long upload to cancel into: honour it here rather than
    // starting to watch a job the user has already given up on.
    if cancelled(&app, &id) {
        emit(
            &app,
            update_for(&id, "cancelled", started.elapsed(), &job_id),
        );
        return;
    }

    emit(&app, update_for(&id, "queued", started.elapsed(), &job_id));
    watch_job(app, cli, media_dir, id, job_id, started, Landing::Photo).await;
}

/// One prompt-only video generation: submit the words, then watch the job.
///
/// Nothing is uploaded, so unlike the other two paths there is no slow submit to cancel
/// into — but the check is kept anyway, because the CLI still validates the model against
/// the live catalog before it answers and that is a round trip the user can give up on.
///
/// **`Landing::Video` is the load-bearing argument.** `Landing::Photo` names its file from
/// the server's content type, which has no `video/mp4` entry and falls back to PNG; since
/// the media bin classifies by extension alone, routing a video result through it would
/// produce a photo that will not draw. See `Landing::video_dest`.
async fn run_video_generation(
    app: AppHandle,
    cli: Cli,
    media_dir: PathBuf,
    input: VideoGenerateInput,
) {
    let started = Instant::now();
    let id = input.generation_id.clone();

    let model = input
        .model
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .unwrap_or(DEFAULT_MODEL)
        .to_string();
    let request = VideoPromptRequest {
        model,
        prompt: input.prompt.clone(),
    };

    emit(
        &app,
        GenerationUpdate::new(&id, "queued", started.elapsed()),
    );

    let job_id = match cli.create_video_from_prompt(&request).await {
        Ok(job_id) => job_id,
        Err(e) => return fail(&app, &id, started, &e),
    };

    if cancelled(&app, &id) {
        emit(
            &app,
            update_for(&id, "cancelled", started.elapsed(), &job_id),
        );
        return;
    }

    emit(&app, update_for(&id, "queued", started.elapsed(), &job_id));
    watch_job(app, cli, media_dir, id, job_id, started, Landing::Video).await;
}

/// What a finished job's result URL turns into on disk — the one thing a video job and a
/// photo job still do differently once both are queued.
#[derive(Debug, Clone, Copy)]
enum Landing {
    /// An MP4 at `{media_dir}/{id}.mp4`.
    Video,
    /// A photo at `{media_dir}/{id}.{ext}`, the extension named by what the server
    /// actually served — the media bin classifies by extension and nothing else.
    Photo,
}

impl Landing {
    /// Where a video result is written.
    ///
    /// The name itself comes from `solcut_higgsfield::video_file_name`, which sits beside
    /// the photo path's `image_extension` precisely so the two can be read — and asserted —
    /// as the one rule they are. See that function for what goes wrong otherwise.
    fn video_dest(media_dir: &std::path::Path, id: &str) -> PathBuf {
        media_dir.join(solcut_higgsfield::video_file_name(id))
    }

    async fn fetch(
        self,
        cli: &Cli,
        media_dir: &std::path::Path,
        id: &str,
        url: &str,
    ) -> Result<PathBuf, HiggsfieldError> {
        match self {
            Self::Video => {
                let dest = Self::video_dest(media_dir, id);
                cli.download(url, &dest).await?;
                Ok(dest)
            }
            Self::Photo => cli.download_image(url, media_dir, id).await,
        }
    }
}

/// Watch an accepted job to a terminal state, reporting every step on
/// `generation:update` — shared verbatim by both kinds of generation.
async fn watch_job(
    app: AppHandle,
    cli: Cli,
    media_dir: PathBuf,
    id: String,
    job_id: String,
    started: Instant,
    landing: Landing,
) {
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
            Ok(JobState::Succeeded { result_url }) => {
                match landing.fetch(&cli, &media_dir, &id, &result_url).await {
                    Ok(dest) => {
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

fn fail_agent(app: &AppHandle, id: &str, started: Instant, error: &AgentError) {
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
            let imported_dir = app.path().app_data_dir()?.join("imported");
            // Not created here, and not failed over either: a box with no documents
            // directory still has a config directory, and a first project has to land
            // somewhere. `new_project_path` makes the folder when it actually uses it.
            let documents_dir = app
                .path()
                .document_dir()
                .unwrap_or_else(|_| config_dir.clone());
            std::fs::create_dir_all(&config_dir)?;
            std::fs::create_dir_all(&media_dir)?;
            app.manage(AppState {
                config_dir,
                media_dir,
                imported_dir,
                documents_dir,
                cancelled: Mutex::new(HashSet::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            load_project,
            read_project,
            last_project_path,
            save_project,
            recent_projects,
            new_project_path,
            create_project,
            test_connection,
            test_api_key,
            import_media,
            probe_media,
            supported_extensions,
            cloud_libraries,
            generate_animation,
            generate_image,
            generate_video,
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

    /// The frame is the project's now, so a still has to be able to take a size — and has
    /// to refuse the one size that would silently produce the wrong shape.
    #[test]
    fn a_still_takes_the_projects_frame_and_refuses_a_zero_edge() {
        assert_eq!(still_edge(Some(1080), solcut_render::STILL_WIDTH), 1080);
        assert_eq!(still_edge(Some(1280), solcut_render::STILL_HEIGHT), 1280);
        // No size asked for: the 16:9 still every caller got before the frame could move.
        assert_eq!(
            still_edge(None, solcut_render::STILL_WIDTH),
            solcut_render::STILL_WIDTH
        );
        // `scale=0:720` means "keep the source's width" to ffmpeg, which is not a frame.
        assert_eq!(
            still_edge(Some(0), solcut_render::STILL_HEIGHT),
            solcut_render::STILL_HEIGHT
        );
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

    #[test]
    fn a_request_that_names_no_backend_is_still_higgsfield() {
        // The field is new, and a request that predates it — an older frontend, a replayed
        // payload — has to keep meaning what it meant. Absent is Higgsfield, exactly as
        // absent is the default model.
        let input: GenerateInput = serde_json::from_str(
            r#"{"generationId":"gen_1","prompt":"drift","startFrame":"data:image/jpeg;base64,AA=="}"#,
        )
        .expect("a request from before providers existed");
        assert!(input.provider.is_none());
        assert!(input.span_ms.is_none());
        assert!(matches!(
            Backend::parse(input.provider.as_deref()),
            Ok(Backend::Higgsfield)
        ));
    }

    #[test]
    fn an_unknown_backend_is_refused_rather_than_quietly_charged_to_higgsfield() {
        // The whole point of refusing instead of defaulting: a stale or misspelled id
        // falling back to Higgsfield would start a paid render for a cut the user asked a
        // local backend to make, and the only sign would be the bill.
        assert!(matches!(
            Backend::parse(Some("claude-code")),
            Ok(Backend::Agent(Agent::ClaudeCode))
        ));
        assert!(matches!(
            Backend::parse(Some("codex")),
            Ok(Backend::Agent(Agent::Codex))
        ));
        assert!(matches!(
            Backend::parse(Some("  ")),
            Ok(Backend::Higgsfield)
        ));

        let refused = Backend::parse(Some("claude")).expect_err("an id nothing knows");
        assert!(refused.contains("claude"), "{refused}");
    }

    #[test]
    fn an_agent_failure_reaches_the_card_in_the_same_shape_a_higgsfield_one_does() {
        // The error card renders one shape. If an agent failure arrived as anything else the
        // UI would need a second branch, and the one it has would be the tested one.
        let error = GenerationError::from(&AgentError::NotInstalled(Agent::ClaudeCode));
        let json = serde_json::to_value(&error).expect("serialize");
        assert_eq!(json["build"], BUILD);
        assert_eq!(json["retryable"], false);
        assert!(json["message"]
            .as_str()
            .expect("a message")
            .contains("npm install -g @anthropic-ai/claude-code"));
    }

    /// The compose panel's two shapes: a prompt on its own, and a prompt working on top
    /// of the user's own photos. Every optional field has to survive being left out, or
    /// the plainest possible generation fails to deserialize.
    #[test]
    fn an_image_input_carries_a_prompt_alone_or_a_prompt_and_references() {
        let bare: ImageGenerateInput =
            serde_json::from_str(r#"{"generationId":"gen_1","prompt":"a quiet beach"}"#)
                .expect("a prompt on its own");
        assert!(bare.references.is_empty());
        assert!(bare.model.is_none());
        assert!(bare.aspect_ratio.is_none());

        let full: ImageGenerateInput = serde_json::from_str(
            r#"{"generationId":"gen_2","prompt":"on top of these","references":["/p/a.png","/p/b.jpg"],"model":"nano_banana_2","aspectRatio":"16:9"}"#,
        )
        .expect("a prompt with references");
        assert_eq!(full.references, vec!["/p/a.png", "/p/b.jpg"]);
        assert_eq!(full.model.as_deref(), Some("nano_banana_2"));
        assert_eq!(full.aspect_ratio.as_deref(), Some("16:9"));
    }

    /// The create sheet's video shape: the words, and at most a model.
    #[test]
    fn a_video_input_needs_nothing_but_a_prompt() {
        let bare: VideoGenerateInput =
            serde_json::from_str(r#"{"generationId":"gen_1","prompt":"a drone over the surf"}"#)
                .expect("a prompt on its own");
        assert!(bare.model.is_none());

        let full: VideoGenerateInput = serde_json::from_str(
            r#"{"generationId":"gen_2","prompt":"a drone over the surf","model":"seedance_2_5"}"#,
        )
        .expect("a prompt and a model");
        assert_eq!(full.model.as_deref(), Some("seedance_2_5"));
    }

    /// A video result is named `.mp4` by the landing itself, never by what the server said
    /// it served.
    ///
    /// This is the assertion that stops the quiet version of this bug. The photo landing
    /// asks `image_extension` for the extension, which knows no video type and answers
    /// `png`; the bin then classifies by extension alone, so the file would return from
    /// the next launch as a photo that cannot draw. `solcut-higgsfield` has the other half
    /// of this test — that the photo path really would say `png` — so the two together
    /// document why the video path does not go near it.
    #[test]
    fn a_video_result_is_named_mp4_whatever_the_server_called_it() {
        let dest = Landing::video_dest(Path::new("/data/generated"), "gen_7");
        assert_eq!(dest, PathBuf::from("/data/generated/gen_7.mp4"));
        assert_eq!(dest.extension().and_then(|e| e.to_str()), Some("mp4"));
    }
}
