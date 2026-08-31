//! Readers for the Higgsfield CLI's `--json` output.
//!
//! The CLI's documented contract (its README and `--help`) promises jobs with a `status`
//! and, on completion, a `result_url`. The exact packaging of a job object is not pinned
//! by the docs — a create can answer with the job, with a job set listing it, or with
//! nothing but the ids it queued — so the readers here accept the documented object
//! through those harmless layers: a one-job array, a `jobs` list holding it, or a bare
//! list of id strings. Anything without an unambiguous reading is refused
//! with the evidence attached — the keys present, or the JSON type and a truncated echo —
//! so the error card carries its own diagnosis.
//!
//! Every function here is pure, so the behaviour is pinned by unit tests instead of by a
//! live CLI.

use crate::error::{HiggsfieldError, JobState, Result};
use crate::preview;
use serde_json::Value;

/// The keys under which the CLI names a job's id, in the order they are trusted.
const ID_KEYS: &[&str] = &["id", "job_id", "job_set_id", "request_id"];

/// The id of the created job, from `generate create … --json`.
pub fn parse_create(stdout: &str) -> Result<String> {
    let body = parse_stdout(stdout, "generate create")?;
    // The shipped CLI acks a create with the bare list of ids it queued —
    // `["d2f79a31-3b30-4e1f-960f-52e9fb1de639"]` — as readily as with the job object.
    if let Some(id) = listed_job_id(&body) {
        return Ok(id.to_string());
    }
    let body = unwrapped(&body);
    job_id_of(body)
        .ok_or_else(|| unreadable("job id", "generate create", body))
        .map(str::to_string)
}

/// A create ack that is simply the ids it queued. SolCut submits exactly one generation,
/// so the first id in the list is that generation's job.
fn listed_job_id(body: &Value) -> Option<&str> {
    body.as_array()?
        .iter()
        .find_map(|item| item.as_str().filter(|s| !s.is_empty()))
}

/// Reduce a `generate get <job_id> --json` body to a single [`JobState`].
pub fn parse_job(stdout: &str) -> Result<JobState> {
    let body = parse_stdout(stdout, "generate get")?;
    let body = unwrapped(&body);
    let status = status_of(body)
        .ok_or_else(|| unreadable("status", "generate get", body))?
        .to_ascii_lowercase();

    match status.as_str() {
        "queued" | "pending" => Ok(JobState::Queued),
        "in_progress" | "running" | "processing" => Ok(JobState::Running {
            progress: progress_of(body),
        }),
        "completed" => match find_result_url(body) {
            Some(result_url) => Ok(JobState::Succeeded { result_url }),
            // A completed job is documented to carry its result URL, so an empty one is
            // a real failure rather than something another poll would fix.
            None => Err(HiggsfieldError::JobFailed(
                "the job completed without a result URL".into(),
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
            "unrecognised job status {other:?}"
        ))),
    }
}

/// How many models `model list --video --json` reports, when the shape is countable.
/// Used only to phrase the connection-check message, so an unexpected shape is `None`,
/// never an error — the successful exit already proved what the probe asks.
pub fn parse_model_count(stdout: &str) -> Option<usize> {
    let body = parse_stdout(stdout, "model list").ok()?;
    if let Some(items) = body.as_array() {
        return Some(items.len());
    }
    for key in ["models", "job_types", "data", "items"] {
        if let Some(items) = body.get(key).and_then(Value::as_array) {
            return Some(items.len());
        }
    }
    None
}

/// The CLI's stdout as one JSON value.
///
/// `--json` output is a single value, but a stray notice line above it must not turn a
/// finished job into a dead one — so when the whole of stdout does not parse, the value
/// is looked for from the first bracket onwards (the CLI pretty-prints, so the JSON
/// spans lines), and failing that in the last line that parses on its own.
fn parse_stdout(stdout: &str, place: &str) -> Result<Value> {
    let trimmed = stdout.trim();
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        return Ok(value);
    }
    if let Some(from_bracket) = trimmed
        .find(['{', '['])
        .map(|at| trimmed[at..].trim())
        .and_then(|rest| serde_json::from_str::<Value>(rest).ok())
    {
        return Ok(from_bracket);
    }
    trimmed
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
        .ok_or_else(|| {
            HiggsfieldError::Malformed(format!(
                "the {place} output is not JSON (started with: {})",
                preview(trimmed)
            ))
        })
}

/// The job's id, wherever the CLI put it.
fn job_id_of(body: &Value) -> Option<&str> {
    for key in ID_KEYS {
        if let Some(id) = body
            .get(*key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            return Some(id);
        }
    }
    // A create that answers with the job set carrying its jobs.
    body.get("jobs")
        .and_then(Value::as_array)
        .and_then(|jobs| jobs.first())
        .and_then(job_id_of)
}

fn status_of(body: &Value) -> Option<&str> {
    for key in ["status", "job_status"] {
        if let Some(status) = body
            .get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            return Some(status);
        }
    }
    None
}

/// The result URL of a completed job, under the names the CLI uses.
///
/// `result_url` is the documented key; `min_result_url` is its lower-resolution sibling
/// and only trusted when the full one is absent. `results` and the typed `video_url` /
/// `image_url` cover jobs that report a list or a medium-specific field instead — image
/// jobs go through this same reader, and a completed job whose URL cannot be found is
/// reported as a failure, so a missing name here would turn a *successful* generation
/// into "the job completed without a result URL".
///
/// A job that lists several outputs answers with the first: SolCut submits one generation
/// and shows one result.
pub fn find_result_url(body: &Value) -> Option<String> {
    for key in [
        "result_url",
        "video_url",
        "image_url",
        "min_result_url",
        "url",
    ] {
        if let Some(url) = http_url(body.get(key)) {
            return Some(url);
        }
    }
    for list in ["results", "images"] {
        let Some(items) = body.get(list).and_then(Value::as_array) else {
            continue;
        };
        for item in items {
            if let Some(url) = http_url(Some(item)) {
                return Some(url);
            }
            for key in ["result_url", "video_url", "image_url", "url"] {
                if let Some(url) = http_url(item.get(key)) {
                    return Some(url);
                }
            }
        }
    }
    // A job set that lists its jobs: the first job holding a result answers.
    body.get("jobs")
        .and_then(Value::as_array)
        .and_then(|jobs| jobs.iter().find_map(find_result_url))
}

fn http_url(node: Option<&Value>) -> Option<String> {
    let url = node?.as_str()?;
    (url.starts_with("http://") || url.starts_with("https://")).then(|| url.to_string())
}

/// The job's own words for why it failed, wherever the CLI put them.
fn error_of(body: &Value) -> Option<String> {
    ["error", "detail", "message", "failure_reason"]
        .iter()
        .find_map(|k| body.get(k).and_then(Value::as_str))
        .map(str::to_owned)
        .filter(|s| !s.is_empty())
}

/// The job schema has no promised progress field, so a running job reports 0 unless the
/// CLI volunteers one — better an honest 0 than an invented estimate.
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

/// The documented object through one harmless layer of packaging: SolCut creates exactly
/// one job, so an answer that *lists* that one job reads unambiguously as the job itself.
fn unwrapped(body: &Value) -> &Value {
    match body.as_array() {
        Some(items) if items.len() == 1 && items[0].is_object() => &items[0],
        _ => body,
    }
}

/// Why a body could not be read, with the evidence attached: the missing field and the
/// keys present for an object, the JSON type and a truncated echo of the body for
/// anything else — so a failure report says what the CLI printed, not only what it didn't.
fn unreadable(field: &str, place: &str, body: &Value) -> HiggsfieldError {
    HiggsfieldError::Malformed(match body.as_object() {
        Some(map) => format!(
            "no {field} in the {place} output (keys: {})",
            map.keys().cloned().collect::<Vec<_>>().join(", ")
        ),
        None => format!(
            "the {place} output is {} rather than a job object: {}",
            json_kind(body),
            preview(&body.to_string())
        ),
    })
}

fn json_kind(v: &Value) -> &'static str {
    match v {
        Value::Null => "JSON null",
        Value::Bool(_) => "a JSON boolean",
        Value::Number(_) => "a JSON number",
        Value::String(_) => "a JSON string",
        Value::Array(_) => "a JSON array",
        Value::Object(_) => "a JSON object",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_the_job_id_from_a_create_ack() {
        let id = parse_create(r#"{"id":"job-1","status":"queued"}"#).unwrap();
        assert_eq!(id, "job-1");

        let id = parse_create(r#"{"job_id":"job-2"}"#).unwrap();
        assert_eq!(id, "job-2");

        let id = parse_create(r#"{"job_set_id":"set-3","status":"queued"}"#).unwrap();
        assert_eq!(id, "set-3");
    }

    #[test]
    fn a_create_answering_with_a_job_set_still_names_its_job() {
        let id = parse_create(
            r#"{"jobs":[{"id":"job-9","status":"queued"}],"job_set_type":"seedance_2_5"}"#,
        )
        .unwrap();
        assert_eq!(id, "job-9");
    }

    #[test]
    fn a_create_answering_with_the_ids_it_queued_is_read() {
        let id = parse_create(r#"["d2f79a31-3b30-4e1f-960f-52e9fb1de639"]"#).unwrap();
        assert_eq!(id, "d2f79a31-3b30-4e1f-960f-52e9fb1de639");

        // A notice above it, and more than one id: the first names SolCut's one job.
        let id = parse_create("Update available\n[\"job-a\",\"job-b\"]").unwrap();
        assert_eq!(id, "job-a");
    }

    #[test]
    fn an_empty_id_list_is_refused_rather_than_polled_as_an_empty_id() {
        let err = parse_create("[]").unwrap_err();
        assert!(matches!(err, HiggsfieldError::Malformed(_)), "{err:?}");
        assert!(err.to_string().contains("a JSON array"), "{err}");

        assert!(parse_create(r#"[""]"#).is_err());
    }

    #[test]
    fn the_one_job_wrapped_in_a_list_is_read() {
        let id = parse_create(r#"[{"id":"job-4","status":"queued"}]"#).unwrap();
        assert_eq!(id, "job-4");

        assert_eq!(
            parse_job(r#"[{"id":"job-4","status":"queued"}]"#).unwrap(),
            JobState::Queued
        );
    }

    #[test]
    fn a_notice_line_above_the_json_does_not_kill_the_job() {
        let id =
            parse_create("A new version of the CLI is available.\n{\"id\":\"job-5\"}").unwrap();
        assert_eq!(id, "job-5");

        // The CLI pretty-prints, so the JSON under a notice spans lines.
        let id =
            parse_create("A new version of the CLI is available.\n[\n  \"job-6\"\n]\n").unwrap();
        assert_eq!(id, "job-6");
    }

    #[test]
    fn a_create_ack_without_an_id_reports_its_keys() {
        let err = parse_create(r#"{"detail":"nope"}"#).unwrap_err();
        assert!(matches!(err, HiggsfieldError::Malformed(_)), "{err:?}");
        assert!(err.to_string().contains("detail"), "{err}");
    }

    #[test]
    fn non_json_output_is_quoted_back() {
        let err = parse_create("spinner output, no json").unwrap_err();
        assert!(err.to_string().contains("spinner output"), "{err}");
    }

    #[test]
    fn a_non_object_ack_reports_its_type_and_body() {
        let err = parse_create(r#""job-1""#).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("a JSON string"), "{msg}");
        assert!(msg.contains("job-1"), "the body is quoted back: {msg}");
    }

    #[test]
    fn queued_pending_and_the_running_statuses_are_not_terminal() {
        for s in ["queued", "pending"] {
            assert_eq!(
                parse_job(&json!({"id": "x", "status": s}).to_string()).unwrap(),
                JobState::Queued,
                "{s}"
            );
        }
        for s in ["in_progress", "running", "processing"] {
            assert_eq!(
                parse_job(&json!({"id": "x", "status": s}).to_string()).unwrap(),
                JobState::Running { progress: 0.0 },
                "{s}"
            );
        }
    }

    #[test]
    fn a_volunteered_progress_is_used_and_normalised() {
        let body = json!({"id": "x", "status": "in_progress", "progress": 46});
        assert_eq!(
            parse_job(&body.to_string()).unwrap(),
            JobState::Running { progress: 0.46 }
        );
    }

    #[test]
    fn completed_reads_the_documented_result_url() {
        let body =
            json!({"id": "x", "status": "completed", "result_url": "https://cdn.test/v.mp4"});
        assert_eq!(
            parse_job(&body.to_string()).unwrap(),
            JobState::Succeeded {
                result_url: "https://cdn.test/v.mp4".into()
            }
        );
    }

    #[test]
    fn the_full_result_is_preferred_over_its_preview_sibling() {
        let body = json!({
            "id": "x",
            "status": "completed",
            "min_result_url": "https://cdn.test/small.mp4",
            "result_url": "https://cdn.test/full.mp4"
        });
        assert_eq!(
            parse_job(&body.to_string()).unwrap(),
            JobState::Succeeded {
                result_url: "https://cdn.test/full.mp4".into()
            }
        );
    }

    #[test]
    fn a_result_listed_under_results_is_found() {
        let body = json!({"id": "x", "status": "completed", "results": [{"url": "https://cdn.test/v.mp4"}]});
        assert_eq!(
            parse_job(&body.to_string()).unwrap(),
            JobState::Succeeded {
                result_url: "https://cdn.test/v.mp4".into()
            }
        );

        let body = json!({"id": "x", "status": "completed", "results": ["https://cdn.test/w.mp4"]});
        assert_eq!(
            parse_job(&body.to_string()).unwrap(),
            JobState::Succeeded {
                result_url: "https://cdn.test/w.mp4".into()
            }
        );
    }

    /// An image job that names its output anything but `result_url` would otherwise
    /// report a *successful* generation as "completed without a result URL" — the
    /// quietest way for this feature to look broken.
    #[test]
    fn a_finished_photo_is_found_under_the_image_shaped_names_too() {
        for body in [
            json!({"id": "x", "status": "completed", "image_url": "https://cdn.test/a.png"}),
            json!({"id": "x", "status": "completed", "images": ["https://cdn.test/a.png"]}),
            json!({"id": "x", "status": "completed", "images": [{"image_url": "https://cdn.test/a.png"}]}),
            json!({"id": "x", "status": "completed", "results": [{"image_url": "https://cdn.test/a.png"}]}),
        ] {
            assert_eq!(
                parse_job(&body.to_string()).unwrap(),
                JobState::Succeeded {
                    result_url: "https://cdn.test/a.png".into()
                },
                "{body}"
            );
        }
    }

    /// A job set carrying several outputs answers with the first: SolCut submits one
    /// generation and shows one photo.
    #[test]
    fn several_images_answer_with_the_first() {
        let body = json!({
            "id": "x",
            "status": "completed",
            "images": ["https://cdn.test/one.png", "https://cdn.test/two.png"]
        });
        assert_eq!(
            parse_job(&body.to_string()).unwrap(),
            JobState::Succeeded {
                result_url: "https://cdn.test/one.png".into()
            }
        );
    }

    /// The documented key still wins when a body carries both.
    #[test]
    fn the_documented_result_url_outranks_a_typed_sibling() {
        let body = json!({
            "id": "x",
            "status": "completed",
            "image_url": "https://cdn.test/typed.png",
            "result_url": "https://cdn.test/documented.png"
        });
        assert_eq!(
            parse_job(&body.to_string()).unwrap(),
            JobState::Succeeded {
                result_url: "https://cdn.test/documented.png".into()
            }
        );
    }

    #[test]
    fn a_job_status_key_is_as_good_as_status() {
        let body = json!({"job_id": "x", "job_status": "queued"});
        assert_eq!(parse_job(&body.to_string()).unwrap(), JobState::Queued);
    }

    #[test]
    fn completed_without_a_result_is_a_failure_not_an_endless_poll() {
        let err = parse_job(&json!({"id": "x", "status": "completed"}).to_string()).unwrap_err();
        assert!(matches!(err, HiggsfieldError::JobFailed(_)), "{err:?}");
    }

    #[test]
    fn failed_carries_the_jobs_own_words() {
        let body = json!({"id": "x", "status": "failed", "error": "model rejected the frames"});
        assert_eq!(
            parse_job(&body.to_string()).unwrap(),
            JobState::Failed {
                message: "model rejected the frames".into()
            }
        );
    }

    #[test]
    fn nsfw_explains_itself_even_with_no_error_field() {
        let JobState::Failed { message } =
            parse_job(&json!({"id": "x", "status": "nsfw"}).to_string()).unwrap()
        else {
            panic!("expected a failure");
        };
        assert!(message.contains("moderation"), "{message}");
    }

    #[test]
    fn canceled_is_its_own_state() {
        assert_eq!(
            parse_job(&json!({"id": "x", "status": "canceled"}).to_string()).unwrap(),
            JobState::Cancelled
        );
    }

    #[test]
    fn an_unknown_status_is_reported_rather_than_polled_forever() {
        let err = parse_job(&json!({"id": "x", "status": "wat"}).to_string()).unwrap_err();
        assert!(matches!(err, HiggsfieldError::Malformed(_)), "{err:?}");
        assert!(err.to_string().contains("wat"), "{err}");
    }

    #[test]
    fn relative_urls_are_never_a_result() {
        let body = json!({"id": "x", "status": "completed", "result_url": "/tmp/local.mp4"});
        assert!(parse_job(&body.to_string()).is_err());
    }

    #[test]
    fn the_model_count_reads_the_shapes_a_listing_can_take() {
        assert_eq!(parse_model_count(r#"[{"id":"a"},{"id":"b"}]"#), Some(2));
        assert_eq!(parse_model_count(r#"{"models":[{"id":"a"}]}"#), Some(1));
        assert_eq!(parse_model_count(r#"{"job_types":[1,2,3]}"#), Some(3));
        assert_eq!(parse_model_count(r#"{"something":"else"}"#), None);
        assert_eq!(parse_model_count("not json"), None);
    }
}
