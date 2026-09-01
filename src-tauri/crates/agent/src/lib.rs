//! Transitions authored by a coding-agent CLI and composited locally with ffmpeg.
//!
//! Deliberately free of Tauri, GUI and platform dependencies so it compiles and tests on
//! any machine — the desktop shell in `src-tauri/` is a thin wrapper over this, and this
//! crate holds the **whole run** rather than just the CLI call for exactly that reason: a
//! machine that cannot build the Tauri shell can still prove the sequence end to end.
//!
//! ## What this is, and what it is not
//!
//! Neither the Claude Code CLI nor the Codex CLI generates pixels. They are coding agents;
//! there is no image model and no video model behind either of them. So the division of
//! labour here is the honest one: **the agent reads the user's prose and chooses the
//! motion, and ffmpeg composites it.** A transition made this way is a real transition
//! between the two frames — it is simply composited rather than generated, which is why the
//! UI groups these under "Local motion" and not beside Higgsfield's models.
//!
//! The agent's whole output is two fields:
//!
//! ```text
//! { "transition": "<one of solcut_render::TRANSITIONS>", "duration_secs": 1.0 - 8.0 }
//! ```
//!
//! A closed vocabulary rather than a filter graph, and that is a security property, not a
//! convenience: nothing a model writes is ever parsed as ffmpeg syntax, so there is no
//! injection surface to guard and a prompt that tries to steer the agent can at worst
//! produce a transition name that fails the allowlist. It is also why the run needs **no
//! permission bypass at all** — see [`build_args`].
//!
//! ## The shape of a run
//!
//! 1. [`AgentCli::find`] locates the binary on `PATH`, or in the prefixes a GUI-launched
//!    app does not inherit.
//! 2. [`transition`] spawns it once, reads the recipe out of what it printed, and hands the
//!    two stills and the chosen motion to `solcut_render` — reporting each step through a
//!    caller-supplied closure, and stopping the moment a caller-supplied predicate says the
//!    user pressed Cancel.

mod error;
mod parse;

pub use error::{AgentError, Result};
pub use parse::{extract_json_object, parse_recipe, recipe_schema};

use solcut_render::{ExportSpec, Renderer};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

/// How often a run looks up from what it is doing to see whether the user cancelled.
///
/// The same cadence the Higgsfield poll loop uses, and for the same reason: an agent call
/// takes ten seconds or more, and a Cancel button that only takes effect when it finishes
/// is a Cancel button that looks broken.
const CANCEL_CHECK_INTERVAL: Duration = Duration::from_millis(250);

/// Which coding-agent CLI renders a transition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Agent {
    ClaudeCode,
    Codex,
}

impl Agent {
    /// Every agent the app offers, in menu order.
    pub const ALL: &'static [Agent] = &[Agent::ClaudeCode, Agent::Codex];

    /// The id that travels with a request, and the one the frontend's selector holds.
    pub fn id(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::Codex => "codex",
        }
    }

    /// The agent an id names, or `None` — which the caller reads as "not an agent request",
    /// never as a default, so a typo can never silently pick a backend.
    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.iter().copied().find(|a| a.id() == id.trim())
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::ClaudeCode => "the Claude Code CLI",
            Self::Codex => "the Codex CLI",
        }
    }

    /// What the binary is called. Windows npm shims are `.cmd`, and are what actually exists
    /// there — the extensionless name is a shell script only a POSIX shell can run.
    pub fn binary_names(self) -> &'static [&'static str] {
        match self {
            #[cfg(windows)]
            Self::ClaudeCode => &["claude.cmd", "claude.exe"],
            #[cfg(not(windows))]
            Self::ClaudeCode => &["claude"],
            #[cfg(windows)]
            Self::Codex => &["codex.cmd", "codex.exe"],
            #[cfg(not(windows))]
            Self::Codex => &["codex"],
        }
    }

    /// Quoted verbatim in the UI when the CLI is missing, so the fix can be pasted.
    pub fn install(self) -> &'static str {
        match self {
            Self::ClaudeCode => "npm install -g @anthropic-ai/claude-code",
            Self::Codex => "npm install -g @openai/codex",
        }
    }

    pub fn login(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude auth login",
            Self::Codex => "codex login",
        }
    }

    /// How long one motion question may take.
    ///
    /// Claude's budget is measured: the same shape of question, on `haiku` with tools off,
    /// answers in about ten seconds. Codex gets longer because it has no wall-clock flag of
    /// its own to enforce and its logged-out failure path retries several transports before
    /// giving up — a budget that ends the wait is the only thing that bounds it.
    pub fn budget(self) -> Duration {
        match self {
            Self::ClaudeCode => Duration::from_secs(60),
            Self::Codex => Duration::from_secs(120),
        }
    }
}

/// The motion a run asks for.
#[derive(Debug, Clone)]
pub struct MotionRequest {
    /// The user's own words from the cut card, or the editor's default when they typed none.
    pub prompt: String,
    /// How long the cut being replaced currently runs, when there is a span to match.
    ///
    /// Sent because a photo-to-photo transition **stands in the stills' place**: the model
    /// choosing a length is choosing how much of the film to keep, and it answers far better
    /// when it knows what it is replacing than when it is guessing in the abstract.
    pub span_secs: Option<f32>,
}

/// Everything one transition run needs beyond the CLI and the renderer.
///
/// A struct rather than five more parameters: the two stills, where the result goes and
/// what was asked for all travel together, and a caller cannot get the frames the wrong way
/// round without saying so by name.
#[derive(Debug, Clone)]
pub struct TransitionJob {
    pub request: MotionRequest,
    /// The still the motion starts from — a photo, or a frame pulled off a video at the cut.
    pub start_frame: PathBuf,
    /// The still it lands on.
    pub end_frame: PathBuf,
    /// Where the finished MP4 is written.
    pub out: PathBuf,
}

/// One motion, validated: a transition this build renders and a length it accepts.
#[derive(Debug, Clone, PartialEq)]
pub struct Recipe {
    pub transition: String,
    pub duration_secs: f32,
}

/// What a run reports as it goes, mapped by the caller onto its own event.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Step {
    /// `queued` while the agent is thinking, `running` while ffmpeg composites.
    pub status: &'static str,
    /// 0..1. Two steps rather than a percentage, because neither half volunteers one.
    pub progress: f32,
}

/// A located agent CLI and the one thing SolCut asks of it.
#[derive(Debug, Clone)]
pub struct AgentCli {
    agent: Agent,
    binary: PathBuf,
}

impl AgentCli {
    /// The CLI wherever it is installed, or `None` — which the UI reports as "not installed"
    /// with the install command, rather than failing at render time.
    pub fn find(agent: Agent) -> Option<Self> {
        find_binary(agent.binary_names()).map(|binary| Self { agent, binary })
    }

    /// A CLI at a known path. The seam a stub executable comes in through.
    pub fn new(agent: Agent, binary: PathBuf) -> Self {
        Self { agent, binary }
    }

    pub fn agent(&self) -> Agent {
        self.agent
    }

    pub fn binary(&self) -> &Path {
        &self.binary
    }

    /// Ask for one motion, and stop early if the user cancels.
    ///
    /// The child is spawned with `kill_on_drop`, so returning from here for any reason —
    /// cancel, timeout, the caller giving up — reaps it. That matters more than it does for
    /// a status poll: an agent left running is an agent still spending the user's money.
    pub async fn recipe(
        &self,
        req: &MotionRequest,
        cancel: &(dyn Fn() -> bool + Send + Sync),
    ) -> Result<Recipe> {
        let workdir = std::env::temp_dir().join(format!("solcut-agent-{}", std::process::id()));
        std::fs::create_dir_all(&workdir).map_err(|e| AgentError::Io(e.to_string()))?;

        let prompt = build_prompt(req);
        let args = build_args(self.agent, &prompt, &workdir);

        let mut command = tokio::process::Command::new(&self.binary);
        command
            .args(&args)
            .current_dir(&workdir)
            // Both CLIs read stdin even when the prompt is an argument. Codex hangs
            // outright waiting for it; Claude gives up after three seconds and says so —
            // three seconds of every render, for nothing.
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        // A binary found outside `PATH` is usually an npm or Homebrew shim whose first line
        // is `#!/usr/bin/env node`. Under a GUI launch — launchd's environment has almost no
        // `PATH` at all — that shim dies with `env: node: No such file or directory`, which
        // is a baffling thing to show someone whose CLI works fine in a terminal. Putting
        // the directory it was found in on the child's `PATH` is what makes the shim resolve
        // its own runtime.
        if let Some(dir) = self.binary.parent() {
            let existing = std::env::var_os("PATH").unwrap_or_default();
            let mut dirs = vec![dir.to_path_buf()];
            dirs.extend(std::env::split_paths(&existing));
            if let Ok(joined) = std::env::join_paths(dirs) {
                command.env("PATH", joined);
            }
        }

        let child = command.spawn().map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => AgentError::NotInstalled(self.agent),
            _ => AgentError::Io(format!("could not run {}: {e}", self.agent.label())),
        })?;

        let budget = self.agent.budget();
        let output = wait_unless_cancelled(self.agent, child, budget, cancel).await?;

        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let message = match reason(&stderr) {
                Some(why) => why,
                None => match reason(&stdout) {
                    Some(why) => why,
                    None => format!("{} failed without saying why", self.agent.label()),
                },
            };
            // These CLIs update themselves underneath the app, and the flags this crate
            // relies on are recent. A refusal at the argument parser is therefore a version
            // drift, not a user error, and it deserves its own sentence.
            return Err(if is_usage_error(&stderr) {
                AgentError::Outdated {
                    agent: self.agent,
                    message,
                }
            } else {
                AgentError::Cli {
                    agent: self.agent,
                    message,
                }
            });
        }

        parse_recipe(self.agent, &stdout)
    }
}

/// Ask an agent for a motion and composite it, reporting each step.
///
/// The whole run, kept here rather than in the Tauri shell so it is covered by a test that
/// spawns a stub CLI and a real ffmpeg. `emit` receives one [`Step`] per phase; `cancel` is
/// consulted between them and while the agent is thinking. On success the MP4 is at `out`
/// and the [`Recipe`] that produced it comes back, so the caller can say what was rendered.
pub async fn transition(
    cli: &AgentCli,
    renderer: &Renderer,
    spec: &ExportSpec,
    job: &TransitionJob,
    emit: &(dyn Fn(Step) + Send + Sync),
    cancel: &(dyn Fn() -> bool + Send + Sync),
) -> Result<Recipe> {
    if cancel() {
        return Err(AgentError::Cancelled);
    }
    emit(Step {
        status: "queued",
        progress: 0.0,
    });

    let recipe = cli.recipe(&job.request, cancel).await?;

    if cancel() {
        return Err(AgentError::Cancelled);
    }
    // The agent is the slow half by a wide margin — ten seconds or more against about one
    // for the composite — so arriving here is most of the way there, and the bar says so.
    emit(Step {
        status: "running",
        progress: 0.75,
    });

    renderer
        .render_transition(
            spec,
            &job.start_frame,
            &job.end_frame,
            &recipe.transition,
            recipe.duration_secs,
            &job.out,
        )
        .await?;

    Ok(recipe)
}

/// What the agent is asked.
///
/// One prompt for both CLIs. Claude additionally gets the same shape as a `--json-schema`,
/// which makes its answer structurally guaranteed; Codex has no such flag, so for that CLI
/// these words are the entire contract and the parser is what enforces it.
pub fn build_prompt(req: &MotionRequest) -> String {
    let described = req.prompt.trim();
    let mut prompt = String::new();
    prompt.push_str(
        "You are choosing how one still image becomes another in a video editor.\n\n\
         The editor will composite the transition itself with ffmpeg's xfade filter. \
         Your only job is to read the description below and pick the motion that best \
         matches it, and how long it should run.\n\n",
    );
    prompt.push_str("The motion the user described:\n\"");
    prompt.push_str(described);
    prompt.push_str("\"\n\n");

    if let Some(span) = req.span_secs.filter(|s| s.is_finite() && *s > 0.0) {
        // Not decoration: between two photos the finished clip stands in their place, so
        // the length chosen here is how much of the film survives the edit.
        prompt.push_str(&format!(
            "This transition replaces {span:.1} seconds of the timeline, so a length near \
             that keeps the film's pacing unless the description asks for something faster \
             or slower.\n\n"
        ));
    }

    prompt.push_str("Choose exactly one of these transitions:\n");
    prompt.push_str(&solcut_render::TRANSITIONS.join(", "));
    prompt.push_str(&format!(
        "\n\nReply with only a JSON object and nothing else — no prose, no code fence:\n\
         {{\"transition\": \"<one of the names above>\", \"duration_secs\": <number \
         between {min} and {max}>}}\n\n\
         Answer from the description alone. Do not run any commands and do not read any \
         files.",
        min = solcut_render::MIN_TRANSITION_SECS,
        max = solcut_render::MAX_TRANSITION_SECS,
    ));
    prompt
}

/// The argv for one motion question, kept as its own function so the exact invocation is
/// unit-testable without spawning anything.
///
/// **No permission bypass appears here, on purpose.** Claude's `--tools ""` empties the tool
/// array outright, so there is nothing to permit and nothing to skip permission for; a
/// `--dangerously-skip-permissions` would be strictly worse as well as unnecessary. Codex
/// has no equivalent flag — its shell tool is core — so it gets `--sandbox read-only`, which
/// is a genuinely weaker posture and is documented as such rather than glossed over.
///
/// The rest divides into two kinds. **Load-bearing**, without which the answer is wrong or
/// unreadable: Claude's `-p`, `--output-format json`, `--tools ""`, `--json-schema`; Codex's
/// `exec`, `--sandbox read-only` and `--skip-git-repo-check` (it refuses to run outside a
/// git repository, and SolCut spawns it from a temp directory). And **hygiene**, so that
/// what a user has configured for their own sessions cannot change what SolCut is answered:
/// `--strict-mcp-config`, `--setting-sources ""`, `--disable-slash-commands`,
/// `--no-session-persistence`, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`.
/// A future breakage is in the first group; the second can be dropped without changing an
/// answer, only whose configuration leaks into it.
pub fn build_args(agent: Agent, prompt: &str, workdir: &Path) -> Vec<String> {
    match agent {
        Agent::ClaudeCode => vec![
            "-p".into(),
            prompt.to_string(),
            "--output-format".into(),
            "json".into(),
            "--tools".into(),
            String::new(),
            "--json-schema".into(),
            recipe_schema(),
            // Cheap and fast, and picking a motion out of a sentence is not a task that
            // needs more. The measured round trip is about ten seconds.
            "--model".into(),
            "haiku".into(),
            "--strict-mcp-config".into(),
            "--setting-sources".into(),
            String::new(),
            "--disable-slash-commands".into(),
            "--no-session-persistence".into(),
        ],
        Agent::Codex => vec![
            "exec".into(),
            prompt.to_string(),
            "--color".into(),
            "never".into(),
            "--sandbox".into(),
            "read-only".into(),
            "--skip-git-repo-check".into(),
            "--ephemeral".into(),
            "--ignore-user-config".into(),
            "--ignore-rules".into(),
            "-C".into(),
            workdir.display().to_string(),
        ],
    }
}

/// Wait for the child, giving up on a budget and on a cancellation.
///
/// The child is moved in and dropped on every path out but the successful one, and it was
/// spawned with `kill_on_drop`, so a cancelled or timed-out agent is killed rather than left
/// running and billing.
async fn wait_unless_cancelled(
    agent: Agent,
    child: tokio::process::Child,
    budget: Duration,
    cancel: &(dyn Fn() -> bool + Send + Sync),
) -> Result<std::process::Output> {
    let deadline = tokio::time::Instant::now() + budget;
    // Take the pipes before waiting: `wait_with_output` consumes the child, and the reader
    // has to be draining while the agent runs. Claude waits for its own stdout to flush
    // before it will exit, so a reader that only starts afterwards can truncate the answer.
    let mut collecting = Box::pin(child.wait_with_output());

    loop {
        if cancel() {
            // Dropping the future drops the child, which kills it.
            return Err(AgentError::Cancelled);
        }
        let slice = CANCEL_CHECK_INTERVAL.min(
            deadline
                .saturating_duration_since(tokio::time::Instant::now())
                .max(Duration::from_millis(1)),
        );
        match tokio::time::timeout(slice, &mut collecting).await {
            Ok(result) => return result.map_err(|e| AgentError::Io(e.to_string())),
            Err(_) if tokio::time::Instant::now() >= deadline => {
                return Err(AgentError::Timeout {
                    agent,
                    secs: budget.as_secs(),
                })
            }
            Err(_) => {}
        }
    }
}

/// Whether a CLI's stderr is its argument parser complaining, rather than the agent.
///
/// These are the phrases commander and clap use, which is what both CLIs are built on. A
/// match means SolCut asked in a way this version of the CLI does not understand.
fn is_usage_error(stderr: &str) -> bool {
    let lower = stderr.to_ascii_lowercase();
    // Each phrase names an *argument*, which is what keeps this from catching the agent's
    // own troubles. A looser "error: unexpected" was here first and matched Codex's
    // `ERROR: unexpected status 401 Unauthorized` — reporting a logged-out CLI as an
    // outdated one, and sending the user to reinstall software that was working fine.
    [
        "unknown option",
        "unknown argument",
        "unexpected argument",
        "unrecognized option",
        "unrecognised option",
        "unrecognized argument",
        "invalid value for",
    ]
    .iter()
    .any(|phrase| lower.contains(phrase))
}

/// Why a CLI failed, out of the stream it said it on.
///
/// The **last** lines rather than the first: both CLIs narrate to stderr while they work —
/// a sandbox warning, a reconnection, a deprecation — and the reason a run failed is what
/// they said last. Quoting the head instead reliably shows the user a warning that had
/// nothing to do with it. (`solcut-render` reads ffmpeg's stderr the same way, for the same
/// reason.)
fn reason(stream: &str) -> Option<String> {
    let lines: Vec<&str> = stream
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    if lines.is_empty() {
        return None;
    }

    // Filled from the end and only then reversed, so the budget is spent on the newest lines
    // rather than the oldest. Taking the last few lines and *then* truncating would put a
    // long opening warning back in the user's way, which is the whole thing this avoids.
    let mut budget = PREVIEW_CHARS;
    let mut picked: Vec<&str> = Vec::new();
    for line in lines.iter().rev().take(4) {
        let wanted = line.chars().count() + 1;
        if !picked.is_empty() && wanted > budget {
            break;
        }
        picked.push(line);
        budget = budget.saturating_sub(wanted);
    }
    picked.reverse();
    Some(preview(&picked.join("\n")))
}

// ---------------------------------------------------------------- binary discovery

/// The first of `names` that exists and can be executed: `PATH` first, then the prefixes npm
/// and Homebrew install into — a GUI-launched app on macOS gets launchd's `PATH`, which has
/// neither.
pub fn find_binary(names: &[&str]) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            if let Some(found) = executable_in(&dir, names) {
                return Some(found);
            }
        }
    }
    fallback_dirs()
        .iter()
        .find_map(|dir| executable_in(dir, names))
}

fn executable_in(dir: &Path, names: &[&str]) -> Option<PathBuf> {
    names
        .iter()
        .map(|name| dir.join(name))
        .find(|candidate| is_executable(candidate))
}

fn fallback_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join(".npm-global/bin"));
        // Where the CLIs' own installers put them, which is neither of the above.
        dirs.push(home.join(".claude/local"));
        dirs.push(home.join(".codex/bin"));
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

/// How much of a CLI's own words an error card can carry without becoming a log viewer.
const PREVIEW_CHARS: usize = 200;

pub(crate) fn preview(body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.chars().count() <= PREVIEW_CHARS {
        return trimmed.to_string();
    }
    let head: String = trimmed.chars().take(PREVIEW_CHARS).collect();
    format!("{head}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_agent_id_round_trips_and_a_typo_picks_nothing() {
        // `from_id` returning `None` rather than a default is what stops a stale or
        // misspelled id from silently choosing a backend the user did not ask for.
        for agent in Agent::ALL {
            assert_eq!(Agent::from_id(agent.id()), Some(*agent));
        }
        assert_eq!(Agent::from_id("claude-code "), Some(Agent::ClaudeCode));
        assert_eq!(Agent::from_id("claude"), None);
        assert_eq!(Agent::from_id("seedance-2.5"), None);
        assert_eq!(Agent::from_id(""), None);
    }

    #[test]
    fn claude_is_asked_with_no_tools_at_all_and_no_permission_bypass() {
        let args = build_args(Agent::ClaudeCode, "make it drift", Path::new("/tmp/w"));
        let at = |flag: &str| args.iter().position(|a| a == flag);

        // `--tools ""` is the whole security argument: an empty tool array means there is
        // nothing to permit, which is why no bypass flag belongs here.
        let tools = at("--tools").expect("--tools");
        assert_eq!(args[tools + 1], "", "an empty value disables every tool");
        assert!(
            !args.iter().any(|a| a.contains("dangerously")
                || a.contains("bypassPermissions")
                || a == "--permission-mode"),
            "a run with no tools must never ask for a permission bypass: {args:?}"
        );

        assert_eq!(args[at("-p").expect("-p") + 1], "make it drift");
        assert_eq!(args[at("--output-format").expect("format") + 1], "json");
        assert_eq!(args[at("--model").expect("model") + 1], "haiku");

        // The schema is what makes the answer structurally guaranteed rather than hoped for.
        let schema = &args[at("--json-schema").expect("--json-schema") + 1];
        assert!(schema.contains("\"transition\""), "{schema}");
        assert!(schema.contains("slideleft"), "{schema}");
        assert!(
            !schema.contains("zoomin"),
            "the enum is the vocabulary: {schema}"
        );
    }

    #[test]
    fn codex_is_asked_read_only_and_told_it_is_not_in_a_repository() {
        let args = build_args(Agent::Codex, "make it drift", Path::new("/tmp/w"));
        assert_eq!(args[0], "exec");
        assert_eq!(args[1], "make it drift");
        let at = |flag: &str| args.iter().position(|a| a == flag);
        assert_eq!(args[at("--sandbox").expect("--sandbox") + 1], "read-only");
        // Without this Codex refuses outright: SolCut spawns it from a temp directory, and
        // "Not inside a trusted directory" is what comes back.
        assert!(args.iter().any(|a| a == "--skip-git-repo-check"));
        assert_eq!(args[at("-C").expect("-C") + 1], "/tmp/w");
        // `-a`/`--ask-for-approval` exists only on the top-level command; `codex exec`
        // rejects it outright with exit 2, and already hardcodes approvals to never.
        assert!(!args.iter().any(|a| a == "-a" || a == "--ask-for-approval"));
    }

    #[test]
    fn the_prompt_carries_the_vocabulary_and_the_span_it_is_replacing() {
        let prompt = build_prompt(&MotionRequest {
            prompt: "  a slow dreamy dissolve  ".into(),
            span_secs: Some(5.0),
        });
        assert!(prompt.contains("a slow dreamy dissolve"));
        assert!(!prompt.contains("  a slow"), "the user's words are trimmed");
        assert!(prompt.contains("replaces 5.0 seconds"));
        for name in solcut_render::TRANSITIONS {
            assert!(prompt.contains(name), "{name} missing from the prompt");
        }

        // No span to match: the sentence is left out rather than sent with a made-up number.
        let bare = build_prompt(&MotionRequest {
            prompt: "hard cut".into(),
            span_secs: None,
        });
        assert!(!bare.contains("replaces"));
        let zero = build_prompt(&MotionRequest {
            prompt: "hard cut".into(),
            span_secs: Some(0.0),
        });
        assert!(!zero.contains("replaces"));
    }

    #[test]
    fn a_missing_binary_names_itself_and_quotes_its_own_install_line() {
        // This string is shown to a user who has done nothing wrong, so it has to be
        // pasteable rather than merely accurate.
        let e = AgentError::NotInstalled(Agent::ClaudeCode);
        assert_eq!(e.title(), "the Claude Code CLI not found");
        let text = e.to_string();
        assert!(
            text.contains("npm install -g @anthropic-ai/claude-code"),
            "{text}"
        );
        assert!(text.contains("claude auth login"), "{text}");
        assert!(!e.is_retryable(), "installing it is the fix, not retrying");

        let e = AgentError::NotInstalled(Agent::Codex);
        assert!(e.to_string().contains("npm install -g @openai/codex"));
        assert!(e.to_string().contains("codex login"));
    }

    #[test]
    fn only_an_unusable_answer_is_worth_sending_again() {
        // A model is not deterministic, so a re-roll genuinely fixes a garbled answer. A
        // refusal, a missing binary and a changed CLI all land in the same place next time,
        // and offering Regenerate for those would be a lie.
        assert!(AgentError::Malformed("no motion".into()).is_retryable());
        assert!(AgentError::Timeout {
            agent: Agent::Codex,
            secs: 120
        }
        .is_retryable());
        assert!(!AgentError::Cli {
            agent: Agent::ClaudeCode,
            message: "not logged in".into()
        }
        .is_retryable());
        assert!(!AgentError::Outdated {
            agent: Agent::ClaudeCode,
            message: "unknown option '--tools'".into()
        }
        .is_retryable());
        assert!(!AgentError::Render("ffmpeg was not found".into()).is_retryable());
    }

    #[test]
    fn a_dead_session_is_told_apart_from_a_plain_refusal() {
        let signed_out = AgentError::Cli {
            agent: Agent::ClaudeCode,
            message: "Not logged in. Run `claude auth login`.".into(),
        };
        assert_eq!(signed_out.title(), "Not signed in to the Claude Code CLI");

        let spent = AgentError::Cli {
            agent: Agent::ClaudeCode,
            message: "Usage limit reached for this plan".into(),
        };
        assert_eq!(spent.title(), "the Claude Code CLI is out of capacity");

        let other = AgentError::Cli {
            agent: Agent::Codex,
            message: "something else entirely".into(),
        };
        assert_eq!(other.title(), "the Codex CLI refused the request");
    }

    #[test]
    fn a_flag_the_cli_no_longer_knows_is_reported_as_a_version_drift() {
        // The likeliest way this feature breaks in the field: these CLIs update themselves,
        // and `--tools` and `--json-schema` are recent. A usage screen quoted at the user is
        // useless; "the CLI has changed" is actionable.
        assert!(is_usage_error("error: unknown option '--tools'"));
        assert!(is_usage_error("error: unexpected argument '-a' found"));
        assert!(is_usage_error("Unrecognized option: --json-schema"));
        assert!(!is_usage_error("You are not logged in."));
        assert!(!is_usage_error(""));

        // Observed, not imagined: a logged-out Codex prints this a dozen times over, and an
        // earlier, looser phrase list read it as a flag it did not recognise — telling the
        // user to reinstall a CLI that only needed `codex login`.
        assert!(!is_usage_error(
            "ERROR: unexpected status 401 Unauthorized: Missing bearer or basic \
             authentication in header, url: https://api.openai.com/v1/responses"
        ));
    }

    #[test]
    fn a_refusal_is_quoted_from_the_end_of_what_the_cli_said() {
        // Both CLIs narrate while they work. Codex opens with a bubblewrap warning long
        // enough to fill the whole preview on its own, so quoting the head would show a user
        // a sandbox note instead of the 401 that actually stopped them.
        let noisy = "warning: Codex could not find bubblewrap on PATH. Install bubblewrap \
                     with your OS package manager. See the sandbox prerequisites. Codex will \
                     use the bundled bubblewrap in the meantime.\n\
                     ERROR: Reconnecting... 5/5\n\
                     ERROR: unexpected status 401 Unauthorized: Missing bearer";
        let why = reason(noisy).expect("a reason");
        assert!(why.contains("401 Unauthorized"), "{why}");
        assert!(!why.contains("bubblewrap"), "{why}");

        assert_eq!(reason(""), None);
        assert_eq!(reason("   \n\n  "), None);
        assert_eq!(reason("just this"), Some("just this".to_string()));
    }

    #[test]
    fn a_long_refusal_is_previewed_rather_than_pasted_whole() {
        let long = "x".repeat(500);
        let shown = preview(&long);
        assert_eq!(
            shown.chars().count(),
            PREVIEW_CHARS + 1,
            "the cap and an ellipsis"
        );
        assert!(shown.ends_with('…'));
        assert_eq!(preview("  short  "), "short");
    }
}
