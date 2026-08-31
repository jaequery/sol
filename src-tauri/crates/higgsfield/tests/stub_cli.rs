//! A stand-in `higgsfield` executable, shared by the flow tests.
//!
//! [`Cli::new`] takes a path rather than searching, which is the seam that lets a shell
//! script play the CLI: it answers each subcommand from a canned file and appends every
//! argv it was called with to a log — so a test can assert the *exact* invocation SolCut
//! makes, without the real CLI, a login, or the internet.
#![cfg(unix)]
#![allow(dead_code)]

use solcut_higgsfield::Cli;
use std::path::PathBuf;

/// A scratch directory holding the stub binary, its canned answers, and its argv log.
pub struct StubCli {
    pub dir: PathBuf,
}

impl StubCli {
    pub fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("solcut-stub-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("stub dir");

        // The stub answers each subcommand from a canned file, `get` from a numbered
        // sequence, and appends every argv to a log for the assertions in the suites.
        let script = r#"#!/bin/sh
dir="$(dirname "$0")"
printf '%s\n' "$*" >> "$dir/argv.log"
case "$1 $2" in
  "generate create")
    [ -f "$dir/create.err" ] && { cat "$dir/create.err" >&2; exit 1; }
    cat "$dir/create.out"
    ;;
  "generate get")
    n=$(cat "$dir/gets" 2>/dev/null || echo 0); n=$((n+1)); printf '%s' "$n" > "$dir/gets"
    f="$dir/get.$n"; [ -f "$f" ] || f="$dir/get.last"
    cat "$f"
    ;;
  "model list")
    [ -f "$dir/models.err" ] && { cat "$dir/models.err" >&2; exit 1; }
    cat "$dir/models.out"
    ;;
  *)
    echo "unexpected: $*" >&2; exit 2
    ;;
esac
"#;
        let binary = dir.join("higgsfield");
        std::fs::write(&binary, script).expect("stub script");
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        Self { dir }
    }

    pub fn cli(&self) -> Cli {
        Cli::new(self.dir.join("higgsfield"))
    }

    pub fn put(&self, name: &str, content: &str) {
        std::fs::write(self.dir.join(name), content).expect("stub answer");
    }

    pub fn argv_log(&self) -> String {
        std::fs::read_to_string(self.dir.join("argv.log")).unwrap_or_default()
    }
}

impl Drop for StubCli {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
