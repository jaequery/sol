fn main() {
    // The commit the backend was compiled from, carried on failure reports: `tauri dev`
    // hot-reloads the frontend while the Rust process keeps running old code, so without
    // a stamp a stale backend is indistinguishable from a fixed one. `git` may be absent
    // (a tarball build) and must not fail the build — the stamp degrades to "unknown".
    println!("cargo:rustc-env=SOLCUT_BUILD={}", build_stamp());
    if let Some(git_dir) = git(&["rev-parse", "--absolute-git-dir"]) {
        // Re-stamp when the checked-out commit moves; HEAD covers commits and switches.
        println!("cargo:rerun-if-changed={git_dir}/HEAD");
    }
    tauri_build::build()
}

fn build_stamp() -> String {
    match git(&["rev-parse", "--short=9", "HEAD"]) {
        Some(commit) => {
            let dirty = git(&["status", "--porcelain"]).is_some_and(|s| !s.is_empty());
            if dirty {
                format!("{commit}-dirty")
            } else {
                commit
            }
        }
        None => "unknown".into(),
    }
}

fn git(args: &[&str]) -> Option<String> {
    let out = std::process::Command::new("git").args(args).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}
