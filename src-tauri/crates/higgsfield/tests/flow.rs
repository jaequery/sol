//! End-to-end exercise of the CLI wrapper against a stub `higgsfield` executable: submit
//! the job, poll it to completion, download the result — without the real CLI, a login,
//! or the internet.
//!
//! The stub records every argv it is called with, so this file doubles as the record of
//! exactly what SolCut runs: `generate create <model> --prompt … --start-image …
//! --end-image … [--mode omni_reference] --json --no-color`, then
//! `generate get <job_id> --json --no-color`.
#![cfg(unix)]

mod mock_server;
mod stub_cli;

use mock_server::{MockServer, Response};
use solcut_higgsfield::{Cli, GenerateRequest, HiggsfieldError, JobState};
use std::path::{Path, PathBuf};
use stub_cli::StubCli;

fn request(dir: &Path) -> GenerateRequest {
    GenerateRequest {
        model: "seedance_2_5".into(),
        prompt: "slow dolly-in over the water".into(),
        start_image: dir.join("start.jpg"),
        end_image: Some(dir.join("end.jpg")),
    }
}

#[tokio::test]
async fn a_job_is_created_polled_and_its_result_downloaded() {
    let mp4 = b"not really an mp4, but the bytes that came back".to_vec();
    let served = mp4.clone();
    let server = MockServer::start(move |_req, _n| Response::bytes(200, served.clone()));
    let video_url = format!("{}/out/video.mp4", server.base_url());

    let stub = StubCli::new("happy");
    // The shipped CLI's own ack: pretty-printed, and nothing but the ids it queued.
    stub.put("create.out", "[\n  \"job-42\"\n]\n");
    stub.put("get.1", r#"{"id":"job-42","status":"queued"}"#);
    stub.put("get.2", r#"{"id":"job-42","status":"in_progress"}"#);
    stub.put(
        "get.last",
        &format!(r#"{{"id":"job-42","status":"completed","result_url":"{video_url}"}}"#),
    );

    let cli = stub.cli();
    let job_id = cli.create(&request(&stub.dir)).await.expect("create");
    assert_eq!(job_id, "job-42");

    assert_eq!(cli.job_state(&job_id).await.unwrap(), JobState::Queued);
    assert_eq!(
        cli.job_state(&job_id).await.unwrap(),
        JobState::Running { progress: 0.0 }
    );
    let JobState::Succeeded { result_url: url } = cli.job_state(&job_id).await.unwrap() else {
        panic!("expected completion");
    };
    assert_eq!(url, video_url);

    let dest = stub.dir.join("result.mp4");
    let written = cli.download(&url, &dest).await.expect("download");
    assert_eq!(written, mp4.len() as u64);
    assert_eq!(std::fs::read(&dest).unwrap(), mp4);

    // The record of what actually ran: the documented invocation, nothing else.
    let log = stub.argv_log();
    let lines: Vec<&str> = log.lines().collect();
    assert_eq!(lines.len(), 4, "{log}");
    assert_eq!(
        lines[0],
        format!(
            "generate create seedance_2_5 --prompt slow dolly-in over the water \
             --start-image {}/start.jpg --end-image {}/end.jpg \
             --mode omni_reference --json --no-color",
            stub.dir.display(),
            stub.dir.display()
        )
    );
    assert_eq!(lines[1], "generate get job-42 --json --no-color");
}

#[tokio::test]
async fn a_refusal_surfaces_the_clis_own_words() {
    let stub = StubCli::new("refusal");
    stub.put(
        "create.err",
        "Error: Session expired.\nHint: Re-run `higgsfield auth login`.\n",
    );

    let err = stub.cli().create(&request(&stub.dir)).await.unwrap_err();
    let HiggsfieldError::Cli { message } = &err else {
        panic!("expected a CLI refusal, got {err:?}");
    };
    assert!(message.contains("auth login"), "{message}");
    assert_eq!(err.title(), "Not signed in");
    assert!(!err.is_retryable(), "the same login will be expired again");
}

#[tokio::test]
async fn a_missing_binary_reports_not_installed_with_the_install_command() {
    let cli = Cli::new(PathBuf::from("/nonexistent/definitely/higgsfield"));
    let err = cli.create(&request(Path::new("/tmp"))).await.unwrap_err();
    assert!(matches!(err, HiggsfieldError::NotInstalled), "{err:?}");
    assert!(err.to_string().contains("npm i -g @higgsfield/cli"));
}

#[tokio::test]
async fn the_probe_counts_the_models_a_working_setup_lists() {
    let stub = StubCli::new("probe");
    stub.put(
        "models.out",
        r#"[{"job_set_type":"seedance_2_5"},{"job_set_type":"kling3_0"}]"#,
    );
    assert_eq!(stub.cli().probe().await.expect("probe"), Some(2));
    assert!(stub
        .argv_log()
        .contains("model list --video --json --no-color"));
}

#[tokio::test]
async fn the_probe_hands_back_the_clis_own_fix_when_no_workspace_is_selected() {
    let stub = StubCli::new("workspace");
    stub.put("models.out", "");
    stub.put(
        "models.err",
        "Error: No workspace selected.\nHint: Run: hf workspace set <workspace_id>\n",
    );

    let err = stub.cli().probe().await.unwrap_err();
    assert_eq!(err.title(), "No billing workspace");
    assert!(err.to_string().contains("workspace set"), "{err}");
}
