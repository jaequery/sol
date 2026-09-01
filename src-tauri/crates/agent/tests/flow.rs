//! The whole run, against a stub CLI and a real ffmpeg: what SolCut asks, what it does with
//! the answer, what it reports on the way, and how each way of failing comes out.
//!
//! This suite is the reason the run loop lives in this crate rather than in the Tauri shell.
//! `src-tauri` needs a GTK/webkit toolchain to compile at all, so on most machines — CI
//! included — nothing there is ever built, let alone tested. Everything below is what would
//! otherwise be unverified.
#![cfg(unix)]

mod stub_agent;

use solcut_agent::{transition, Agent, AgentError, MotionRequest, Step, TransitionJob};
use solcut_render::{ExportSpec, Renderer};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use stub_agent::{claude_envelope, StubAgent};

fn require_ffmpeg() {
    let ok = Command::new("ffmpeg")
        .arg("-version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    assert!(
        ok,
        "ffmpeg is not on PATH. A composited transition is nothing but ffmpeg, so this suite \
         cannot prove anything without it — install ffmpeg (see the README's Requirements)."
    );
}

fn never() -> impl Fn() -> bool + Send + Sync {
    || false
}

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("solcut-flow-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch");
        Self(dir)
    }

    fn still(&self, name: &str) -> PathBuf {
        let out = self.0.join(name);
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
            .expect("run ffmpeg");
        assert!(status.success());
        out
    }

    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn probe_duration(path: &Path) -> f32 {
    let output = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "csv=p=0",
        ])
        .arg(path)
        .output()
        .expect("run ffprobe");
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse()
        .expect("a duration")
}

#[tokio::test]
async fn a_recipe_from_the_cli_becomes_a_real_mp4_and_reports_every_step() {
    require_ffmpeg();
    let scratch = Scratch::new("happy");
    let stub = StubAgent::new(Agent::ClaudeCode, "happy");
    stub.put(
        "answer.out",
        &claude_envelope(r#"{"transition":"slideleft","duration_secs":3}"#),
    );

    let steps: Mutex<Vec<Step>> = Mutex::new(Vec::new());
    let out = scratch.path("out.mp4");
    let recipe = transition(
        &stub.cli(),
        &Renderer::default(),
        &ExportSpec::default(),
        &TransitionJob {
            request: MotionRequest {
                prompt: "sweep across to the left".into(),
                span_secs: Some(5.0),
            },
            start_frame: scratch.still("a.png"),
            end_frame: scratch.still("b.png"),
            out: out.clone(),
        },
        &|step| steps.lock().unwrap().push(step),
        &never(),
    )
    .await
    .expect("a transition");

    assert_eq!(recipe.transition, "slideleft");
    assert_eq!(recipe.duration_secs, 3.0);

    // The card has two things to show and they arrive in this order: the agent is thinking,
    // then ffmpeg is compositing. A percentage would be invented — neither half reports one.
    let steps = steps.lock().unwrap().clone();
    assert_eq!(
        steps,
        vec![
            Step {
                status: "queued",
                progress: 0.0
            },
            Step {
                status: "running",
                progress: 0.75
            },
        ]
    );

    // The file is what the timeline will actually play, so it is probed rather than assumed.
    assert!(out.exists(), "the MP4 has to be where the caller was told");
    let duration = probe_duration(&out);
    assert!(
        (duration - 3.0).abs() <= 1.0 / 30.0,
        "expected 3 s, got {duration}"
    );
}

#[tokio::test]
async fn claude_is_asked_exactly_what_the_flags_promise() {
    require_ffmpeg();
    let scratch = Scratch::new("argv");
    let stub = StubAgent::new(Agent::ClaudeCode, "argv");
    stub.put(
        "answer.out",
        &claude_envelope(r#"{"transition":"fade","duration_secs":2}"#),
    );

    transition(
        &stub.cli(),
        &Renderer::default(),
        &ExportSpec::default(),
        &TransitionJob {
            request: MotionRequest {
                prompt: "a gentle fade".into(),
                span_secs: None,
            },
            start_frame: scratch.still("a.png"),
            end_frame: scratch.still("b.png"),
            out: scratch.path("out.mp4"),
        },
        &|_| {},
        &never(),
    )
    .await
    .expect("a transition");

    // Asserted against what actually reached the process, not against the builder — an argv
    // that is right in a unit test and mangled by the spawn is still a broken feature.
    let argv = stub.argv();
    let at = |flag: &str| {
        argv.iter()
            .position(|a| a == flag)
            .unwrap_or_else(|| panic!("{flag} missing from {argv:?}"))
    };
    assert_eq!(argv[at("--output-format") + 1], "json");
    assert!(argv.iter().any(|a| a == "-p"));
    assert_eq!(
        argv[at("--tools") + 1],
        "",
        "an empty value is what disables every tool"
    );
    assert!(argv.iter().any(|a| a == "--json-schema"));
    assert!(
        argv.iter().any(|a| a.contains("a gentle fade")),
        "the user's words travel"
    );
    assert!(
        !argv
            .iter()
            .any(|a| a.contains("dangerously") || a.contains("bypass")),
        "no permission bypass may ever reach the CLI: {argv:?}"
    );
}

#[tokio::test]
async fn a_motion_this_build_cannot_render_is_refused_before_ffmpeg_sees_it() {
    require_ffmpeg();
    let scratch = Scratch::new("vocab");
    let stub = StubAgent::new(Agent::ClaudeCode, "vocab");
    // `zoomin` is a real ffmpeg transition, just not one of the sixteen — the exact way an
    // unconstrained model goes wrong.
    stub.put(
        "answer.out",
        &claude_envelope(r#"{"transition":"zoomin","duration_secs":2}"#),
    );

    let out = scratch.path("out.mp4");
    let error = run_expecting_failure(&stub, &scratch, &out).await;
    assert!(
        matches!(error, AgentError::Malformed(ref m) if m.contains("zoomin")),
        "got {error}"
    );
    assert!(
        error.is_retryable(),
        "a model can be asked again and answer differently"
    );
    assert!(
        !out.exists(),
        "nothing may be written for a motion we refused"
    );
}

#[tokio::test]
async fn an_answer_with_no_motion_in_it_is_reported_as_that() {
    require_ffmpeg();
    let scratch = Scratch::new("prose");
    let stub = StubAgent::new(Agent::ClaudeCode, "prose");
    stub.put(
        "answer.out",
        &claude_envelope(r#"{"note":"I would rather talk about something else"}"#),
    );

    let error = run_expecting_failure(&stub, &scratch, &scratch.path("out.mp4")).await;
    assert!(matches!(error, AgentError::Malformed(_)), "got {error}");
    assert_eq!(error.title(), "Unusable answer");
}

#[tokio::test]
async fn a_cli_that_refuses_is_quoted_rather_than_second_guessed() {
    require_ffmpeg();
    let scratch = Scratch::new("refusal");
    let stub = StubAgent::new(Agent::ClaudeCode, "refusal");
    stub.put("exit.code", "1");
    stub.put("answer.err", "Not logged in. Run `claude auth login`.\n");

    let error = run_expecting_failure(&stub, &scratch, &scratch.path("out.mp4")).await;
    assert_eq!(error.title(), "Not signed in to the Claude Code CLI");
    assert!(
        error.to_string().contains("claude auth login"),
        "its own fix survives"
    );
    assert!(!error.is_retryable());
}

#[tokio::test]
async fn a_cli_that_has_moved_on_says_so_instead_of_quoting_a_usage_screen() {
    require_ffmpeg();
    let scratch = Scratch::new("outdated");
    let stub = StubAgent::new(Agent::ClaudeCode, "outdated");
    stub.put("exit.code", "1");
    // What a self-updating CLI that dropped a flag actually prints. Without this branch the
    // user sees a commander usage dump and has no idea it is not their fault.
    stub.put("answer.err", "error: unknown option '--json-schema'\n");

    let error = run_expecting_failure(&stub, &scratch, &scratch.path("out.mp4")).await;
    assert_eq!(error.title(), "the Claude Code CLI has changed");
    assert!(error
        .to_string()
        .contains("npm install -g @anthropic-ai/claude-code"));
    assert!(
        !error.is_retryable(),
        "retrying cannot teach the CLI a flag"
    );
}

#[tokio::test]
async fn cancelling_kills_the_agent_rather_than_leaving_it_running() {
    require_ffmpeg();
    let scratch = Scratch::new("cancel");
    let stub = StubAgent::new(Agent::ClaudeCode, "cancel");
    // Long enough that finishing would take far longer than the assertion below waits.
    stub.put("sleep", "30");
    stub.put(
        "answer.out",
        &claude_envelope(r#"{"transition":"fade","duration_secs":2}"#),
    );

    // Cancel a few checks in rather than on the first, so the child is genuinely mid-run
    // when it happens — that is both what a user does and what makes the kill meaningful.
    let checks = AtomicUsize::new(0);
    let started = std::time::Instant::now();
    let out = scratch.path("out.mp4");

    let error = transition(
        &stub.cli(),
        &Renderer::default(),
        &ExportSpec::default(),
        &TransitionJob {
            request: MotionRequest {
                prompt: "anything".into(),
                span_secs: None,
            },
            start_frame: scratch.still("a.png"),
            end_frame: scratch.still("b.png"),
            out: out.clone(),
        },
        &|_| {},
        // Checks run every 250 ms, so this lands about half a second into a wait the stub
        // would otherwise hold open for thirty.
        &|| checks.fetch_add(1, Ordering::SeqCst) >= 3,
    )
    .await
    .expect_err("a cancelled run must not return a transition");

    assert!(matches!(error, AgentError::Cancelled), "got {error}");
    assert!(
        started.elapsed() < std::time::Duration::from_secs(5),
        "Cancel has to stop the wait, not wait it out: took {:?}",
        started.elapsed()
    );
    assert!(stub.was_called(), "the child really was spawned");
    // The whole point. The stub writes `finished` as its last act, so its absence is proof
    // the process was killed — an agent left running is an agent still spending money.
    assert!(
        !stub.finished(),
        "the agent was abandoned rather than killed — it ran to completion after Cancel"
    );
    assert!(!out.exists());
}

/// Drive one run that is expected to fail, and hand back the error.
async fn run_expecting_failure(stub: &StubAgent, scratch: &Scratch, out: &Path) -> AgentError {
    transition(
        &stub.cli(),
        &Renderer::default(),
        &ExportSpec::default(),
        &TransitionJob {
            request: MotionRequest {
                prompt: "anything".into(),
                span_secs: None,
            },
            start_frame: scratch.still("a.png"),
            end_frame: scratch.still("b.png"),
            out: out.to_path_buf(),
        },
        &|_| {},
        &never(),
    )
    .await
    .expect_err("this run was supposed to fail")
}
