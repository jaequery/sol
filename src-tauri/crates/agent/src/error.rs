use crate::Agent;

/// Everything that can go wrong asking an agent CLI for a motion, in the shape the UI's
/// error card already renders for Higgsfield: a short title, a human sentence, and whether
/// sending the same request again is worth anything.
///
/// Deliberately a small set. `HiggsfieldError` carries an HTTP-status scraper because the
/// Higgsfield CLI relays an API's bad day verbatim; there is no HTTP on this path at all —
/// a local binary either runs, refuses, hangs, or answers with something unusable.
#[derive(Debug, thiserror::Error)]
pub enum AgentError {
    /// The CLI is not on `PATH`, nor in the usual install prefixes.
    #[error("{} is not installed — run `{}`, then `{}`", .0.label(), .0.install(), .0.login())]
    NotInstalled(Agent),

    /// The CLI ran and refused. The message is its own words, which name their own fix —
    /// a logged-out session, an exhausted plan, an unknown model.
    #[error("{message}")]
    Cli { agent: Agent, message: String },

    /// The CLI rejected SolCut's own flags. These CLIs update themselves, so this is what
    /// a version drift looks like from here, and it is worth saying so rather than quoting
    /// a usage screen at someone who did nothing wrong.
    #[error(
        "{} did not understand how SolCut asked it — the CLI has changed. \
         Update SolCut, or reinstall the CLI with `{}`. It said: {message}",
        .agent.label(), .agent.install()
    )]
    Outdated { agent: Agent, message: String },

    #[error("{} did not answer within {secs} seconds", .agent.label())]
    Timeout { agent: Agent, secs: u64 },

    /// The CLI answered, but not with a motion this build can render.
    #[error("{0}")]
    Malformed(String),

    /// The user pressed Cancel. Not really an error, but it ends the run the same way.
    #[error("cancelled")]
    Cancelled,

    /// ffmpeg refused the composite. Carries `RenderError`'s own words, which already name
    /// a missing binary and a missing still.
    #[error("{0}")]
    Render(String),

    #[error("io error: {0}")]
    Io(String),
}

pub type Result<T> = std::result::Result<T, AgentError>;

impl From<solcut_render::RenderError> for AgentError {
    fn from(e: solcut_render::RenderError) -> Self {
        Self::Render(e.to_string())
    }
}

impl AgentError {
    /// Short label for the error card header.
    pub fn title(&self) -> String {
        match self {
            Self::NotInstalled(agent) => format!("{} not found", agent.label()),
            Self::Cli { agent, message } => {
                // The CLI's own stderr names the fix; the title names the state. Both CLIs
                // report a dead session in these words, and both are worth telling apart
                // from a plain refusal because only one of them the user can act on.
                let lower = message.to_ascii_lowercase();
                if lower.contains("not logged in")
                    || lower.contains("log in")
                    || lower.contains("login")
                    || lower.contains("unauthorized")
                    || lower.contains("401")
                {
                    format!("Not signed in to {}", agent.label())
                } else if lower.contains("usage limit")
                    || lower.contains("rate limit")
                    || lower.contains("quota")
                {
                    format!("{} is out of capacity", agent.label())
                } else {
                    format!("{} refused the request", agent.label())
                }
            }
            Self::Outdated { agent, .. } => format!("{} has changed", agent.label()),
            Self::Timeout { agent, .. } => format!("{} timed out", agent.label()),
            Self::Malformed(_) => "Unusable answer".to_string(),
            Self::Cancelled => "Cancelled".to_string(),
            Self::Render(_) => "Could not composite the transition".to_string(),
            Self::Io(_) => "Could not save the result".to_string(),
        }
    }

    /// Whether pressing Regenerate is worth anything.
    ///
    /// A model is not deterministic, so an answer that could not be read is the one failure
    /// here that a second identical attempt genuinely fixes. Everything else — a missing
    /// binary, a refusal, flags the CLI does not know, an ffmpeg that is not installed —
    /// will land in exactly the same place next time.
    pub fn is_retryable(&self) -> bool {
        matches!(self, Self::Timeout { .. } | Self::Malformed(_))
    }
}
