//! Readers for the documented Higgsfield response envelopes.
//!
//! Both shapes come straight from the published OpenAPI document
//! (<https://docs.higgsfield.ai/docs/openapi.json>, `Request`/`MediaOutput`):
//!
//! ```json
//! { "status": "queued", "request_id": "…", "status_url": "…", "cancel_url": "…" }
//! { "status": "completed", "request_id": "…", "video": { "url": "https://…/out.mp4" } }
//! ```
//!
//! Every function here is pure, so the behaviour is pinned by unit tests instead of by a
//! live endpoint.

use crate::error::{HiggsfieldError, JobState, Result};
use serde_json::Value;

/// What a submission returns: the id plus the URLs the API asks callers to use verbatim
/// rather than build themselves.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Accepted {
    pub request_id: String,
    pub status_url: String,
    pub cancel_url: String,
}

/// Read an accepted submission.
///
/// `status_url` and `cancel_url` are documented as always present, but they are cheap to
/// derive from `request_id`, so a response that omits them still works.
pub fn parse_submit(body: &Value, base_url: &str) -> Result<Accepted> {
    let request_id = body
        .get("request_id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            HiggsfieldError::Malformed(format!(
                "no request_id in the submit response (keys: {})",
                top_level_keys(body)
            ))
        })?
        .to_string();

    let base = base_url.trim_end_matches('/');
    Ok(Accepted {
        status_url: url_field(body, "status_url")
            .unwrap_or_else(|| format!("{base}/requests/{request_id}/status")),
        cancel_url: url_field(body, "cancel_url")
            .unwrap_or_else(|| format!("{base}/requests/{request_id}/cancel")),
        request_id,
    })
}

/// Reduce a `GET /requests/{id}/status` body to a single [`JobState`].
///
/// The documented statuses are `queued`, `in_progress`, `completed`, `failed`, `nsfw` and
/// `canceled`; anything else is reported as malformed rather than silently polled forever.
pub fn parse_state(body: &Value) -> Result<JobState> {
    let status = body
        .get("status")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            HiggsfieldError::Malformed(format!(
                "no status in the request status response (keys: {})",
                top_level_keys(body)
            ))
        })?
        .to_ascii_lowercase();

    match status.as_str() {
        "queued" => Ok(JobState::Queued),
        "in_progress" => Ok(JobState::Running {
            progress: progress_of(body),
        }),
        "completed" => match find_video_url(body) {
            Some(video_url) => Ok(JobState::Succeeded { video_url }),
            // The docs promise output URLs on `completed`, so an empty one is a real
            // failure rather than something another poll would fix.
            None => Err(HiggsfieldError::JobFailed(
                "the request completed without a video output".into(),
            )),
        },
        "failed" => Ok(JobState::Failed {
            message: error_of(body).unwrap_or_else(|| "the generation failed".into()),
        }),
        "nsfw" => Ok(JobState::Failed {
            message: error_of(body)
                .unwrap_or_else(|| "content moderation rejected the input or the output".into()),
        }),
        "canceled" | "cancelled" => Ok(JobState::Cancelled),
        other => Err(HiggsfieldError::Malformed(format!(
            "unrecognised request status {other:?}"
        ))),
    }
}

/// The video output of a completed request.
///
/// `video.url` is the documented place for a video model. Some operations return extra
/// artifacts (`mov`, `zip`, …) alongside it, so a named-object fallback covers the ones
/// that carry the clip under a different key.
pub fn find_video_url(body: &Value) -> Option<String> {
    if let Some(url) = media_url(body.get("video")) {
        return Some(url);
    }
    for key in ["videos", "mov", "output", "outputs"] {
        let Some(node) = body.get(key) else { continue };
        let found = match node {
            Value::Array(items) => items.iter().find_map(|i| media_url(Some(i))),
            other => media_url(Some(other)),
        };
        if found.is_some() {
            return found;
        }
    }
    None
}

/// A `MediaOutput` is `{ "url": "…" }`; a bare string is accepted for the artifact keys
/// that are documented as plain URLs.
fn media_url(node: Option<&Value>) -> Option<String> {
    let node = node?;
    let url = match node {
        Value::String(s) => s.as_str(),
        _ => node.get("url").and_then(Value::as_str)?,
    };
    looks_like_video(url).then(|| url.to_string())
}

fn looks_like_video(s: &str) -> bool {
    s.starts_with("http://") || s.starts_with("https://")
}

/// `error` is the documented field on a terminal failure; `detail` is the FastAPI
/// envelope the same service uses for synchronous errors.
fn error_of(body: &Value) -> Option<String> {
    ["error", "detail", "message"]
        .iter()
        .find_map(|k| body.get(k).and_then(Value::as_str))
        .map(str::to_owned)
        .filter(|s| !s.is_empty())
}

/// The status schema has no progress field, so a running request reports 0 unless the API
/// volunteers one — better an honest 0 than an invented estimate.
fn progress_of(body: &Value) -> f32 {
    ["progress", "percent", "percentage"]
        .iter()
        .find_map(|k| body.get(k).and_then(Value::as_f64))
        .map(|p| {
            let p = if p > 1.0 { p / 100.0 } else { p };
            (p as f32).clamp(0.0, 1.0)
        })
        .unwrap_or(0.0)
}

fn url_field(body: &Value, key: &str) -> Option<String> {
    body.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn top_level_keys(v: &Value) -> String {
    match v.as_object() {
        Some(map) => map.keys().cloned().collect::<Vec<_>>().join(", "),
        None => "<not an object>".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const BASE: &str = "https://api.higgsfield.ai";

    #[test]
    fn reads_the_documented_submit_envelope() {
        let body = json!({
            "status": "queued",
            "request_id": "d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff",
            "status_url": "https://api.higgsfield.ai/requests/d7e6c0f3/status",
            "cancel_url": "https://api.higgsfield.ai/requests/d7e6c0f3/cancel"
        });
        let accepted = parse_submit(&body, BASE).unwrap();
        assert_eq!(accepted.request_id, "d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff");
        assert_eq!(
            accepted.status_url, "https://api.higgsfield.ai/requests/d7e6c0f3/status",
            "the URL the API handed back is used verbatim"
        );
    }

    #[test]
    fn derives_the_urls_when_only_an_id_comes_back() {
        let accepted = parse_submit(&json!({"request_id": "abc"}), "https://api.higgsfield.ai/")
            .expect("submit");
        assert_eq!(
            accepted.status_url,
            "https://api.higgsfield.ai/requests/abc/status"
        );
        assert_eq!(
            accepted.cancel_url,
            "https://api.higgsfield.ai/requests/abc/cancel"
        );
    }

    #[test]
    fn reports_a_missing_request_id_with_context() {
        let err = parse_submit(&json!({"detail": "nope"}), BASE).unwrap_err();
        assert!(matches!(err, HiggsfieldError::Malformed(_)));
        assert!(err.to_string().contains("detail"), "{err}");
    }

    #[test]
    fn queued_and_in_progress_are_not_terminal() {
        assert_eq!(
            parse_state(&json!({"status": "queued", "request_id": "x"})).unwrap(),
            JobState::Queued
        );
        assert_eq!(
            parse_state(&json!({"status": "in_progress", "request_id": "x"})).unwrap(),
            JobState::Running { progress: 0.0 }
        );
    }

    #[test]
    fn a_volunteered_progress_is_used_and_normalised() {
        let body = json!({"status": "in_progress", "request_id": "x", "progress": 46});
        assert_eq!(
            parse_state(&body).unwrap(),
            JobState::Running { progress: 0.46 }
        );
    }

    #[test]
    fn completed_reads_the_video_output() {
        let body = json!({
            "status": "completed",
            "request_id": "x",
            "video": {"url": "https://cdn.example.com/video.mp4"}
        });
        assert_eq!(
            parse_state(&body).unwrap(),
            JobState::Succeeded {
                video_url: "https://cdn.example.com/video.mp4".into()
            }
        );
    }

    #[test]
    fn completed_without_an_output_is_a_failure_not_an_endless_poll() {
        let err = parse_state(&json!({"status": "completed", "request_id": "x"})).unwrap_err();
        assert!(matches!(err, HiggsfieldError::JobFailed(_)), "{err:?}");
    }

    #[test]
    fn failed_carries_the_documented_error_field() {
        let body = json!({"status": "failed", "request_id": "x", "error": "Generation failed"});
        assert_eq!(
            parse_state(&body).unwrap(),
            JobState::Failed {
                message: "Generation failed".into()
            }
        );
    }

    #[test]
    fn nsfw_explains_itself_even_with_no_error_field() {
        let JobState::Failed { message } =
            parse_state(&json!({"status": "nsfw", "request_id": "x"})).unwrap()
        else {
            panic!("expected a failure");
        };
        assert!(message.contains("moderation"), "{message}");
    }

    #[test]
    fn canceled_is_its_own_state() {
        assert_eq!(
            parse_state(&json!({"status": "canceled", "request_id": "x"})).unwrap(),
            JobState::Cancelled
        );
    }

    #[test]
    fn an_unknown_status_is_reported_rather_than_polled_forever() {
        let err = parse_state(&json!({"status": "wat", "request_id": "x"})).unwrap_err();
        assert!(matches!(err, HiggsfieldError::Malformed(_)), "{err:?}");
    }

    #[test]
    fn an_image_only_response_is_not_mistaken_for_a_video() {
        let body = json!({
            "status": "completed",
            "request_id": "x",
            "images": [{"url": "https://cdn.example.com/still.jpg"}]
        });
        assert!(parse_state(&body).is_err());
    }

    #[test]
    fn ignores_relative_urls() {
        assert!(!looks_like_video("/tmp/local.mp4"));
        assert!(looks_like_video("https://x.test/a.mp4?sig=abc"));
    }
}
