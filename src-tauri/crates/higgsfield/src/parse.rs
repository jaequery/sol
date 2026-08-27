//! Tolerant readers for Higgsfield's JSON.
//!
//! The public API has moved its envelope around more than once (`id` vs `job_set_id`,
//! results under `results.raw.url` vs `result.url`, status on the set vs on each job).
//! Rather than pin one shape and break on the next revision, we look for the *meaning*
//! anywhere in the document. Every function here is pure, so the behaviour is pinned by
//! unit tests instead of by a live endpoint.

use crate::error::{HiggsfieldError, JobState, Result};
use serde_json::Value;

const ID_KEYS: &[&str] = &["job_set_id", "jobSetId", "job_set", "id"];
const STATUS_KEYS: &[&str] = &["status", "state"];
const PROGRESS_KEYS: &[&str] = &["progress", "percent", "percentage", "completion"];
const VIDEO_EXTS: &[&str] = &[".mp4", ".mov", ".webm", ".m4v"];

/// Pull the job-set id out of a submit response.
pub fn parse_submit(body: &Value) -> Result<String> {
    // Prefer a top-level id; fall back to the first one found at any depth.
    for key in ID_KEYS {
        if let Some(s) = body.get(key).and_then(as_id) {
            return Ok(s);
        }
    }
    if let Some(s) = find_first(body, |k, v| {
        ID_KEYS.contains(&k).then(|| as_id(v)).flatten()
    }) {
        return Ok(s);
    }
    Err(HiggsfieldError::Malformed(format!(
        "no job id in submit response (keys: {})",
        top_level_keys(body)
    )))
}

/// Reduce a poll response to a single [`JobState`].
///
/// A set can hold several jobs. The set is only finished when every job is; it has
/// failed as soon as any job has; otherwise it is running at the mean progress.
pub fn parse_state(body: &Value) -> JobState {
    let jobs = collect_jobs(body);

    if let Some(err) = find_failure(body, &jobs) {
        return JobState::Failed { message: err };
    }

    // Completed is only meaningful together with an output, otherwise we keep polling.
    let all_done = !jobs.is_empty()
        && jobs
            .iter()
            .all(|j| status_of(j).is_some_and(|s| is_terminal_ok(&s)));
    let set_done = status_of(body).is_some_and(|s| is_terminal_ok(&s));

    if all_done || set_done || jobs.is_empty() {
        if let Some(url) = find_video_url(body) {
            return JobState::Succeeded { video_url: url };
        }
    }

    match find_progress(body, &jobs) {
        Some(p) if p > 0.0 => JobState::Running { progress: p },
        _ => {
            let started = jobs
                .iter()
                .chain(std::iter::once(&body))
                .any(|v| status_of(v).is_some_and(|s| is_running(&s)));
            if started {
                JobState::Running { progress: 0.0 }
            } else {
                JobState::Queued
            }
        }
    }
}

/// Find the first URL that looks like a rendered video.
pub fn find_video_url(body: &Value) -> Option<String> {
    // A `raw`/`min` results object is the documented place; prefer the highest quality.
    for key in ["raw", "original", "hd", "min", "preview"] {
        if let Some(url) = find_first(body, |k, v| {
            (k == key)
                .then(|| v.get("url").and_then(Value::as_str).map(str::to_owned))
                .flatten()
                .filter(|u| looks_like_video(u))
        }) {
            return Some(url);
        }
    }
    find_first(body, |_, v| {
        v.as_str()
            .filter(|s| looks_like_video(s))
            .map(str::to_owned)
    })
}

fn looks_like_video(s: &str) -> bool {
    if !(s.starts_with("http://") || s.starts_with("https://")) {
        return false;
    }
    let path = s.split(['?', '#']).next().unwrap_or(s).to_ascii_lowercase();
    VIDEO_EXTS.iter().any(|ext| path.ends_with(ext))
}

fn collect_jobs(body: &Value) -> Vec<&Value> {
    for key in ["jobs", "job_set", "items", "results"] {
        if let Some(arr) = body.get(key).and_then(Value::as_array) {
            return arr.iter().collect();
        }
    }
    Vec::new()
}

fn status_of(v: &Value) -> Option<String> {
    STATUS_KEYS
        .iter()
        .find_map(|k| v.get(k).and_then(Value::as_str))
        .map(|s| s.to_ascii_lowercase())
}

fn is_terminal_ok(status: &str) -> bool {
    matches!(
        status,
        "completed" | "complete" | "succeeded" | "success" | "done" | "finished" | "ready"
    )
}

fn is_running(status: &str) -> bool {
    matches!(
        status,
        "running" | "processing" | "in_progress" | "started" | "generating"
    )
}

fn is_failed(status: &str) -> bool {
    matches!(
        status,
        "failed" | "error" | "canceled" | "cancelled" | "rejected" | "nsfw"
    )
}

fn find_failure(body: &Value, jobs: &[&Value]) -> Option<String> {
    let holder = jobs
        .iter()
        .copied()
        .chain(std::iter::once(body))
        .find(|v| status_of(v).is_some_and(|s| is_failed(&s)))?;

    let reason = ["error", "message", "detail", "reason", "failure_reason"]
        .iter()
        .find_map(|k| holder.get(k).and_then(Value::as_str))
        .map(str::to_owned)
        .or_else(|| status_of(holder));

    Some(reason.unwrap_or_else(|| "the job did not complete".into()))
}

/// Mean progress across jobs, normalised to 0..1 (the API has used both 0..1 and 0..100).
fn find_progress(body: &Value, jobs: &[&Value]) -> Option<f32> {
    let read = |v: &Value| -> Option<f32> {
        PROGRESS_KEYS
            .iter()
            .find_map(|k| v.get(k).and_then(Value::as_f64))
            .map(|p| normalise_progress(p as f32))
    };

    if !jobs.is_empty() {
        let vals: Vec<f32> = jobs.iter().filter_map(|j| read(j)).collect();
        if !vals.is_empty() {
            return Some(vals.iter().sum::<f32>() / vals.len() as f32);
        }
    }
    read(body)
}

fn normalise_progress(p: f32) -> f32 {
    let p = if p > 1.0 { p / 100.0 } else { p };
    p.clamp(0.0, 1.0)
}

fn as_id(v: &Value) -> Option<String> {
    match v {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Object(o) => o.get("id").and_then(as_id),
        Value::Array(a) => a.first().and_then(as_id),
        _ => None,
    }
}

/// Depth-first walk, returning the first non-`None` the visitor produces.
///
/// Object entries are visited with their key. Array elements have no key of their own, so
/// they are visited with an empty one — without that, a bare `{"output": ["…mp4"]}` would
/// never reach the visitor at all.
fn find_first<T>(v: &Value, f: impl Fn(&str, &Value) -> Option<T> + Copy) -> Option<T> {
    match v {
        Value::Object(map) => {
            for (k, child) in map {
                if let Some(found) = f(k, child) {
                    return Some(found);
                }
            }
            map.values().find_map(|child| find_first(child, f))
        }
        Value::Array(items) => items
            .iter()
            .find_map(|child| f("", child).or_else(|| find_first(child, f))),
        _ => None,
    }
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

    #[test]
    fn reads_a_top_level_id() {
        assert_eq!(parse_submit(&json!({"id": "js_abc"})).unwrap(), "js_abc");
    }

    #[test]
    fn reads_a_snake_case_job_set_id() {
        let body = json!({"job_set_id": "js_123", "id": "ignored_because_specific_wins"});
        assert_eq!(parse_submit(&body).unwrap(), "js_123");
    }

    #[test]
    fn reads_a_nested_id() {
        let body = json!({"data": {"job_set": {"id": "js_nested"}}});
        assert_eq!(parse_submit(&body).unwrap(), "js_nested");
    }

    #[test]
    fn reports_a_missing_id_with_context() {
        let err = parse_submit(&json!({"detail": "nope"})).unwrap_err();
        assert!(matches!(err, HiggsfieldError::Malformed(_)));
        assert!(err.to_string().contains("detail"), "{err}");
    }

    #[test]
    fn queued_when_nothing_has_started() {
        let body = json!({"id": "x", "jobs": [{"status": "queued"}]});
        assert_eq!(parse_state(&body), JobState::Queued);
    }

    #[test]
    fn running_reports_fractional_progress() {
        let body = json!({"jobs": [{"status": "processing", "progress": 0.46}]});
        assert_eq!(parse_state(&body), JobState::Running { progress: 0.46 });
    }

    #[test]
    fn running_normalises_percentage_progress() {
        let body = json!({"jobs": [{"status": "in_progress", "progress": 46}]});
        assert_eq!(parse_state(&body), JobState::Running { progress: 0.46 });
    }

    #[test]
    fn running_averages_across_jobs() {
        let body = json!({"jobs": [
            {"status": "processing", "progress": 0.2},
            {"status": "processing", "progress": 0.8}
        ]});
        assert_eq!(parse_state(&body), JobState::Running { progress: 0.5 });
    }

    #[test]
    fn succeeded_prefers_the_raw_result() {
        let body = json!({"jobs": [{
            "status": "completed",
            "results": {
                "min": {"url": "https://cdn.example.com/small.mp4"},
                "raw": {"url": "https://cdn.example.com/full.mp4"}
            }
        }]});
        assert_eq!(
            parse_state(&body),
            JobState::Succeeded {
                video_url: "https://cdn.example.com/full.mp4".into()
            }
        );
    }

    #[test]
    fn succeeded_falls_back_to_any_video_url() {
        let body = json!({"status": "done", "output": ["https://cdn.example.com/out.mov?sig=abc"]});
        assert_eq!(
            parse_state(&body),
            JobState::Succeeded {
                video_url: "https://cdn.example.com/out.mov?sig=abc".into()
            }
        );
    }

    #[test]
    fn completed_without_a_url_is_not_success() {
        // Results sometimes land a poll after the status flips; keep polling instead of
        // reporting a success with no file to download.
        let body = json!({"jobs": [{"status": "completed"}]});
        assert!(matches!(
            parse_state(&body),
            JobState::Running { .. } | JobState::Queued
        ));
    }

    #[test]
    fn a_partially_finished_set_is_still_running() {
        let body = json!({"jobs": [
            {"status": "completed", "results": {"raw": {"url": "https://x.test/a.mp4"}}},
            {"status": "processing", "progress": 0.1}
        ]});
        assert!(matches!(parse_state(&body), JobState::Running { .. }));
    }

    #[test]
    fn failure_wins_over_progress() {
        let body = json!({"jobs": [
            {"status": "processing", "progress": 0.9},
            {"status": "failed", "error": "content policy"}
        ]});
        assert_eq!(
            parse_state(&body),
            JobState::Failed {
                message: "content policy".into()
            }
        );
    }

    #[test]
    fn failure_without_a_message_still_explains_itself() {
        let body = json!({"status": "failed"});
        let JobState::Failed { message } = parse_state(&body) else {
            panic!("expected failure")
        };
        assert!(!message.is_empty());
    }

    #[test]
    fn ignores_non_video_urls() {
        let body = json!({"status": "completed", "thumbnail": "https://x.test/a.jpg"});
        assert!(!matches!(parse_state(&body), JobState::Succeeded { .. }));
    }

    #[test]
    fn ignores_relative_paths_that_end_in_mp4() {
        assert!(!looks_like_video("/tmp/local.mp4"));
        assert!(looks_like_video("https://x.test/a.mp4"));
    }
}
