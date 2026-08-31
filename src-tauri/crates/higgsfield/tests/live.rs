//! An opt-in check against the real Higgsfield CLI.
//!
//! Everything else in this crate is proved against a stub executable, which pins what is
//! run but cannot prove the real CLI accepts it. This one does, for any machine that has
//! the CLI installed and signed in (`npm i -g @higgsfield/cli`, `higgsfield auth login`,
//! `higgsfield workspace set …`):
//!
//! ```text
//! cargo test -p solcut-higgsfield --test live -- --nocapture
//! ```
//!
//! Without the CLI on the machine — or with one that is not signed in — it reports that
//! and passes, so it is safe in the default `cargo test` run. It only ever lists the
//! video models — nothing is generated and nothing is charged. On a working setup it
//! also proves the app's default model id, `seedance_2_5`, exists in the live catalog —
//! the exact class of failure (a model the account cannot reach) that once 404'd every
//! default render.

use solcut_higgsfield::{Cli, HiggsfieldError, DEFAULT_MODEL};

#[tokio::test]
async fn the_real_cli_lists_the_default_model() {
    let Some(cli) = Cli::find() else {
        eprintln!("live: no `higgsfield` binary on this machine — skipping (install with `npm i -g @higgsfield/cli`)");
        return;
    };
    eprintln!("live: using {}", cli.binary().display());

    match cli.probe().await {
        Ok(count) => {
            eprintln!(
                "live: signed in; {} video models listed",
                count.map_or("?".to_string(), |n| n.to_string())
            );
        }
        Err(HiggsfieldError::Cli { message }) => {
            // Present but not signed in (or no workspace): that is this machine's state,
            // not a bug in the wrapper — report it and pass.
            eprintln!("live: CLI present but not usable — {message}");
            return;
        }
        Err(other) => panic!("the probe failed in an unexpected way: {other}"),
    }

    // A working setup must actually offer the default model, or every default render
    // dies at create. Checked against the raw listing so the shape does not matter.
    let output = tokio::process::Command::new(cli.binary())
        .args(["model", "list", "--video", "--json", "--no-color"])
        .output()
        .await
        .expect("run model list");
    let listing = String::from_utf8_lossy(&output.stdout);
    assert!(
        listing.contains(DEFAULT_MODEL),
        "the live catalog does not list the default model {DEFAULT_MODEL:?} — \
         pick a different default or check the account's plan.\nCatalog: {listing}"
    );
    eprintln!("live: default model {DEFAULT_MODEL:?} is in the catalog");
}
