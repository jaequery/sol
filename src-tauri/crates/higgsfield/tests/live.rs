//! Opt-in checks against the real Higgsfield — the CLI that renders, and the Cloud API
//! key that Settings stores. Both skip and pass when the machine has nothing to prove
//! with, so a plain `cargo test` never reaches the network.
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

use solcut_higgsfield::{
    check_credential, Cli, Credential, HiggsfieldError, API_BASE_URL, DEFAULT_MODEL,
};
use std::time::Duration;

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

/// An opt-in check of the *Cloud API* key against the real platform.
///
/// The stub server pins what SolCut sends; only the real host can prove what it answers.
/// Supply a credential and this asks `api.higgsfield.ai` about a request id that belongs
/// to nobody — one free, read-only call that generates nothing:
///
/// ```text
/// HF_API_KEY_ID=… HF_API_KEY_SECRET=… \
///   cargo test -p solcut-higgsfield --test live -- --nocapture
/// # or, as Higgsfield's own SDKs carry it:
/// HF_KEY=key_id:key_secret cargo test -p solcut-higgsfield --test live -- --nocapture
/// ```
///
/// With no credential in the environment it says so and passes, so it stays safe in a
/// plain `cargo test` run.
#[tokio::test]
async fn a_real_key_is_accepted_by_the_live_platform() {
    let Some(credential) = credential_from_env() else {
        eprintln!(
            "live: no Cloud API key in the environment — skipping \
             (set HF_API_KEY_ID + HF_API_KEY_SECRET, or HF_KEY=id:secret)"
        );
        return;
    };

    let verdict = check_credential(&credential, API_BASE_URL).await;
    eprintln!(
        "live: {} — {}",
        verdict.title(),
        verdict.describe(Duration::ZERO)
    );
    assert!(
        verdict.accepted(),
        "the live platform did not accept the supplied key: {verdict:?}"
    );
}

/// The credential as the two halves, or as the single `id:secret` string Higgsfield's own
/// SDKs pass around.
fn credential_from_env() -> Option<Credential> {
    let two_halves = Credential::parse(
        &std::env::var("HF_API_KEY_ID").unwrap_or_default(),
        &std::env::var("HF_API_KEY_SECRET").unwrap_or_default(),
    );
    two_halves.or_else(|| {
        let whole = std::env::var("HF_KEY")
            .or_else(|_| std::env::var("HF_CREDENTIALS"))
            .unwrap_or_default();
        Credential::parse(&whole, "")
    })
}
