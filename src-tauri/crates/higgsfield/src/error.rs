use std::fmt;

/// Everything that can go wrong generating through the Higgsfield CLI, in the shape the
/// UI needs to render its error states: a short title, a human sentence, and whether
/// retrying helps.
#[derive(Debug, thiserror::Error)]
pub enum HiggsfieldError {
    /// The `higgsfield` binary is not on `PATH` (or in the usual install locations).
    #[error(
        "the Higgsfield CLI is not installed — run `npm i -g @higgsfield/cli`, \
         then `higgsfield auth login`"
    )]
    NotInstalled,

    /// The CLI ran and refused. The message is the CLI's own words, which carry their own
    /// fix (`higgsfield auth login`, `hf workspace set …`, an unknown model id, …).
    #[error("{message}")]
    Cli { message: String },

    /// The CLI did not answer within the time budget and was stopped.
    #[error("the CLI did not answer `{what}` within {secs} seconds")]
    Timeout { what: String, secs: u64 },

    #[error("API returned HTTP {status}: {body}")]
    Http { status: u16, body: String },

    #[error("network error: {0}")]
    Transport(String),

    #[error("unexpected CLI output: {0}")]
    Malformed(String),

    /// A reference photo an image generation names cannot be sent: no file on disk, or
    /// not a format Higgsfield takes as an image reference. Caught before anything is
    /// submitted, so the card can name the photo rather than quote a CLI refusal.
    #[error("{0}")]
    BadReference(String),

    #[error("job failed: {0}")]
    JobFailed(String),

    #[error("io error: {0}")]
    Io(String),
}

impl HiggsfieldError {
    /// Short label for the error card header.
    pub fn title(&self) -> &'static str {
        match self {
            Self::NotInstalled => "Higgsfield CLI not found",
            Self::Cli { message } => {
                // The CLI's stderr names the fix; the title names the state. The two
                // phrases matched here are the CLI's own hints for an expired login and
                // a missing billing workspace.
                let lower = message.to_ascii_lowercase();
                if transient(&lower) {
                    "Higgsfield is unavailable"
                } else if lower.contains("auth login") || lower.contains("not authenticated") {
                    "Not signed in"
                } else if lower.contains("workspace") {
                    "No billing workspace"
                } else {
                    "Higgsfield refused the request"
                }
            }
            Self::Timeout { .. } => "Higgsfield CLI timed out",
            Self::Http { .. } => "Could not download the result",
            Self::Transport(_) => "Network error",
            Self::Malformed(_) => "Unexpected CLI output",
            Self::BadReference(_) => "Reference photo unavailable",
            Self::JobFailed(_) => "Generation failed",
            Self::Io(_) => "Could not save the result",
        }
    }

    /// Whether the same request is worth sending again unchanged.
    ///
    /// A CLI refusal (bad model id, not signed in, no credits) will refuse identically
    /// next time; a timeout, a network blip, or an upstream wobble the CLI is only
    /// relaying — a 5xx, a rate limit — is worth another go.
    pub fn is_retryable(&self) -> bool {
        match self {
            Self::Timeout { .. } | Self::Transport(_) => true,
            Self::Http { status, .. } => *status >= 500,
            Self::Cli { message } => transient(&message.to_ascii_lowercase()),
            _ => false,
        }
    }
}

/// Whether a CLI refusal is really the API's own bad day, quoted back.
///
/// The CLI prints the upstream status line verbatim — "Higgsfield API error (HTTP 503).
/// request failed with status 503 Service Unavailable" — so a status of 429 or 5xx read
/// out of that text says the request was never judged on its merits. Codes are only
/// trusted next to `http`/`status`, so a job id that happens to contain 503 is not
/// mistaken for one.
fn transient(lower: &str) -> bool {
    const PHRASES: &[&str] = &[
        "service unavailable",
        "bad gateway",
        "gateway timeout",
        "internal server error",
        "too many requests",
        "rate limit",
        "try again later",
        "temporarily unavailable",
        "overloaded",
    ];
    if PHRASES.iter().any(|p| lower.contains(p)) {
        return true;
    }
    ["http ", "status ", "http/1.1 ", "code "]
        .iter()
        .flat_map(|marker| {
            lower
                .match_indices(marker)
                .map(move |(at, _)| &lower[at + marker.len()..])
        })
        .filter_map(|rest| rest.get(..3).and_then(|code| code.parse::<u16>().ok()))
        .any(|code| code == 429 || (500..600).contains(&code))
}

impl From<reqwest::Error> for HiggsfieldError {
    fn from(e: reqwest::Error) -> Self {
        Self::Transport(strip_url(&e.to_string()))
    }
}

/// reqwest embeds the full request URL in its Display output, which can carry a signed
/// download token. Errors reach the UI and the log, so drop it.
fn strip_url(msg: &str) -> String {
    match msg.find("for url (") {
        Some(idx) => msg[..idx].trim_end_matches([':', ' ']).to_string(),
        None => msg.to_string(),
    }
}

pub type Result<T> = std::result::Result<T, HiggsfieldError>;

/// A snapshot of a running job, as the UI wants to show it.
///
/// One variant per terminal state the CLI reports; `nsfw` arrives as a
/// [`JobState::Failed`] carrying the moderation reason, because the UI treats it the same.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum JobState {
    Queued,
    Running { progress: f32 },
    Succeeded { result_url: String },
    Failed { message: String },
    Cancelled,
}

impl fmt::Display for JobState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Queued => write!(f, "queued"),
            Self::Running { progress } => write!(f, "running ({:.0}%)", progress * 100.0),
            Self::Succeeded { .. } => write!(f, "succeeded"),
            Self::Failed { message } => write!(f, "failed: {message}"),
            Self::Cancelled => write!(f, "cancelled"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transport_errors_do_not_leak_the_signed_url() {
        // reqwest puts the full URL in its Display output, and a download URL can carry a
        // signed token. Errors reach both the UI and the log, so it has to go.
        let stripped =
            strip_url("error sending request for url (https://cdn.test/a.mp4?token=SECRET)");
        assert!(!stripped.contains("SECRET"), "{stripped}");
        assert_eq!(stripped, "error sending request");
    }

    #[test]
    fn messages_without_a_url_are_left_alone() {
        assert_eq!(strip_url("connection closed"), "connection closed");
    }

    #[test]
    fn an_upstream_wobble_the_cli_relays_is_worth_another_go() {
        let err = HiggsfieldError::Cli {
            message: "Error: Higgsfield API error (HTTP 503). request failed with status 503 \
                      Service Unavailable"
                .into(),
        };
        assert!(
            err.is_retryable(),
            "a 503 is the API's bad day, not the request's"
        );
        assert_eq!(err.title(), "Higgsfield is unavailable");

        for message in [
            "Error: Higgsfield API error (HTTP 429). too many requests",
            "Error: rate limit exceeded, try again later",
            "Error: bad gateway",
        ] {
            let err = HiggsfieldError::Cli {
                message: message.into(),
            };
            assert!(err.is_retryable(), "{message}");
        }
    }

    #[test]
    fn a_refusal_the_same_request_would_earn_again_is_not_retryable() {
        for message in [
            "Error: Session expired. Hint: Re-run `higgsfield auth login`.",
            "Error: unknown model id `seedance_9_9`",
            "Error: no billing workspace selected",
            // A job id is not a status code, however 503-shaped it looks.
            "Error: job 503503-1234 was rejected: the prompt is empty",
        ] {
            let err = HiggsfieldError::Cli {
                message: message.into(),
            };
            assert!(!err.is_retryable(), "{message}");
        }
    }

    #[test]
    fn job_state_reads_well_in_a_log_line() {
        assert_eq!(
            JobState::Running { progress: 0.46 }.to_string(),
            "running (46%)"
        );
        assert_eq!(JobState::Queued.to_string(), "queued");
        assert_eq!(JobState::Cancelled.to_string(), "cancelled");
    }

    #[test]
    fn a_cli_refusal_is_titled_by_what_it_says() {
        let title = |message: &str| {
            HiggsfieldError::Cli {
                message: message.into(),
            }
            .title()
        };
        assert_eq!(
            title("Session expired. Re-run `higgsfield auth login`."),
            "Not signed in"
        );
        assert_eq!(
            title("No workspace selected.\nHint: Run: hf workspace set <workspace_id>"),
            "No billing workspace"
        );
        assert_eq!(
            title("unknown job type \"seedance_9\""),
            "Higgsfield refused the request"
        );
    }

    #[test]
    fn refusals_are_not_retried_but_blips_are() {
        assert!(!HiggsfieldError::Cli {
            message: "unknown job type".into()
        }
        .is_retryable());
        assert!(HiggsfieldError::Timeout {
            what: "generate get".into(),
            secs: 60
        }
        .is_retryable());
        assert!(HiggsfieldError::Transport("connection reset".into()).is_retryable());
        assert!(HiggsfieldError::Http {
            status: 503,
            body: String::new()
        }
        .is_retryable());
        assert!(!HiggsfieldError::Http {
            status: 404,
            body: String::new()
        }
        .is_retryable());
        assert!(!HiggsfieldError::NotInstalled.is_retryable());
    }

    #[test]
    fn the_not_installed_error_names_the_install_command() {
        let message = HiggsfieldError::NotInstalled.to_string();
        assert!(message.contains("npm i -g @higgsfield/cli"), "{message}");
        assert!(message.contains("higgsfield auth login"), "{message}");
    }
}
