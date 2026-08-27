use std::fmt;

/// Everything that can go wrong talking to Higgsfield, in the shape the UI needs to
/// render its error states: a short title, a human sentence, and whether retrying helps.
#[derive(Debug, thiserror::Error)]
pub enum HiggsfieldError {
    #[error("no API key configured")]
    NotConfigured,

    #[error("authentication rejected (HTTP {status})")]
    Unauthorized { status: u16 },

    #[error("rate limited")]
    RateLimited { retry_after_secs: Option<u64> },

    #[error("API returned HTTP {status}")]
    Http { status: u16, body: String },

    #[error("network error: {0}")]
    Transport(String),

    #[error("unexpected API response: {0}")]
    Malformed(String),

    #[error("job failed: {0}")]
    JobFailed(String),

    #[error("io error: {0}")]
    Io(String),
}

impl HiggsfieldError {
    /// Short label for the error card header.
    pub fn title(&self) -> &'static str {
        match self {
            Self::NotConfigured => "Not connected",
            Self::Unauthorized { .. } => "Authentication failed",
            Self::RateLimited { .. } => "Rate limited",
            Self::Http { .. } => "Higgsfield rejected the request",
            Self::Transport(_) => "Network error",
            Self::Malformed(_) => "Unexpected response",
            Self::JobFailed(_) => "Generation failed",
            Self::Io(_) => "Could not save the result",
        }
    }

    /// Whether the same request is worth sending again unchanged.
    pub fn is_retryable(&self) -> bool {
        match self {
            Self::RateLimited { .. } | Self::Transport(_) => true,
            Self::Http { status, .. } => *status >= 500,
            _ => false,
        }
    }
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
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum JobState {
    Queued,
    Running { progress: f32 },
    Succeeded { video_url: String },
    Failed { message: String },
}

impl fmt::Display for JobState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Queued => write!(f, "queued"),
            Self::Running { progress } => write!(f, "running ({:.0}%)", progress * 100.0),
            Self::Succeeded { .. } => write!(f, "succeeded"),
            Self::Failed { message } => write!(f, "failed: {message}"),
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
    fn job_state_reads_well_in_a_log_line() {
        assert_eq!(
            JobState::Running { progress: 0.46 }.to_string(),
            "running (46%)"
        );
        assert_eq!(JobState::Queued.to_string(), "queued");
    }
}
