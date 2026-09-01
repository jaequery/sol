//! Turning what an agent CLI printed into a motion, or saying why it is not one.
//!
//! Kept apart from the spawning so every shape a CLI has ever answered with can be pinned
//! by a unit test without a process, a login, or the network.

use crate::{Agent, AgentError, Recipe, Result};
use serde_json::Value;

/// The two-field object a run asks for. Claude is handed it as `--json-schema`, which makes
/// the answer structurally guaranteed; Codex has no equivalent, so for that CLI the same
/// shape is described in the prompt and enforced here instead.
pub fn recipe_schema() -> String {
    let transitions: Vec<Value> = solcut_render::TRANSITIONS
        .iter()
        .map(|t| Value::String((*t).to_string()))
        .collect();
    serde_json::json!({
        "type": "object",
        "properties": {
            "transition": { "type": "string", "enum": transitions },
            "duration_secs": {
                "type": "number",
                "minimum": solcut_render::MIN_TRANSITION_SECS,
                "maximum": solcut_render::MAX_TRANSITION_SECS,
            },
        },
        "required": ["transition", "duration_secs"],
        "additionalProperties": false,
    })
    .to_string()
}

/// The motion in what the CLI printed.
///
/// The two CLIs answer in genuinely different shapes, so this is the one place that knows
/// the difference; everything downstream just has a [`Recipe`].
pub fn parse_recipe(agent: Agent, stdout: &str) -> Result<Recipe> {
    let value = match agent {
        Agent::ClaudeCode => claude_answer(stdout)?,
        // Codex prints only the final assistant message on stdout in its default mode, but
        // there is no schema behind it, so it may arrive fenced or wrapped in a sentence.
        Agent::Codex => extract_json_object(stdout)
            .ok_or_else(|| AgentError::Malformed(unusable(agent, stdout)))?,
    };
    recipe_from(agent, &value)
}

/// Claude's `--output-format json` envelope.
///
/// `subtype` says how the agent loop ended and `is_error` says whether the last API call
/// failed — and they disagree: a loop that completed around a failed final request reports
/// `subtype: "success"` with `is_error: true`. Both have to be checked, or a 404 on the
/// model is read as an answer.
fn claude_answer(stdout: &str) -> Result<Value> {
    let envelope: Value = serde_json::from_str(stdout.trim())
        .map_err(|e| AgentError::Malformed(format!("Claude Code's answer was not JSON: {e}")))?;

    let subtype = envelope.get("subtype").and_then(Value::as_str);
    let is_error = envelope
        .get("is_error")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if subtype != Some("success") || is_error {
        let why = envelope
            .get("errors")
            .and_then(|e| e.as_array())
            .and_then(|e| e.first())
            .and_then(Value::as_str)
            .or_else(|| envelope.get("api_error_status").and_then(Value::as_str))
            .or_else(|| envelope.get("terminal_reason").and_then(Value::as_str))
            .or(subtype)
            .unwrap_or("it did not say why");
        return Err(AgentError::Cli {
            agent: Agent::ClaudeCode,
            message: format!("Claude Code could not answer: {why}"),
        });
    }

    // `--json-schema` hands the object back already parsed. `result` is the same thing as a
    // string, and is what an older CLI — or one that ignored the schema — leaves behind.
    if let Some(structured) = envelope.get("structured_output").filter(|v| v.is_object()) {
        return Ok(structured.clone());
    }
    envelope
        .get("result")
        .and_then(Value::as_str)
        .and_then(extract_json_object)
        .ok_or_else(|| AgentError::Malformed(unusable(Agent::ClaudeCode, stdout)))
}

/// A validated motion out of a parsed object.
///
/// The transition is checked against the vocabulary rather than trusted: a model may name a
/// real ffmpeg filter that this build has pinned itself out of, and the difference between
/// "we do not offer that" and an ffmpeg parse failure is the difference between an error a
/// user can act on and one they cannot.
fn recipe_from(agent: Agent, value: &Value) -> Result<Recipe> {
    let transition = value
        .get("transition")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .ok_or_else(|| {
            AgentError::Malformed(format!("{} did not name a transition", agent.label()))
        })?;

    if !solcut_render::is_transition(transition) {
        return Err(AgentError::Malformed(format!(
            "{} chose {transition:?}, which is not a motion SolCut renders",
            agent.label()
        )));
    }

    // A duration is clamped rather than refused: an out-of-range number is the model
    // misjudging a length, not misunderstanding the task, and the bounds exist precisely so
    // there is a sane answer to fall back to.
    let duration_secs = value
        .get("duration_secs")
        .and_then(Value::as_f64)
        .map(|d| d as f32)
        .unwrap_or(solcut_render::MIN_TRANSITION_SECS);

    Ok(Recipe {
        transition: transition.to_string(),
        duration_secs: solcut_render::clamp_transition_secs(duration_secs),
    })
}

/// The first balanced `{…}` in a blob of text, parsed.
///
/// Models fence their JSON, apologise before it, and add a sentence after it. Scanning for
/// a balanced object handles all three without a schema, and quoting is tracked so a brace
/// inside a string cannot end the object early.
pub fn extract_json_object(text: &str) -> Option<Value> {
    let bytes = text.as_bytes();
    let start = text.find('{')?;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;

    for (offset, &byte) in bytes.iter().enumerate().skip(start) {
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return serde_json::from_str(&text[start..=offset]).ok();
                }
            }
            _ => {}
        }
    }
    None
}

fn unusable(agent: Agent, stdout: &str) -> String {
    let seen = stdout.trim();
    if seen.is_empty() {
        return format!("{} answered with nothing at all", agent.label());
    }
    format!(
        "{} did not answer with a motion — it said: {}",
        agent.label(),
        crate::preview(seen)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn envelope(body: &str) -> String {
        format!(r#"{{"type":"result","subtype":"success","is_error":false,{body}}}"#)
    }

    #[test]
    fn claude_answers_through_the_schema_and_through_the_text_it_fell_back_to() {
        // `--json-schema` hands the object back parsed, which is the path a current CLI
        // takes. The string in `result` is the same answer, and is all there is if the flag
        // was ignored — reading both is what stops a CLI update from breaking every render.
        let structured = envelope(
            r#""result":"{}","structured_output":{"transition":"dissolve","duration_secs":4}"#,
        );
        let recipe = parse_recipe(Agent::ClaudeCode, &structured).expect("structured");
        assert_eq!(recipe.transition, "dissolve");
        assert_eq!(recipe.duration_secs, 4.0);

        let text = envelope(r#""result":"{\"transition\":\"radial\",\"duration_secs\":2.5}""#);
        let recipe = parse_recipe(Agent::ClaudeCode, &text).expect("result string");
        assert_eq!(recipe.transition, "radial");
        assert_eq!(recipe.duration_secs, 2.5);
    }

    #[test]
    fn a_loop_that_ended_around_a_failed_request_is_not_read_as_an_answer() {
        // The trap `subtype` alone walks into: Claude reports `subtype: "success"` with
        // `is_error: true` when the agent loop completed but the final API call failed. Read
        // one field and a 404 on the model looks like a motion.
        let failed = r#"{"type":"result","subtype":"success","is_error":true,
            "api_error_status":"404","terminal_reason":"api_error","result":null}"#;
        let error = parse_recipe(Agent::ClaudeCode, failed).expect_err("a failed request");
        assert!(matches!(error, AgentError::Cli { .. }), "got {error}");
        assert!(error.to_string().contains("404"), "{error}");

        let cut_short = r#"{"type":"result","subtype":"error_max_turns","is_error":true,
            "errors":["ran out of turns"],"result":null}"#;
        let error = parse_recipe(Agent::ClaudeCode, cut_short).expect_err("a truncated run");
        assert!(error.to_string().contains("ran out of turns"), "{error}");
    }

    #[test]
    fn codex_is_read_out_of_whatever_it_wrapped_the_json_in() {
        // Codex has no structured-output mode, so this is the entire contract: prose before
        // it, a fence around it, a sentence after it. All three are what models actually do.
        for stdout in [
            r#"{"transition":"wipeleft","duration_secs":2}"#,
            "```json\n{\"transition\":\"wipeleft\",\"duration_secs\":2}\n```",
            "Sure! Here's the transition:\n{\"transition\": \"wipeleft\", \"duration_secs\": 2}\nHope that helps.",
        ] {
            let recipe = parse_recipe(Agent::Codex, stdout).unwrap_or_else(|e| panic!("{stdout:?}: {e}"));
            assert_eq!(recipe.transition, "wipeleft");
        }
    }

    #[test]
    fn a_brace_inside_a_string_does_not_end_the_object_early() {
        let value = extract_json_object(r#"{"note":"a } inside","transition":"fade"}"#)
            .expect("a balanced object");
        assert_eq!(value["transition"], "fade");
        let escaped = extract_json_object(r#"{"note":"a \" and a }","transition":"fade"}"#)
            .expect("escapes are tracked too");
        assert_eq!(escaped["transition"], "fade");
        assert!(extract_json_object("no object here").is_none());
        assert!(extract_json_object("{unterminated").is_none());
    }

    #[test]
    fn a_length_outside_the_bounds_is_clamped_rather_than_refused() {
        // Misjudging a length is not misunderstanding the task, and the bounds exist so
        // there is always a sane answer — refusing here would throw away a good motion.
        let long =
            parse_recipe(Agent::Codex, r#"{"transition":"fade","duration_secs":30}"#).unwrap();
        assert_eq!(long.duration_secs, solcut_render::MAX_TRANSITION_SECS);
        let blink =
            parse_recipe(Agent::Codex, r#"{"transition":"fade","duration_secs":0.2}"#).unwrap();
        assert_eq!(blink.duration_secs, solcut_render::MIN_TRANSITION_SECS);
        // A missing length is the floor rather than a failure: the motion was the ask.
        let none = parse_recipe(Agent::Codex, r#"{"transition":"fade"}"#).unwrap();
        assert_eq!(none.duration_secs, solcut_render::MIN_TRANSITION_SECS);
    }

    #[test]
    fn the_schema_offers_exactly_the_motions_this_build_renders() {
        // The enum is what makes Claude's answer structurally valid. If it and the renderer
        // ever disagree, one of them is choosing motions the other refuses.
        let schema: Value = serde_json::from_str(&recipe_schema()).expect("valid JSON");
        let offered: Vec<&str> = schema["properties"]["transition"]["enum"]
            .as_array()
            .expect("an enum")
            .iter()
            .map(|v| v.as_str().expect("a name"))
            .collect();
        assert_eq!(offered, solcut_render::TRANSITIONS.to_vec());
        assert_eq!(schema["additionalProperties"], false);
    }
}
