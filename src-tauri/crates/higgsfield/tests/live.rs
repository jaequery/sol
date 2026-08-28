//! An opt-in check against the real Higgsfield API.
//!
//! Everything else in this crate is proved against a local stub, which pins what goes on
//! the wire but cannot prove Higgsfield accepts it. This one does, for anyone holding a
//! credential:
//!
//! ```text
//! HF_API_KEY_ID=… HF_API_KEY_SECRET=… \
//!   cargo test -p solcut-higgsfield --test live -- --nocapture
//!
//! # or the single-string form Higgsfield's own SDKs take
//! HF_KEY="key-id:key-secret" cargo test -p solcut-higgsfield --test live -- --nocapture
//! ```
//!
//! Without a credential in the environment it reports that and passes, so it is safe in
//! the default `cargo test` run. It only ever mints a presigned upload URL — nothing is
//! generated and nothing is charged.

use solcut_higgsfield::{Client, Config, HiggsfieldError};

/// A credential from the environment, under any of the names the official SDKs document.
fn credential_from_env() -> Option<Config> {
    let pair = |id: &str, secret: &str| Config {
        api_key_id: id.to_string(),
        api_key_secret: secret.to_string(),
        ..Config::default()
    };

    if let (Ok(id), Ok(secret)) = (
        std::env::var("HF_API_KEY_ID"),
        std::env::var("HF_API_KEY_SECRET"),
    ) {
        return Some(pair(&id, &secret));
    }
    // `HF_KEY` / `HF_CREDENTIALS` hold `key_id:key_secret` in one string; `Config` splits
    // it, so this leg exercises that path against the live API too.
    ["HF_KEY", "HF_CREDENTIALS"]
        .iter()
        .find_map(|name| std::env::var(name).ok())
        .map(|combined| pair(&combined, ""))
}

#[tokio::test]
async fn a_real_credential_authenticates_against_the_documented_api() {
    let Some(config) = credential_from_env() else {
        eprintln!(
            "skipped: set HF_API_KEY_ID and HF_API_KEY_SECRET (or HF_KEY=\"id:secret\") to \
             check a real credential against {}",
            Config::default().base_url
        );
        return;
    };

    let base_url = config.base_url.clone();
    let client = Client::new(config).expect("a whole credential");

    match client.check_credentials().await {
        Ok(()) => eprintln!("authenticated against {base_url}"),
        Err(HiggsfieldError::Unauthorized { detail, .. }) => {
            panic!("{base_url} rejected the credential: {detail}")
        }
        Err(other) => panic!("could not reach {base_url}: {other}"),
    }
}
