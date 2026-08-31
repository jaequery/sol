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
//! 1. [`Cli::find`] locates the binary on `PATH` (or in the usual install prefixes,
//!    which a GUI-launched app does not always have on its `PATH`).
//! 2. [`Cli::create`] runs `generate create <model> --prompt … --start-image …
//!    --end-image … --json`. The CLI uploads the two stills itself — a local file path
//!    is a documented media input — and answers with the job id.
//! 3. [`Cli::job_state`] reads `generate get <job_id> --json` until a terminal state,
//!    and [`Cli::download`] fetches the finished MP4 next to the project.
//! 4. [`Cli::probe`] is the Settings dialog's connection check: `model list --video
//!    --json`, which proves the binary, the login and the workspace in one free call.
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

/// The binary the official npm package installs.
pub const CLI_BINARY: &str = "higgsfield";

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
        use tokio::io::AsyncWriteExt as _;

        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()?;
        let response = http.get(url).send().await?;
        if !response.status().is_success() {
            return Err(HiggsfieldError::Http {
                status: response.status().as_u16(),
                body: "could not download the generated video".into(),
            });
        }

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

    #[test]
    fn the_fallback_prefixes_cover_npm_and_homebrew() {
        let dirs = fallback_dirs();
        assert!(dirs.contains(&PathBuf::from("/opt/homebrew/bin")));
        assert!(dirs.contains(&PathBuf::from("/usr/local/bin")));
    }
}
