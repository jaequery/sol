//! Stand-in `claude` and `codex` executables, shared by the flow tests.
//!
//! [`AgentCli::new`] takes a path rather than searching, which is the seam that lets a shell
//! script play the CLI: it prints a canned answer and appends every argv it was called with
//! to a log — so a test can assert the *exact* invocation SolCut makes, without the real
//! CLI, a login, or a penny spent.
//!
//! The script also writes a `finished` sentinel as its very last act. Nothing reads it on
//! the happy path; it exists so the cancellation test can prove the child was **killed**
//! rather than merely abandoned, which is the difference between Cancel stopping a paid
//! agent and Cancel only stopping the spinner.
#![cfg(unix)]
#![allow(dead_code)]

use solcut_agent::{Agent, AgentCli};
use std::path::PathBuf;

pub struct StubAgent {
    pub dir: PathBuf,
    pub agent: Agent,
}

impl StubAgent {
    pub fn new(agent: Agent, name: &str) -> Self {
        let dir =
            std::env::temp_dir().join(format!("solcut-stubagent-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("stub dir");

        // `sleep` is honoured before anything is printed, so a test can hold the child open
        // long enough to cancel it. `exit.code` makes it refuse, `answer.err` gives it
        // something to say on stderr while doing so.
        let script = r#"#!/bin/sh
dir="$(dirname "$0")"
printf '%s\0' "$@" >> "$dir/argv.log"
printf '\n--\n' >> "$dir/argv.log"
if [ -f "$dir/sleep" ]; then sleep "$(cat "$dir/sleep")"; fi
[ -f "$dir/answer.err" ] && cat "$dir/answer.err" >&2
[ -f "$dir/answer.out" ] && cat "$dir/answer.out"
code=0
[ -f "$dir/exit.code" ] && code=$(cat "$dir/exit.code")
: > "$dir/finished"
exit "$code"
"#;
        let binary = dir.join(agent.binary_names()[0]);
        std::fs::write(&binary, script).expect("stub script");
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        Self { dir, agent }
    }

    pub fn cli(&self) -> AgentCli {
        AgentCli::new(self.agent, self.dir.join(self.agent.binary_names()[0]))
    }

    pub fn put(&self, name: &str, content: &str) {
        std::fs::write(self.dir.join(name), content).expect("stub file");
    }

    /// Every argument of the last call, split apart — the script writes them NUL-separated
    /// so an argument containing spaces or newlines (the prompt, and the JSON schema) stays
    /// one item.
    pub fn argv(&self) -> Vec<String> {
        let raw = std::fs::read_to_string(self.dir.join("argv.log")).unwrap_or_default();
        // `.last()` rather than `.next_back()`: splitting on a multi-character pattern gives
        // an iterator that cannot be walked backwards.
        let last = raw
            .split("\n--\n")
            .filter(|c| !c.is_empty())
            .last()
            .unwrap_or_default();
        let mut parts: Vec<String> = last.split('\0').map(str::to_string).collect();
        // `printf '%s\0'` leaves a trailing separator, so the last piece is always empty.
        // Only that one is dropped: `--tools ""` is a genuinely empty argument and losing it
        // would hide the flag that carries the whole no-tools guarantee.
        if parts.last().is_some_and(String::is_empty) {
            parts.pop();
        }
        parts
    }

    pub fn was_called(&self) -> bool {
        self.dir.join("argv.log").exists()
    }

    /// Whether the stub ran to completion. False after a kill.
    pub fn finished(&self) -> bool {
        self.dir.join("finished").exists()
    }
}

impl Drop for StubAgent {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// A Claude `--output-format json` envelope carrying `structured_output`, which is the
/// shape `--json-schema` actually produces.
pub fn claude_envelope(structured: &str) -> String {
    format!(
        r#"{{"type":"result","subtype":"success","is_error":false,"num_turns":1,
            "session_id":"stub","total_cost_usd":0.02,"result":{},
            "structured_output":{structured}}}"#,
        serde_json::to_string(structured).unwrap()
    )
}
