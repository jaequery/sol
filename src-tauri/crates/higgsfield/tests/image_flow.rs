//! End-to-end exercise of an **image** generation against the stub `higgsfield`
//! executable: submit a prompt (with and without the user's own photos as references),
//! poll it to completion, and download the finished photo.
//!
//! The stub records every argv, so this file doubles as the record of what SolCut runs
//! for a photo: `generate create <image model> --prompt … [--image <path>]…
//! --aspect_ratio … --json --no-color`, then `generate get <job_id> --json --no-color`.
#![cfg(unix)]

mod mock_server;
mod stub_cli;

use mock_server::{MockServer, Response};
use solcut_higgsfield::{HiggsfieldError, ImageRequest, JobState, DEFAULT_IMAGE_MODEL};
use std::path::{Path, PathBuf};
use stub_cli::StubCli;

/// A real file on disk, so the reference is one the request could actually send.
fn reference(dir: &Path, name: &str) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, [0x89, b'P', b'N', b'G']).expect("a reference photo");
    path
}

fn request(model: &str) -> ImageRequest {
    ImageRequest {
        model: model.into(),
        prompt: "a quiet beach at sunrise".into(),
        references: vec![],
        aspect_ratio: Some("16:9".into()),
    }
}

/// A photo body, served under an image content type — which is what names the file the
/// download lands in.
fn png(bytes: Vec<u8>) -> Response {
    Response {
        status: 200,
        headers: vec![("content-type".into(), "image/png".into())],
        body: bytes,
    }
}

#[tokio::test]
async fn a_photo_is_created_from_a_prompt_alone_polled_and_downloaded() {
    let image = b"not really a png, but the bytes that came back".to_vec();
    let served = image.clone();
    let server = MockServer::start(move |_req, _n| png(served.clone()));
    let result_url = format!("{}/out/generated.png", server.base_url());

    let stub = StubCli::new("image-happy");
    stub.put("create.out", "[\n  \"img-7\"\n]\n");
    stub.put("get.1", r#"{"id":"img-7","status":"queued"}"#);
    stub.put(
        "get.last",
        &format!(r#"{{"id":"img-7","status":"completed","result_url":"{result_url}"}}"#),
    );

    let cli = stub.cli();
    let job_id = cli
        .create_image(&request(DEFAULT_IMAGE_MODEL))
        .await
        .expect("create");
    assert_eq!(job_id, "img-7");

    assert_eq!(cli.job_state(&job_id).await.unwrap(), JobState::Queued);
    let JobState::Succeeded { result_url: url } = cli.job_state(&job_id).await.unwrap() else {
        panic!("expected completion");
    };

    let landed = cli
        .download_image(&url, &stub.dir, "gen_9")
        .await
        .expect("download");
    // The extension is load-bearing: the media bin classifies by it and nothing else.
    assert_eq!(landed, stub.dir.join("gen_9.png"));
    assert_eq!(std::fs::read(&landed).unwrap(), image);

    let log = stub.argv_log();
    let lines: Vec<&str> = log.lines().collect();
    assert_eq!(
        lines[0],
        "generate create nano_banana_2 --prompt a quiet beach at sunrise \
         --aspect_ratio 16:9 --json --no-color"
    );
    assert_eq!(lines[1], "generate get img-7 --json --no-color");
}

#[tokio::test]
async fn the_users_own_photos_ride_along_as_repeated_image_flags() {
    let stub = StubCli::new("image-refs");
    stub.put("create.out", r#"["img-8"]"#);

    let mut req = request(DEFAULT_IMAGE_MODEL);
    req.references = vec![
        reference(&stub.dir, "one.png"),
        reference(&stub.dir, "two.jpg"),
    ];

    let job_id = stub.cli().create_image(&req).await.expect("create");
    assert_eq!(job_id, "img-8");

    let log = stub.argv_log();
    assert_eq!(
        log.lines().next().unwrap(),
        format!(
            "generate create nano_banana_2 --prompt a quiet beach at sunrise \
             --image {}/one.png --image {}/two.jpg --aspect_ratio 16:9 --json --no-color",
            stub.dir.display(),
            stub.dir.display()
        )
    );
}

/// The mode flag exists only because Seedance 2.5 gates *video* frame inputs behind it.
/// Sending it on an image job would be refused by a model that has no such mode.
#[tokio::test]
async fn an_image_job_carries_no_video_only_flags() {
    let stub = StubCli::new("image-flags");
    stub.put("create.out", r#"["img-9"]"#);

    let mut req = request(DEFAULT_IMAGE_MODEL);
    req.references = vec![reference(&stub.dir, "one.png")];
    stub.cli().create_image(&req).await.expect("create");

    let log = stub.argv_log();
    assert!(!log.contains("--mode"), "{log}");
    assert!(!log.contains("--start-image"), "{log}");
    assert!(!log.contains("--end-image"), "{log}");
}

/// An unknown model id is refused by the live catalog, so the card quotes the CLI's own
/// words rather than SolCut guessing at what went wrong.
#[tokio::test]
async fn an_unknown_image_model_surfaces_the_clis_own_words() {
    let stub = StubCli::new("image-refusal");
    stub.put(
        "create.err",
        "Error: Unknown model \"nano_banana_99\". Run `higgsfield model list`.",
    );

    let err = stub
        .cli()
        .create_image(&request("nano_banana_99"))
        .await
        .unwrap_err();
    let HiggsfieldError::Cli { message } = &err else {
        panic!("expected a CLI refusal, got {err:?}");
    };
    assert!(message.contains("model list"), "{message}");
    assert!(!err.is_retryable(), "the same model id fails again");
}

/// A completed job whose result URL cannot be found is a failure, not an endless poll —
/// and it says so, rather than reporting success with nothing to show.
#[tokio::test]
async fn a_completed_photo_with_no_url_fails_loudly() {
    let stub = StubCli::new("image-nourl");
    stub.put("create.out", r#"["img-10"]"#);
    stub.put("get.last", r#"{"id":"img-10","status":"completed"}"#);

    let cli = stub.cli();
    let job_id = cli
        .create_image(&request(DEFAULT_IMAGE_MODEL))
        .await
        .expect("create");
    let err = cli.job_state(&job_id).await.unwrap_err();
    assert!(err.to_string().contains("without a result URL"), "{err}");
}
