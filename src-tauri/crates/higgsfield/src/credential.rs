//! The Higgsfield **Cloud API** credential — a key id and a secret — and the one free
//! call that proves it.
//!
//! This is a different credential from the one the rest of this crate uses. Renders go
//! through the official CLI ([`crate::Cli`]), which signs in as your higgsfield.ai account
//! and bills its subscription workspace; the CLI has no notion of an API key at all. The
//! credential here belongs to the token-metered platform at [`API_BASE_URL`], where keys
//! are minted at `cloud.higgsfield.ai` and billed against a separate balance. SolCut
//! stores one so it can be kept and proved, and this module is the proving.
//!
//! The check is deliberately the *documented* read-only route,
//! `GET /requests/{request_id}/status`, asked about a request id that cannot exist. Its
//! OpenAPI entry publishes 401 "Missing or invalid API credentials" and 404 "The request
//! does not exist or belongs to another account" — so a `404` is proof the credential got
//! past authentication, and a `401` is proof it did not. It generates nothing and costs
//! nothing.
//!
//! Everything else is [`KeyVerdict::Inconclusive`] rather than a pass — a `200` included,
//! since a request id that belongs to nobody cannot be found and something else must be
//! answering. That strictness is the point: the gateway replies `405` to a GET on a path
//! it does not route, *before* looking at any credential, so a design that read "not a
//! 401" as success would call a moved route, a rate limit or a challenge page a working
//! key.

use serde_json::Value;
use std::time::Duration;

/// The Cloud API platform's host, from the `servers` entry of Higgsfield's own OpenAPI
/// document (<https://docs.higgsfield.ai/docs/openapi.json>).
pub const API_BASE_URL: &str = "https://api.higgsfield.ai";

/// The all-zero UUID. A well-formed request id that belongs to nobody, so an authenticated
/// caller is answered `404` — which is precisely the signal wanted, without naming any
/// real request.
const PROBE_REQUEST_ID: &str = "00000000-0000-0000-0000-000000000000";

/// The documented authentication scheme: `Authorization: Key {key_id}:{key_secret}`.
/// <https://docs.higgsfield.ai/docs/authentication>
pub const AUTH_SCHEME: &str = "Key";

/// A whole check is one request; anything slower than this is not going to answer.
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);

/// A Cloud API credential: the two halves that form one `Authorization` header.
///
/// Constructed only through [`Credential::parse`], so a value of this type is always
/// whole and always safe to put in a header.
#[derive(Clone, PartialEq, Eq)]
pub struct Credential {
    id: String,
    secret: String,
}

/// Deliberately hand-written: a derived `Debug` would print the secret into any log line
/// or panic message that formatted a value holding one.
impl std::fmt::Debug for Credential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credential")
            .field("id", &mask(&self.id))
            .field("secret", &"<redacted>")
            .finish()
    }
}

impl Credential {
    /// The two halves as a credential, or `None` when what is held is not a whole one.
    ///
    /// Higgsfield issues *one* credential in two parts, and its own SDKs pass the pair
    /// around as a single `key_id:key_secret` string. Someone who pastes that whole string
    /// into the id box has a perfectly good credential, so it is split on the first colon
    /// rather than sent as `Key id:secret:` and called invalid. The secret may itself
    /// contain colons, so only the first one separates.
    pub fn parse(id: &str, secret: &str) -> Option<Self> {
        let id = id.trim();
        let secret = secret.trim();

        let (id, secret) = if secret.is_empty() {
            let (id, secret) = id.split_once(':')?;
            (id.trim(), secret.trim())
        } else {
            (id, secret)
        };

        if id.is_empty() || secret.is_empty() || !header_safe(id) || !header_safe(secret) {
            return None;
        }
        Some(Self {
            id: id.to_string(),
            secret: secret.to_string(),
        })
    }

    /// The key id, masked for display. The secret has no accessor at all.
    pub fn masked_id(&self) -> String {
        mask(&self.id)
    }

    /// The id as stored — never the secret, and never shown to the frontend.
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn secret(&self) -> &str {
        &self.secret
    }

    /// The `Authorization` header value the docs specify.
    pub fn header_value(&self) -> String {
        format!("{AUTH_SCHEME} {}:{}", self.id, self.secret)
    }
}

/// A header value cannot carry a control character or a non-ASCII byte; a credential that
/// does is a copy-paste accident, not a key.
fn header_safe(s: &str) -> bool {
    s.chars().all(|c| c.is_ascii() && !c.is_ascii_control())
}

/// Last four characters, everything before them masked — e.g. `••••7fa2`.
pub fn mask(key: &str) -> String {
    let key = key.trim();
    if key.is_empty() {
        return String::new();
    }
    let visible: String = key
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!(
        "{}{visible}",
        "•".repeat(key.chars().count().saturating_sub(4).min(20))
    )
}

/// What one credential check concluded.
///
/// Only [`KeyVerdict::Accepted`] is a pass. The rest are distinct on purpose: a `403` is
/// not a bad key (the platform documents it for an account that will not serve the
/// request, typically out of credits), and an answer the API does not publish for this
/// route proves nothing either way.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyVerdict {
    /// `404` — authentication passed and the made-up request was, correctly, not found.
    Accepted,
    /// `401` — the credential itself was refused.
    Rejected { detail: String },
    /// `403` — the credential authenticated; the account would not serve the call.
    Refused { detail: String },
    /// Any other status. Proves nothing, and is never reported as a pass.
    Inconclusive { status: u16, detail: String },
    /// The request never got an answer.
    Unreachable { detail: String },
}

impl KeyVerdict {
    /// Whether the key is proved good. Only an outright acceptance counts.
    pub fn accepted(&self) -> bool {
        matches!(self, Self::Accepted)
    }

    /// The heading the result box shows.
    pub fn title(&self) -> &'static str {
        match self {
            Self::Accepted => "API key accepted",
            Self::Rejected { .. } => "API key rejected",
            Self::Refused { .. } => "Higgsfield refused the key",
            Self::Inconclusive { .. } => "Could not prove the API key",
            Self::Unreachable { .. } => "Could not reach Higgsfield",
        }
    }

    /// The sentence under the heading. Higgsfield's own words are quoted wherever it gave
    /// any, so a refusal names its own fix rather than being translated into a guess.
    pub fn describe(&self, elapsed: Duration) -> String {
        let ms = elapsed.as_millis();
        match self {
            Self::Accepted => format!(
                "Higgsfield authenticated the key against {API_BASE_URL} ({ms} ms). \
                 Renders still run through the CLI on your subscription — this key is not \
                 used for them."
            ),
            Self::Rejected { detail } => format!(
                "Higgsfield did not accept this key id and secret: {detail}. \
                 Keys are minted at cloud.higgsfield.ai, and both halves are needed."
            ),
            Self::Refused { detail } => format!(
                "The key authenticated, but the account would not serve the call: {detail}. \
                 That is usually an empty Cloud balance rather than a bad key."
            ),
            Self::Inconclusive { status, detail } => format!(
                "Higgsfield answered HTTP {status}, which says nothing about the key \
                 either way: {detail}"
            ),
            Self::Unreachable { detail } => {
                format!("The check could not reach {API_BASE_URL}: {detail}")
            }
        }
    }
}

/// Prove a credential against the platform, without generating anything.
///
/// `base_url` is a parameter rather than a constant so the tests can point it at a stub;
/// the app always passes [`API_BASE_URL`].
pub async fn check_credential(credential: &Credential, base_url: &str) -> KeyVerdict {
    let url = format!(
        "{}/requests/{PROBE_REQUEST_ID}/status",
        base_url.trim_end_matches('/')
    );

    let http = match reqwest::Client::builder().timeout(CHECK_TIMEOUT).build() {
        Ok(client) => client,
        Err(e) => {
            return KeyVerdict::Unreachable {
                detail: e.to_string(),
            }
        }
    };

    let response = match http
        .get(&url)
        .header(reqwest::header::AUTHORIZATION, credential.header_value())
        .send()
        .await
    {
        Ok(response) => response,
        Err(e) => {
            return KeyVerdict::Unreachable {
                detail: e.to_string(),
            }
        }
    };

    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    classify(status, &body)
}

/// Turn one answer into a verdict. Split out from the request so every branch is testable
/// without a socket.
pub fn classify(status: u16, body: &str) -> KeyVerdict {
    let detail = detail_of(body);
    match status {
        // The made-up request id is not found — which only an authenticated caller is
        // told, and the whole point of the probe.
        404 => KeyVerdict::Accepted,
        401 => KeyVerdict::Rejected { detail },
        403 => KeyVerdict::Refused { detail },
        // Deliberately not a pass, `200` included: a request id that belongs to nobody
        // cannot be found, so a `200` is something answering on the platform's behalf —
        // a proxy or a challenge page — rather than proof of anything.
        status => KeyVerdict::Inconclusive { status, detail },
    }
}

/// The API's own explanation, from the `detail` its error schema uses. Anything else is
/// quoted as it arrived, trimmed, so an HTML challenge page cannot fill the dialog.
fn detail_of(body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return "no explanation given".to_string();
    }
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        for key in ["detail", "message", "error"] {
            if let Some(text) = value.get(key).and_then(Value::as_str) {
                if !text.trim().is_empty() {
                    return text.trim().to_string();
                }
            }
        }
    }
    crate::preview(trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_credential_is_the_two_halves_and_needs_both() {
        let cred = Credential::parse("test-id", "test-secret").expect("whole");
        assert_eq!(cred.header_value(), "Key test-id:test-secret");

        assert!(Credential::parse("test-id", "").is_none(), "no secret");
        assert!(Credential::parse("", "test-secret").is_none(), "no id");
        assert!(Credential::parse("  ", "  ").is_none(), "nothing at all");
    }

    /// Higgsfield's own SDKs carry the pair as one `key_id:key_secret` string, so a whole
    /// paste into the id box is a good credential — not a key id with a colon in it.
    #[test]
    fn a_credential_pasted_whole_is_split_on_its_first_colon() {
        let cred = Credential::parse("  test-id:test-secret\n", "").expect("pasted");
        assert_eq!(cred.header_value(), "Key test-id:test-secret");

        // A secret may itself contain colons; only the first one separates.
        let cred = Credential::parse("id:se:cret", "").expect("pasted");
        assert_eq!(cred.header_value(), "Key id:se:cret");
    }

    #[test]
    fn a_typed_secret_wins_over_splitting_the_id() {
        let cred = Credential::parse("id:not-the-secret", "typed").expect("whole");
        assert_eq!(cred.header_value(), "Key id:not-the-secret:typed");
    }

    #[test]
    fn a_credential_that_could_not_go_in_a_header_is_not_a_credential() {
        assert!(Credential::parse("id\nX-Evil: 1", "secret").is_none());
        assert!(Credential::parse("id", "sec\r\nret").is_none());
        assert!(Credential::parse("idé", "secret").is_none());
    }

    #[test]
    fn the_secret_never_appears_in_a_debug_rendering() {
        let cred = Credential::parse("hf_live_abcdef7fa2", "shh-the-secret").expect("whole");
        let shown = format!("{cred:?}");
        assert!(!shown.contains("shh-the-secret"), "{shown}");
        assert!(!shown.contains("hf_live_abcdef"), "{shown}");
        assert!(shown.contains("7fa2"), "{shown}");
    }

    #[test]
    fn masking_keeps_only_the_last_four_characters() {
        assert_eq!(mask("hf_live_abcdef7fa2"), "••••••••••••••7fa2");
        assert_eq!(mask(""), "");
        assert_eq!(mask("ab"), "ab", "a short key reveals no more than it has");
    }

    /// The heart of the check. A `404` is the documented answer to an authenticated
    /// caller asking after a request that is not theirs; `401` is the documented answer to
    /// a bad credential. Everything the route does not publish is inconclusive — never a
    /// pass — because the gateway answers `405` for an unrouted GET *before* it looks at
    /// the credential, and a rate limit or a challenge page would otherwise read as good.
    #[test]
    fn only_the_documented_answers_decide_and_the_rest_are_inconclusive() {
        assert_eq!(
            classify(404, r#"{"detail":"not found"}"#),
            KeyVerdict::Accepted
        );

        assert_eq!(
            classify(401, r#"{"detail":"Invalid credentials"}"#),
            KeyVerdict::Rejected {
                detail: "Invalid credentials".into()
            }
        );

        for (status, body) in [
            // A GET to a path the gateway does not route — answered before any credential
            // is looked at, so it says nothing about the key.
            (405u16, ""),
            (429, r#"{"detail":"slow down"}"#),
            (500, "upstream exploded"),
            // A challenge page or a captive proxy answering 200 in the API's place. The
            // nil request id belongs to nobody, so a 200 is never Higgsfield agreeing.
            (200, "<html>just a moment…</html>"),
        ] {
            let verdict = classify(status, body);
            assert!(
                matches!(verdict, KeyVerdict::Inconclusive { .. }),
                "HTTP {status} must not decide anything: {verdict:?}"
            );
            assert!(!verdict.accepted(), "HTTP {status} is not a pass");
        }
    }

    /// A `403` is an account that will not serve the call — the old build documented and
    /// tested this as insufficient credits. Reporting it as a bad key sends someone off to
    /// re-mint a credential that was fine.
    #[test]
    fn a_403_is_the_account_refusing_rather_than_a_bad_key() {
        let verdict = classify(403, r#"{"detail":"Insufficient credits"}"#);
        assert_eq!(
            verdict,
            KeyVerdict::Refused {
                detail: "Insufficient credits".into()
            }
        );
        assert!(!verdict.accepted());
        assert!(verdict
            .describe(Duration::ZERO)
            .contains("Insufficient credits"));
        assert!(verdict.describe(Duration::ZERO).contains("balance"));
    }

    #[test]
    fn the_apis_own_words_are_what_the_dialog_quotes() {
        assert_eq!(
            detail_of(r#"{"detail":"Invalid credentials"}"#),
            "Invalid credentials"
        );
        assert_eq!(detail_of(r#"{"message":"nope"}"#), "nope");
        assert_eq!(detail_of("   "), "no explanation given");
        assert_eq!(detail_of("plain words"), "plain words");
        assert!(
            detail_of(&"x".repeat(5_000)).chars().count() <= 201,
            "a challenge page cannot fill the dialog"
        );
    }

    #[test]
    fn every_verdict_has_its_own_heading_and_only_acceptance_passes() {
        let verdicts = [
            KeyVerdict::Accepted,
            KeyVerdict::Rejected { detail: "d".into() },
            KeyVerdict::Refused { detail: "d".into() },
            KeyVerdict::Inconclusive {
                status: 418,
                detail: "d".into(),
            },
            KeyVerdict::Unreachable { detail: "d".into() },
        ];
        let titles: Vec<_> = verdicts.iter().map(|v| v.title()).collect();
        let mut unique = titles.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(
            unique.len(),
            titles.len(),
            "each verdict says its own thing"
        );

        assert_eq!(
            verdicts.iter().filter(|v| v.accepted()).count(),
            1,
            "only an acceptance is a pass"
        );
    }

    /// The success line has to say the thing a user would otherwise get wrong: a good key
    /// does not mean renders use it.
    #[test]
    fn acceptance_says_the_key_is_not_what_renders_use() {
        let said = KeyVerdict::Accepted.describe(Duration::from_millis(210));
        assert!(said.contains("210 ms"), "{said}");
        assert!(said.contains("CLI"), "{said}");
    }
}
