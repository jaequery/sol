//! Opt-in check against a real agent CLI: one motion question, asked exactly the way a
//! render asks it, and composited with the real ffmpeg.
//!
//! Everything else in this crate is proved against a stub executable, which pins what SolCut
//! *runs* but cannot prove the CLI accepts it. This one does — and it is the check that
//! catches the failure a stub structurally cannot: a CLI that updated itself and no longer
//! takes `--tools` or `--json-schema`.
//!
//! **It is opt-in twice over, and deliberately so.** `solcut-higgsfield`'s live test only
//! lists models, which is free; this one spends real money — about two cents on Claude — so
//! the CLI being installed is not on its own taken as consent. Both are needed:
//!
//! ```text
//! SOLCUT_LIVE_AGENT=1 cargo test -p solcut-agent --test live -- --nocapture
//! ```
//!
//! Without the opt-in, or without the CLI, it reports that and passes, so it is safe in a
//! plain `cargo test` run.
#![cfg(unix)]

use solcut_agent::{transition, Agent, AgentCli, MotionRequest, TransitionJob};
use solcut_render::{ExportSpec, Renderer};
use std::path::{Path, PathBuf};
use std::process::Command;

const OPT_IN: &str = "SOLCUT_LIVE_AGENT";

fn opted_in() -> bool {
    std::env::var(OPT_IN).map(|v| v == "1").unwrap_or(false)
}

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
    assert!(status.success());
    out
}

#[tokio::test]
async fn a_real_agent_cli_answers_with_a_motion_this_build_can_render() {
    if !opted_in() {
        eprintln!(
            "live: {OPT_IN} is not set — skipping. This test spends real money on the \
             user's plan, so an installed CLI is not on its own taken as consent."
        );
        return;
    }

    let mut asked = 0usize;
    for agent in Agent::ALL {
        let Some(cli) = AgentCli::find(*agent) else {
            eprintln!(
                "live: no {} on this machine — skipping it (install with `{}`)",
                agent.label(),
                agent.install()
            );
            continue;
        };
        eprintln!("live: using {}", cli.binary().display());

        let dir = std::env::temp_dir().join(format!("solcut-live-{}", agent.id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("workdir");
        let out = dir.join("out.mp4");

        // Deliberately a description with an obvious right answer, so a wrong one is
        // visible rather than merely arguable: something moving to the right should not come
        // back as a fade.
        let result = transition(
            &cli,
            &Renderer::default(),
            &ExportSpec::default(),
            &TransitionJob {
                request: MotionRequest {
                    prompt: "the camera sweeps across to the right, quick and snappy".into(),
                    span_secs: Some(2.0),
                },
                start_frame: still(&dir, "a.png", "1280x720"),
                end_frame: still(&dir, "b.png", "1280x720"),
                out: out.clone(),
            },
            &|step| eprintln!("live:   {} ({:.0}%)", step.status, step.progress * 100.0),
            &|| false,
        )
        .await;

        match result {
            Ok(recipe) => {
                eprintln!(
                    "live: {} chose {} for {:.1}s",
                    agent.label(),
                    recipe.transition,
                    recipe.duration_secs
                );
                assert!(
                    solcut_render::is_transition(&recipe.transition),
                    "a live answer has to be a motion this build renders"
                );
                assert!(
                    out.is_file(),
                    "the MP4 has to exist where the caller was told"
                );
                asked += 1;
            }
            // Present but not signed in, or out of plan credit: that is this machine's
            // state, not a bug in the wrapper. Report it and carry on.
            Err(e @ solcut_agent::AgentError::Cli { .. }) => {
                eprintln!("live: {} present but not usable — {e}", agent.label());
            }
            Err(other) => panic!("the live run failed in an unexpected way: {other}"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    if asked == 0 {
        eprintln!("live: no agent CLI on this machine was usable — nothing was proved");
    }
}
