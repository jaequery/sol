//! Higgsfield generation through the official CLI.
//!
//! Deliberately free of Tauri, GUI and platform dependencies so it compiles and tests on
//! any machine — the desktop shell in `src-tauri/` is a thin wrapper over this.
//!
//! Everything here drives `higgsfield`, the official CLI (`npm i -g @higgsfield/cli`,
//! <https://github.com/higgsfield-ai/cli>), instead of the token-metered API platform:
//! the CLI authenticates against the user's higgsfield.ai account (`higgsfield auth
//! login`) and bills its billing workspace — the subscription — and it resolves model ids
//! against the live catalog, so there is no REST route to guess and get a 404 from.
//!
//! Two kinds of job go through it, and they share everything but their first and last
//! step: a **video transition** between two stills, and a **photo** from a prompt and any
//! number of the user's own images as references.
//!
//! 1. [`Cli::find`] locates the binary on `PATH` (or in the usual install prefixes,
//!    which a GUI-launched app does not always have on its `PATH`).
//! 2. [`Cli::create`] runs `generate create <model> --prompt … --start-image …
//!    --end-image … --json`. The CLI uploads the two stills itself — a local file path
//!    is a documented media input — and answers with the job id.
//!    [`Cli::create_image`] is its photo twin: `generate create <image model> --prompt …
//!    --image … --aspect_ratio … --json`, with `--image` repeated once per reference.
//! 3. [`Cli::job_state`] reads `generate get <job_id> --json` until a terminal state.
//!    [`Cli::download`] fetches a finished MP4 to a known path, and
//!    [`Cli::download_image`] fetches a finished photo to a path it names from the
//!    response's own content type — the extension is what the media bin classifies by.
//! 4. [`Cli::probe`] is the Settings dialog's connection check: `model list --video
//!    --json`, which proves the binary, the login and the workspace in one free call.
//!    It proves the image path too: same binary, same login, same billing workspace.
//!
//! The [`credential`] module is the one part that does not go through the CLI: it holds
//! the *Cloud API* key SolCut stores (a different credential, on a different host, against
//! a different balance) and the free call that proves it. Nothing renders through it.

mod credential;
mod error;
mod parse;

pub use credential::{
    check_credential, classify, mask, Credential, KeyVerdict, API_BASE_URL, AUTH_SCHEME,
};
pub use error::{HiggsfieldError, JobState, Result};
pub use parse::{find_result_url, parse_create, parse_job, parse_model_count};

use base64::Engine as _;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

/// The default model: Seedance 2.5, under the id Higgsfield's own site opens it with
/// (`higgsfield.ai/ai/video?model=seedance_2_5`). The CLI checks the id against the live
/// catalog, so a wrong id fails by name instead of by 404.
pub const DEFAULT_MODEL: &str = "seedance_2_5";

/// The default **image** job type: Nano Banana Pro, which takes a prompt and up to
/// fourteen of the user's own photos as references. A separate constant from
/// [`DEFAULT_MODEL`], which is a video job type and cannot make a photo.
pub const DEFAULT_IMAGE_MODEL: &str = "nano_banana_2";

/// The binary the official npm package installs.
pub const CLI_BINARY: &str = "higgsfield";

/// What a photo may arrive as to be sent on as a reference.
///
/// Narrower than the media bin's own photo list on purpose: the bin also accepts `bmp`,
/// `gif` and `avif`, and handing one of those to Higgsfield's uploader would fail on
/// their side, far from the click that caused it.
pub const REFERENCE_IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "webp"];

/// What a downloaded photo is called when neither the response nor the URL says.
const FALLBACK_IMAGE_EXT: &str = "png";

/// `generate create` uploads both stills before it answers, so it gets the long budget.
const CREATE_TIMEOUT: Duration = Duration::from_secs(300);
/// A status read is one request; anything this slow is stuck.
const STATUS_TIMEOUT: Duration = Duration::from_secs(60);
const PROBE_TIMEOUT: Duration = Duration::from_secs(60);

/// How many times a spawn that lost the `ETXTBSY` race is retried, and how long it waits
/// between goes. Both small: the condition clears as soon as the writer lets go, and the
/// run's own timeout still bounds the whole thing.
const SPAWN_RETRIES: u32 = 5;
const SPAWN_RETRY_DELAY: Duration = Duration::from_millis(40);

/// Whether an io error is `ETXTBSY`, "text file busy" — the binary cannot be executed
/// because someone holds it open for writing.
///
/// `ErrorKind` has no variant for it on stable, so it is matched by errno. Unix only;
/// Windows refuses a busy executable with a sharing violation instead, which is not
/// transient in the same way and is left to report itself.
fn is_text_file_busy(error: &std::io::Error) -> bool {
    cfg!(unix) && error.raw_os_error() == Some(26)
}

/// One "animate from this frame to that frame" job.
///
/// There is deliberately no duration here: the models publish fixed choices, the CLI
/// defaults them, and the editor fits whatever comes back into the segment it replaces.
#[derive(Debug, Clone)]
pub struct GenerateRequest {
    /// The CLI job type, e.g. `seedance_2_5`.
    pub model: String,
    pub prompt: String,
    /// The still the motion starts from, as a local file the CLI uploads itself.
    pub start_image: PathBuf,
    /// The same for the still the motion ends on. Supplied, it pins where the motion
    /// lands — which is what makes a transition a transition.
    pub end_image: Option<PathBuf>,
}

/// The argv for `generate create`, kept as its own function so the exact invocation is
/// unit-testable without spawning anything. `--json`/`--no-color` ride on every run.
pub fn build_create_args(req: &GenerateRequest) -> Vec<String> {
    let mut args = vec![
        "generate".to_string(),
        "create".to_string(),
        req.model.clone(),
        "--prompt".to_string(),
        req.prompt.clone(),
        "--start-image".to_string(),
        req.start_image.display().to_string(),
    ];
    if let Some(end) = &req.end_image {
        args.push("--end-image".to_string());
        args.push(end.display().to_string());
    }
    // Seedance 2.5 gates frame inputs behind its reference mode: the live API refuses
    // `start_image`/`end_image` outside it, in exactly these words — "start_image and
    // end_image are only allowed for mode 'omni_reference'". SolCut always sends a start
    // frame, so the mode rides along whenever this model renders. Other models keep
    // their own default mode; `omni_reference` is not in their published value sets.
    if req.model == DEFAULT_MODEL {
        args.push("--mode".to_string());
        args.push("omni_reference".to_string());
    }
    args
}

/// One "make me a video out of nothing but these words" job.
///
/// The other video job in this file, [`GenerateRequest`], is a *transition*: it pins the
/// motion between two stills the editor already has. This one has no stills at all — the
/// model invents the whole shot from the prompt — which is why it is a separate request
/// type with a separate builder rather than a [`GenerateRequest`] whose frames are
/// `None`. See [`build_video_prompt_args`] for the part that actually matters.
#[derive(Debug, Clone)]
pub struct VideoPromptRequest {
    /// The CLI job type, e.g. `seedance_2_5`.
    pub model: String,
    pub prompt: String,
}

/// The argv for a prompt-only video `generate create`.
///
/// Deliberately a third builder rather than a branch of either existing one, for the same
/// reason [`build_image_create_args`] is not a branch of [`build_create_args`]: each of
/// the other two injects a flag that is wrong here, and sharing the function would leak
/// that flag into this job.
///
/// **The `--mode` omission is the whole point of this function.** [`build_create_args`]
/// sends `--mode omni_reference` whenever the model is [`DEFAULT_MODEL`], because the live
/// API refuses frame inputs outside that mode in exactly these words: "start_image and
/// end_image are only allowed for mode 'omni_reference'". That flag exists to *unlock
/// frame inputs* and for nothing else — so a job sending no frames must not ask for it,
/// even on Seedance 2.5.
pub fn build_video_prompt_args(req: &VideoPromptRequest) -> Vec<String> {
    // Every token here is load-bearing and there are no optional ones: a prompt-only job
    // is the model id and the words, and anything further would be this function guessing.
    vec![
        "generate".to_string(),
        "create".to_string(),
        req.model.clone(),
        "--prompt".to_string(),
        req.prompt.clone(),
    ]
}

/// One "make me a photo" job: a prompt, and any number of the user's own images to work
/// from. Zero references is a plain text-to-image generation; one or more is the same
/// generation done *on top of* those photos.
#[derive(Debug, Clone)]
pub struct ImageRequest {
    /// The CLI job type, e.g. `nano_banana_2`.
    pub model: String,
    pub prompt: String,
    /// Local files the CLI uploads itself. Validated by [`validate_references`] before a
    /// request is built, so a photo that moved is named here rather than by the CLI.
    pub references: Vec<PathBuf>,
    /// e.g. `16:9`. Each model publishes its own set; the caller sends one the chosen
    /// model accepts, or `None` to take the model's default.
    pub aspect_ratio: Option<String>,
}

/// The argv for an image `generate create`, kept separate from [`build_create_args`] and
/// unit-testable without spawning anything.
///
/// Deliberately **not** a branch of the video builder: that one injects
/// `--mode omni_reference` for Seedance 2.5, a rule that exists only because that video
/// model gates frame inputs behind it. Sharing the function would leak the rule into
/// image jobs, whose published mode sets do not contain that value.
///
/// `--image` is the documented alias of `--image-references` and repeats once per
/// reference; `--json`/`--no-color` are not here because [`Cli::run`] appends them.
pub fn build_image_create_args(req: &ImageRequest) -> Vec<String> {
    let mut args = vec![
        "generate".to_string(),
        "create".to_string(),
        req.model.clone(),
        "--prompt".to_string(),
        req.prompt.clone(),
    ];
    for reference in &req.references {
        args.push("--image".to_string());
        args.push(reference.display().to_string());
    }
    if let Some(aspect) = req
        .aspect_ratio
        .as_deref()
        .map(str::trim)
        .filter(|a| !a.is_empty())
    {
        args.push("--aspect_ratio".to_string());
        args.push(aspect.to_string());
    }
    args
}

/// Turn the paths the editor named into files that can actually be sent, or say which
/// one cannot and why.
///
/// Refusing here is the point: a media-bin photo can carry an empty path (a browser drop
/// never had one) or point at a file that has since moved, and either would reach
/// Higgsfield as a upload failure with no idea which photo it was about.
pub fn validate_references(paths: &[String]) -> Result<Vec<PathBuf>> {
    let mut files = Vec::with_capacity(paths.len());
    for raw in paths {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err(HiggsfieldError::BadReference(
                "a reference photo has no file on disk — import it from a file, not a browser drop"
                    .into(),
            ));
        }
        let path = PathBuf::from(trimmed);
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| trimmed.to_string());

        let extension = path
            .extension()
            .map(|e| e.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        if !REFERENCE_IMAGE_EXTS.contains(&extension.as_str()) {
            return Err(HiggsfieldError::BadReference(format!(
                "{name} is not a reference photo Higgsfield takes — use a {} file",
                REFERENCE_IMAGE_EXTS.join(", ")
            )));
        }
        if !path.is_file() {
            return Err(HiggsfieldError::BadReference(format!(
                "{name} is no longer on disk"
            )));
        }
        files.push(path);
    }
    Ok(files)
}
/// What a generated **video** is called on disk: the job id and `.mp4`, always.
///
/// The counterpart to [`image_extension`], and deliberately its neighbour, because the two
/// together are one rule with a trap in the middle of it. A photo's extension comes from
/// what the server actually served; a video's does **not**, and must not, because
/// [`image_extension`] knows no video content type and answers `png` for every one of them
/// (there is a test to that effect). Since the media bin classifies media by extension and
/// nothing else, a video landed through the photo path would come back from the next launch
/// as a photo that cannot draw.
///
/// It lives in this crate rather than beside its one caller in the Tauri shell so that it
/// can be asserted on any machine — the shell's own tests need a GUI toolchain to link,
/// which is exactly the gap this crate exists to cover.
pub fn video_file_name(id: &str) -> String {
    format!("{id}.mp4")
}

/// What to call a downloaded photo, from the response's own content type and, failing
/// that, the URL.
///
/// This is load-bearing rather than cosmetic: the media bin classifies a file by its
/// **extension alone**, and a restored project re-imports every stored path at launch —
/// so a PNG saved under the wrong extension comes back as the wrong kind of media, or as
/// missing. A result URL is signed, so its query string is dropped before the extension
/// is read, and anything unrecognised falls back to png rather than to nothing.
pub fn image_extension(content_type: Option<&str>, url: &str) -> &'static str {
    if let Some(ext) = content_type
        .and_then(|value| value.split(';').next())
        .map(|value| value.trim().to_ascii_lowercase())
        .and_then(|value| {
            SUPPORTED_IMAGE_TYPES
                .iter()
                .find(|(t, _)| *t == value)
                .map(|(_, ext)| *ext)
        })
    {
        return ext;
    }

    url.split('#')
        .next()
        .and_then(|no_fragment| no_fragment.split('?').next())
        .and_then(|path| path.rsplit('/').next())
        .and_then(|file| file.rsplit_once('.'))
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .and_then(|ext| {
            let ext = if ext == "jpeg" {
                "jpg".to_string()
            } else {
                ext
            };
            SUPPORTED_IMAGE_TYPES
                .iter()
                .find(|(_, known)| **known == ext)
                .map(|(_, known)| *known)
        })
        .unwrap_or(FALLBACK_IMAGE_EXT)
}

/// A located `higgsfield` binary and the operations SolCut needs from it.
#[derive(Debug, Clone)]
pub struct Cli {
    binary: PathBuf,
}

impl Cli {
    /// The CLI wherever it is installed, or `None` — which the UI reports as "not
    /// installed" with the install command, rather than failing at render time.
    pub fn find() -> Option<Self> {
        find_binary().map(Self::new)
    }

    pub fn new(binary: PathBuf) -> Self {
        Self { binary }
    }

    pub fn binary(&self) -> &Path {
        &self.binary
    }

    /// Submit one generation. The CLI uploads the frames and answers with the job id.
    pub async fn create(&self, req: &GenerateRequest) -> Result<String> {
        let stdout = self.run(&build_create_args(req), CREATE_TIMEOUT).await?;
        parse_create(&stdout)
    }

    /// Submit one image generation. The CLI uploads any references and answers with the
    /// job id; from there it is watched exactly like a video job.
    pub async fn create_image(&self, req: &ImageRequest) -> Result<String> {
        let stdout = self
            .run(&build_image_create_args(req), CREATE_TIMEOUT)
            .await?;
        parse_create(&stdout)
    }

    /// Submit one prompt-only video generation — a shot made from words alone, with no
    /// frame on either end of it.
    ///
    /// Named for what it is rather than `create_video`, because [`Cli::create`] also
    /// creates a video and a reader should not have to open both to tell them apart.
    /// Nothing is uploaded, so this answers as fast as the CLI can queue the job.
    pub async fn create_video_from_prompt(&self, req: &VideoPromptRequest) -> Result<String> {
        let stdout = self
            .run(&build_video_prompt_args(req), CREATE_TIMEOUT)
            .await?;
        parse_create(&stdout)
    }

    /// Where a job has got to, by asking `generate get`.
    pub async fn job_state(&self, job_id: &str) -> Result<JobState> {
        let args = [
            "generate".to_string(),
            "get".to_string(),
            job_id.to_string(),
        ];
        let stdout = self.run(&args, STATUS_TIMEOUT).await?;
        parse_job(&stdout)
    }

    /// Connection check for the Settings dialog: list the video models.
    ///
    /// One free, read-only call that proves the binary runs, the login is live and a
    /// billing workspace is selected — and whose failure message (the CLI's own words)
    /// names the fix. Returns the number of models when the listing is countable.
    pub async fn probe(&self) -> Result<Option<usize>> {
        let args = [
            "model".to_string(),
            "list".to_string(),
            "--video".to_string(),
        ];
        let stdout = self.run(&args, PROBE_TIMEOUT).await?;
        Ok(parse_model_count(&stdout))
    }

    /// Run the CLI once and hand back its stdout.
    ///
    /// A non-zero exit becomes [`HiggsfieldError::Cli`] carrying the CLI's own stderr —
    /// its refusals name their fix (`auth login`, `workspace set`, an unknown model id).
    /// Overrunning the budget kills the process and reports what was being asked.
    async fn run(&self, args: &[String], timeout: Duration) -> Result<String> {
        let what = args
            .iter()
            .take(2)
            .map(String::as_str)
            .collect::<Vec<_>>()
            .join(" ");

        let deadline = tokio::time::Instant::now() + timeout;
        let mut attempt = 0;
        let output = loop {
            let mut command = tokio::process::Command::new(&self.binary);
            command
                .args(args)
                .arg("--json")
                .arg("--no-color")
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);

            let spawned = tokio::time::timeout_at(deadline, command.output())
                .await
                .map_err(|_| HiggsfieldError::Timeout {
                    what: what.clone(),
                    secs: timeout.as_secs(),
                })?;

            match spawned {
                Ok(output) => break output,
                // `ETXTBSY` — the binary has a writer. It is transient by construction:
                // `npm i -g @higgsfield/cli` replacing the CLI underneath us hits it, and
                // so does any fork in a neighbouring thread that momentarily inherited a
                // write handle to it. Retrying is the whole fix; failing here would report
                // a perfectly good install as unrunnable.
                Err(e) if is_text_file_busy(&e) && attempt < SPAWN_RETRIES => {
                    attempt += 1;
                    tokio::time::sleep(SPAWN_RETRY_DELAY).await;
                }
                Err(e) => {
                    return Err(match e.kind() {
                        std::io::ErrorKind::NotFound => HiggsfieldError::NotInstalled,
                        _ => HiggsfieldError::Io(format!("could not run the Higgsfield CLI: {e}")),
                    })
                }
            }
        };

        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        if output.status.success() {
            return Ok(stdout);
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        let message = match stderr.trim() {
            "" => match stdout.trim() {
                "" => format!("`{CLI_BINARY} {what}` failed without saying why"),
                out => preview(out),
            },
            err => preview(err),
        };
        Err(HiggsfieldError::Cli { message })
    }

    /// Stream the finished video to `dest`, returning the bytes written.
    ///
    /// The result URL is storage, not a metered API: a plain GET, no credential.
    pub async fn download(&self, url: &str, dest: &Path) -> Result<u64> {
        let response = fetch(url).await?;
        write_response(response, dest).await
    }

    /// Stream a finished photo into `dir`, naming it `{stem}.{ext}` where the extension
    /// comes from what the server actually served — see [`image_extension`]. Returns the
    /// path written, because the caller cannot know it in advance.
    pub async fn download_image(&self, url: &str, dir: &Path, stem: &str) -> Result<PathBuf> {
        let response = fetch(url).await?;
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let dest = dir.join(format!(
            "{stem}.{}",
            image_extension(content_type.as_deref(), url)
        ));
        write_response(response, &dest).await?;
        Ok(dest)
    }
}

/// GET a result URL, refusing anything but a success before a byte is written.
async fn fetch(url: &str) -> Result<reqwest::Response> {
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()?;
    let response = http.get(url).send().await?;
    if !response.status().is_success() {
        return Err(HiggsfieldError::Http {
            status: response.status().as_u16(),
            body: "could not download the generated file".into(),
        });
    }
    Ok(response)
}

/// Stream a fetched body to `dest`, returning the bytes written.
async fn write_response(response: reqwest::Response, dest: &Path) -> Result<u64> {
    use tokio::io::AsyncWriteExt as _;

    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| HiggsfieldError::Io(e.to_string()))?;
    }

    // Write beside the target and rename, so a cancelled download never leaves a
    // truncated file that the timeline would happily try to play.
    let tmp = dest.with_extension("part");
    let mut file = tokio::fs::File::create(&tmp)
        .await
        .map_err(|e| HiggsfieldError::Io(e.to_string()))?;

    let mut written = 0u64;
    let mut stream = response;
    while let Some(chunk) = stream
        .chunk()
        .await
        .map_err(|e| HiggsfieldError::Transport(e.to_string()))?
    {
        file.write_all(&chunk)
            .await
            .map_err(|e| HiggsfieldError::Io(e.to_string()))?;
        written += chunk.len() as u64;
    }
    file.flush()
        .await
        .map_err(|e| HiggsfieldError::Io(e.to_string()))?;
    drop(file);

    tokio::fs::rename(&tmp, dest)
        .await
        .map_err(|e| HiggsfieldError::Io(e.to_string()))?;
    Ok(written)
}

// ---------------------------------------------------------------- binary discovery

/// The `higgsfield` binary: `PATH` first, then the prefixes npm and Homebrew install
/// into — a GUI-launched app on macOS gets launchd's `PATH`, which has neither.
pub fn find_binary() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            if let Some(found) = executable_in(&dir) {
                return Some(found);
            }
        }
    }
    fallback_dirs().iter().find_map(|dir| executable_in(dir))
}

fn executable_in(dir: &Path) -> Option<PathBuf> {
    binary_names()
        .iter()
        .map(|name| dir.join(name))
        .find(|candidate| is_executable(candidate))
}

fn binary_names() -> &'static [&'static str] {
    #[cfg(windows)]
    {
        &["higgsfield.cmd", "higgsfield.exe"]
    }
    #[cfg(not(windows))]
    {
        &[CLI_BINARY]
    }
}

/// Where `npm i -g` and Homebrew put binaries when the launching environment's `PATH`
/// does not say.
fn fallback_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join(".npm-global/bin"));
    }
    dirs
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

// ---------------------------------------------------------------- frame files

/// The image content types a frame may arrive as.
const SUPPORTED_IMAGE_TYPES: &[(&str, &str)] = &[
    ("image/jpeg", "jpg"),
    ("image/jpg", "jpg"),
    ("image/png", "png"),
    ("image/webp", "webp"),
    ("image/gif", "gif"),
];

/// The inverse of [`decode_data_url`] for a JPEG: what a frame grabbed off a video has to
/// become before it can travel the same road a photo's still already travels.
pub fn jpeg_data_url(bytes: &[u8]) -> String {
    format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

/// Split `data:image/jpeg;base64,…` into its content type and bytes.
pub fn decode_data_url(url: &str) -> Result<(String, Vec<u8>)> {
    let rest = url
        .strip_prefix("data:")
        .ok_or_else(|| HiggsfieldError::Malformed("a frame is not a data URL".into()))?;
    let (meta, payload) = rest
        .split_once(',')
        .ok_or_else(|| HiggsfieldError::Malformed("a frame data URL has no payload".into()))?;

    let content_type = meta.split(';').next().unwrap_or("").to_ascii_lowercase();
    if !SUPPORTED_IMAGE_TYPES
        .iter()
        .any(|(t, _)| *t == content_type)
    {
        return Err(HiggsfieldError::Malformed(format!(
            "{content_type:?} is not an image type a frame can be"
        )));
    }
    if !meta.contains("base64") {
        return Err(HiggsfieldError::Malformed(
            "a frame data URL must be base64-encoded".into(),
        ));
    }

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|e| HiggsfieldError::Malformed(format!("undecodable frame data URL: {e}")))?;
    Ok((content_type, bytes))
}

/// Write a frame's data URL to `{dir}/{stem}.{ext}` so the CLI can upload it, returning
/// the path to pass as `--start-image`/`--end-image`.
pub fn write_frame(dir: &Path, stem: &str, data_url: &str) -> Result<PathBuf> {
    let (content_type, bytes) = decode_data_url(data_url)?;
    let ext = SUPPORTED_IMAGE_TYPES
        .iter()
        .find(|(t, _)| *t == content_type)
        .map(|(_, ext)| *ext)
        .unwrap_or("jpg");

    std::fs::create_dir_all(dir).map_err(|e| HiggsfieldError::Io(e.to_string()))?;
    let path = dir.join(format!("{stem}.{ext}"));
    std::fs::write(&path, bytes).map_err(|e| HiggsfieldError::Io(e.to_string()))?;
    Ok(path)
}

pub(crate) fn preview(body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.chars().count() <= 200 {
        return trimmed.to_string();
    }
    let head: String = trimmed.chars().take(200).collect();
    format!("{head}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> GenerateRequest {
        GenerateRequest {
            model: DEFAULT_MODEL.into(),
            prompt: "slow dolly-in".into(),
            start_image: PathBuf::from("/tmp/a.jpg"),
            end_image: Some(PathBuf::from("/tmp/b.jpg")),
        }
    }

    #[test]
    fn the_default_model_is_seedance_2_5() {
        assert_eq!(DEFAULT_MODEL, "seedance_2_5");
    }

    #[test]
    fn the_create_argv_is_the_documented_invocation() {
        assert_eq!(
            build_create_args(&request()),
            vec![
                "generate",
                "create",
                "seedance_2_5",
                "--prompt",
                "slow dolly-in",
                "--start-image",
                "/tmp/a.jpg",
                "--end-image",
                "/tmp/b.jpg",
                "--mode",
                "omni_reference",
            ]
        );
    }

    #[test]
    fn a_single_frame_sends_no_end_image() {
        let mut req = request();
        req.end_image = None;
        let args = build_create_args(&req);
        assert!(!args.iter().any(|a| a == "--end-image"), "{args:?}");
        assert!(args.iter().any(|a| a == "--start-image"));
    }

    /// The regression behind "start_image and end_image are only allowed for mode
    /// 'omni_reference'" on every default render: Seedance 2.5 accepts frames only in
    /// its reference mode, so the default model must ask for it — and only the default
    /// model, because the other models' published mode sets do not contain it.
    #[test]
    fn seedance_2_5_asks_for_its_reference_mode_and_other_models_do_not() {
        let args = build_create_args(&request());
        let at = args.iter().position(|a| a == "--mode").expect("a mode");
        assert_eq!(args[at + 1], "omni_reference");

        // A single-frame render still sends a start image, so the mode still applies.
        let mut single = request();
        single.end_image = None;
        assert!(build_create_args(&single).iter().any(|a| a == "--mode"));

        for other in ["seedance_2_0", "seedance1_5", "kling3_0", "veo3_1_lite"] {
            let mut req = request();
            req.model = other.into();
            let args = build_create_args(&req);
            assert!(!args.iter().any(|a| a == "--mode"), "{other}: {args:?}");
        }
    }

    #[test]
    fn the_prompt_travels_as_one_argument_never_through_a_shell() {
        let mut req = request();
        req.prompt = "pan; rm -rf / `boom` $(x)".into();
        let args = build_create_args(&req);
        let at = args.iter().position(|a| a == "--prompt").unwrap();
        assert_eq!(args[at + 1], "pan; rm -rf / `boom` $(x)");
    }

    #[test]
    fn a_captured_jpeg_round_trips_through_a_data_url() {
        // A video's anchor frame arrives as bytes and has to reach `write_frame` looking
        // exactly like a photo's still does.
        let bytes = [0xff, 0xd8, 0xff, 0xe0, 0x00];
        let (content_type, back) = decode_data_url(&jpeg_data_url(&bytes)).expect("round trip");
        assert_eq!(content_type, "image/jpeg");
        assert_eq!(back, bytes);
    }

    #[test]
    fn jpeg_bytes_round_trip_through_a_data_url() {
        let b64 = base64::engine::general_purpose::STANDARD.encode([0xff, 0xd8, 0xff]);
        let (content_type, bytes) =
            decode_data_url(&format!("data:image/jpeg;base64,{b64}")).expect("decode");
        assert_eq!(content_type, "image/jpeg");
        assert_eq!(bytes, vec![0xff, 0xd8, 0xff]);
    }

    #[test]
    fn an_unsupported_frame_type_is_refused_before_it_is_written() {
        let err = decode_data_url("data:image/tiff;base64,AAAA").unwrap_err();
        assert!(matches!(err, HiggsfieldError::Malformed(_)), "{err:?}");
    }

    #[test]
    fn a_frame_lands_on_disk_under_its_own_type() {
        let dir = std::env::temp_dir().join(format!("solcut-frames-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        let b64 = base64::engine::general_purpose::STANDARD.encode([1, 2, 3]);
        let path = write_frame(&dir, "gen_1-start", &format!("data:image/png;base64,{b64}"))
            .expect("write");
        assert_eq!(path, dir.join("gen_1-start.png"));
        assert_eq!(std::fs::read(&path).unwrap(), vec![1, 2, 3]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn long_error_bodies_are_truncated() {
        let long = "x".repeat(5_000);
        assert!(preview(&long).chars().count() <= 201);
    }

    #[cfg(unix)]
    #[test]
    fn binary_discovery_finds_an_executable_and_skips_a_plain_file() {
        use std::os::unix::fs::PermissionsExt as _;

        let dir = std::env::temp_dir().join(format!("solcut-which-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let plain = dir.join(CLI_BINARY);
        std::fs::write(&plain, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&plain, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(executable_in(&dir), None, "a non-executable file is not it");

        std::fs::set_permissions(&plain, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(executable_in(&dir), Some(plain));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The retry has to fire for `ETXTBSY` and for nothing else — a missing binary or a
    /// permission problem is a real answer, and retrying it five times would only delay
    /// reporting it.
    #[test]
    fn only_a_busy_binary_is_worth_another_spawn() {
        use std::io::{Error, ErrorKind};

        assert_eq!(
            is_text_file_busy(&Error::from_raw_os_error(26)),
            cfg!(unix),
            "ETXTBSY is the transient one"
        );
        assert!(!is_text_file_busy(&Error::from(ErrorKind::NotFound)));
        assert!(!is_text_file_busy(&Error::from(
            ErrorKind::PermissionDenied
        )));
        assert!(!is_text_file_busy(&Error::from_raw_os_error(2)));
    }

    // ------------------------------------------------------------ image generation

    fn image_request() -> ImageRequest {
        ImageRequest {
            model: DEFAULT_IMAGE_MODEL.into(),
            prompt: "a quiet beach at sunrise".into(),
            references: vec![],
            aspect_ratio: Some("16:9".into()),
        }
    }

    #[test]
    fn the_default_image_model_is_nano_banana_pro() {
        assert_eq!(DEFAULT_IMAGE_MODEL, "nano_banana_2");
        assert_ne!(
            DEFAULT_IMAGE_MODEL, DEFAULT_MODEL,
            "a video model cannot make a photo"
        );
    }

    #[test]
    fn a_prompt_alone_is_a_whole_image_request() {
        let mut req = image_request();
        req.aspect_ratio = None;
        assert_eq!(
            build_image_create_args(&req),
            vec![
                "generate",
                "create",
                "nano_banana_2",
                "--prompt",
                "a quiet beach at sunrise",
            ]
        );
    }

    #[test]
    fn every_reference_rides_as_its_own_image_flag() {
        let mut req = image_request();
        req.references = vec![PathBuf::from("/tmp/a.png"), PathBuf::from("/tmp/b.jpg")];
        assert_eq!(
            build_image_create_args(&req),
            vec![
                "generate",
                "create",
                "nano_banana_2",
                "--prompt",
                "a quiet beach at sunrise",
                "--image",
                "/tmp/a.png",
                "--image",
                "/tmp/b.jpg",
                "--aspect_ratio",
                "16:9",
            ]
        );
    }

    /// The rule the video builder carries exists only for Seedance 2.5's frame inputs.
    /// An image job that inherited it would be refused by a model whose published mode
    /// set has no such value.
    #[test]
    fn an_image_job_never_asks_for_the_video_models_reference_mode() {
        let mut req = image_request();
        req.references = vec![PathBuf::from("/tmp/a.png")];
        let args = build_image_create_args(&req);
        assert!(!args.iter().any(|a| a == "--mode"), "{args:?}");
        assert!(!args.iter().any(|a| a == "--start-image"), "{args:?}");
    }

    fn video_prompt_request() -> VideoPromptRequest {
        VideoPromptRequest {
            model: DEFAULT_MODEL.into(),
            prompt: "a drone rises over the surf at dawn".into(),
        }
    }

    #[test]
    fn a_prompt_only_video_job_is_the_model_and_the_words_and_nothing_else() {
        assert_eq!(
            build_video_prompt_args(&video_prompt_request()),
            vec![
                "generate",
                "create",
                "seedance_2_5",
                "--prompt",
                "a drone rises over the surf at dawn",
            ]
        );
    }

    /// The regression this whole request type exists to make impossible.
    ///
    /// `--mode omni_reference` unlocks *frame inputs* and does nothing else, so a job that
    /// sends no frames must not ask for it — on Seedance 2.5 least of all, since that is
    /// the one model [`build_create_args`] injects it for.
    #[test]
    fn a_prompt_only_video_job_never_asks_for_the_reference_mode() {
        for model in [
            "seedance_2_5",
            "seedance_2_0",
            "seedance1_5",
            "kling3_0",
            "veo3_1_lite",
        ] {
            let mut req = video_prompt_request();
            req.model = model.into();
            let args = build_video_prompt_args(&req);
            assert!(!args.iter().any(|a| a == "--mode"), "{model}: {args:?}");
        }
    }

    #[test]
    fn a_prompt_only_video_job_sends_no_frames_and_no_references() {
        let args = build_video_prompt_args(&video_prompt_request());
        for flag in [
            "--start-image",
            "--end-image",
            "--image",
            "--image-references",
            "--aspect_ratio",
        ] {
            assert!(!args.iter().any(|a| a == flag), "{flag}: {args:?}");
        }
    }

    /// A prompt is a prompt, not shell input — the same guarantee the transition path has.
    #[test]
    fn a_prompt_only_video_job_passes_the_prompt_through_untouched() {
        let mut req = video_prompt_request();
        req.prompt = "pan; rm -rf / `boom` $(x)".into();
        let args = build_video_prompt_args(&req);
        let at = args.iter().position(|a| a == "--prompt").unwrap();
        assert_eq!(args[at + 1], "pan; rm -rf / `boom` $(x)");
    }

    #[test]
    fn a_generated_video_is_named_from_the_job_id_and_never_from_the_server() {
        assert_eq!(video_file_name("gen_7"), "gen_7.mp4");
        assert!(video_file_name("gen_7").ends_with(".mp4"));
    }

    /// **The landmine, held by a test.**
    ///
    /// [`image_extension`] answers from a whitelist of image content types and falls back
    /// to PNG for everything else — so an MP4 downloaded through [`Cli::download_image`]
    /// is written as `.png`. The media bin classifies by extension and nothing else, which
    /// means such a file returns from the next launch as a photo that will not draw.
    ///
    /// This is not a bug in `image_extension`; it is why a video result must land through
    /// `Landing::Video` (a plain byte stream to a caller-chosen `.mp4`) and must never be
    /// routed through the photo download. The assertion below is the trap, kept visible so
    /// that anyone tempted to reuse the photo path for video reads why they must not.
    #[test]
    fn the_photo_download_would_misname_a_video_which_is_why_video_does_not_use_it() {
        assert_eq!(
            image_extension(Some("video/mp4"), "https://cdn/out.mp4"),
            "png"
        );
        assert_eq!(image_extension(None, "https://cdn/out.mp4"), "png");
    }

    #[test]
    fn a_blank_aspect_ratio_is_left_off_rather_than_sent_empty() {
        let mut req = image_request();
        req.aspect_ratio = Some("   ".into());
        let args = build_image_create_args(&req);
        assert!(!args.iter().any(|a| a == "--aspect_ratio"), "{args:?}");
    }

    #[test]
    fn an_image_prompt_travels_as_one_argument_never_through_a_shell() {
        let mut req = image_request();
        req.prompt = "a beach; rm -rf / `boom` $(x)".into();
        let args = build_image_create_args(&req);
        let at = args.iter().position(|a| a == "--prompt").unwrap();
        assert_eq!(args[at + 1], "a beach; rm -rf / `boom` $(x)");
    }

    /// The bug this guards: a photo dropped from a browser has no filesystem path and is
    /// not flagged missing, so it looks perfectly usable in the bin. Sending its empty
    /// path would fail somewhere inside the CLI, about nothing the user could name.
    #[test]
    fn a_reference_without_a_file_is_refused_before_anything_is_sent() {
        let err = validate_references(&["".into()]).unwrap_err();
        assert!(matches!(err, HiggsfieldError::BadReference(_)), "{err:?}");
        assert_eq!(err.title(), "Reference photo unavailable");
        assert!(!err.is_retryable(), "the same empty path fails again");

        let err = validate_references(&["   ".into()]).unwrap_err();
        assert!(matches!(err, HiggsfieldError::BadReference(_)), "{err:?}");
    }

    #[test]
    fn a_reference_names_itself_when_it_has_gone_or_is_the_wrong_kind() {
        let missing = validate_references(&["/nowhere/holiday.png".into()]).unwrap_err();
        assert!(missing.to_string().contains("holiday.png"), "{missing}");

        let wrong = validate_references(&["/tmp/clip.mp4".into()]).unwrap_err();
        assert!(wrong.to_string().contains("clip.mp4"), "{wrong}");
        // The bin accepts these; Higgsfield's image references do not.
        for unsupported in ["/tmp/a.avif", "/tmp/a.bmp", "/tmp/a.gif"] {
            assert!(
                validate_references(&[unsupported.into()]).is_err(),
                "{unsupported}"
            );
        }
    }

    #[test]
    fn real_reference_files_come_back_as_paths() {
        let dir = std::env::temp_dir().join(format!("solcut-refs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let png = dir.join("one.PNG");
        std::fs::write(&png, [1, 2, 3]).unwrap();

        let files = validate_references(&[png.display().to_string()]).expect("accepted");
        assert_eq!(
            files,
            vec![png.clone()],
            "an upper-case extension still counts"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A photo saved under the wrong extension is re-imported at the next launch as the
    /// wrong kind of media, or refused outright — the media bin classifies by extension
    /// and nothing else. So this is correctness, not tidiness.
    #[test]
    fn a_downloaded_photo_is_named_by_what_the_server_actually_served() {
        assert_eq!(image_extension(Some("image/png"), "https://cdn/x"), "png");
        assert_eq!(
            image_extension(Some("image/jpeg; charset=binary"), "https://cdn/x"),
            "jpg"
        );
        assert_eq!(image_extension(Some("IMAGE/WEBP"), "https://cdn/x"), "webp");
    }

    #[test]
    fn a_signed_url_keeps_its_extension_out_of_the_query_string() {
        assert_eq!(
            image_extension(None, "https://cdn.test/out/a.png?token=SECRET&x=1"),
            "png"
        );
        assert_eq!(image_extension(None, "https://cdn.test/a.JPEG#top"), "jpg");
        assert_eq!(image_extension(None, "https://cdn.test/a.webp"), "webp");
    }

    #[test]
    fn an_unreadable_result_url_falls_back_to_png_rather_than_to_nothing() {
        // Higgsfield's storage serves extension-less asset ids, and an octet-stream
        // content type says nothing. A file with no extension at all would come back
        // from the media bin as unimportable.
        assert_eq!(
            image_extension(
                Some("application/octet-stream"),
                "https://cdn/v1/assets/2f9c"
            ),
            "png"
        );
        assert_eq!(image_extension(None, "https://cdn/v1/assets/2f9c"), "png");
    }

    #[test]
    fn the_fallback_prefixes_cover_npm_and_homebrew() {
        let dirs = fallback_dirs();
        assert!(dirs.contains(&PathBuf::from("/opt/homebrew/bin")));
        assert!(dirs.contains(&PathBuf::from("/usr/local/bin")));
    }
}
