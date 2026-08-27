//! End-to-end exercise of the client against a local stub of the Higgsfield API:
//! submit a prompt with two keyframes, poll until done, download the result.

mod mock_server;

use mock_server::{MockServer, Response};
use solcut_higgsfield::{Client, Config, Frame, GenerateRequest, HiggsfieldError, JobState};
use std::sync::{Arc, OnceLock};

fn request() -> GenerateRequest {
    GenerateRequest {
        prompt: "slow dolly-in over the water".into(),
        start_frame: Frame::from_jpeg_bytes(&[0xff, 0xd8, 0x01]),
        end_frame: Some(Frame::from_jpeg_bytes(&[0xff, 0xd8, 0x02])),
        duration_seconds: 3.2,
        seed: None,
    }
}

fn config(server: &MockServer) -> Config {
    Config {
        api_key: "test-key".into(),
        api_secret: "test-secret".into(),
        base_url: server.base_url(),
        ..Config::default()
    }
}

#[tokio::test]
async fn submits_polls_and_downloads_a_generated_clip() {
    let video = b"\x00\x00\x00\x18ftypmp42-pretend-this-is-an-mp4".to_vec();
    let payload = video.clone();

    // The success payload has to name the stub's own address, which is only known once it
    // is listening — so the handler reads it from a cell filled immediately after start.
    let base: Arc<OnceLock<String>> = Arc::new(OnceLock::new());
    let base_for_handler = Arc::clone(&base);

    let server = MockServer::start(move |req, index| match (req.method.as_str(), index) {
        ("POST", 0) => Response::json(200, r#"{"id":"js_test_1"}"#),
        ("GET", 1) => Response::json(200, r#"{"jobs":[{"status":"queued"}]}"#),
        ("GET", 2) => Response::json(200, r#"{"jobs":[{"status":"processing","progress":42}]}"#),
        ("GET", 3) => Response::json(
            200,
            &format!(
                r#"{{"jobs":[{{"status":"completed","results":{{"raw":{{"url":"{}/generated.mp4"}}}}}}]}}"#,
                base_for_handler
                    .get()
                    .expect("base url is set before any request")
            ),
        ),
        ("GET", _) => Response::bytes(200, payload.clone()),
        _ => Response::json(500, r#"{"error":"unexpected"}"#),
    });
    base.set(server.base_url()).expect("set once");

    let client = Client::new(config(&server)).expect("client");

    // 1. submit
    let handle = client.submit(&request()).await.expect("submit");
    assert_eq!(handle.job_set_id, "js_test_1");

    server.with_request(0, |req| {
        assert_eq!(req.path, "/v1/image2video");
        assert_eq!(req.header("hf-api-key"), Some("test-key"));
        assert_eq!(req.header("hf-secret"), Some("test-secret"));
        let body: serde_json::Value = serde_json::from_str(&req.body).expect("json body");
        assert_eq!(body["params"]["prompt"], "slow dolly-in over the water");
        let images = body["params"]["input_images"].as_array().unwrap();
        assert_eq!(images.len(), 2, "both keyframes are sent");
        assert!(images[0]["image_url"]
            .as_str()
            .unwrap()
            .starts_with("data:image/jpeg;base64,"));
    });

    // 2. poll through queued -> running -> succeeded
    assert_eq!(
        client.poll("js_test_1").await.expect("poll"),
        JobState::Queued
    );
    assert_eq!(
        client.poll("js_test_1").await.expect("poll"),
        JobState::Running { progress: 0.42 }
    );

    let done = client.poll("js_test_1").await.expect("poll");
    let JobState::Succeeded { video_url } = done else {
        panic!("expected success, got {done:?}");
    };
    assert!(video_url.ends_with("/generated.mp4"), "{video_url}");

    // 3. download
    let dir = std::env::temp_dir().join(format!("solcut-test-{}", std::process::id()));
    let dest = dir.join("generated.mp4");
    let written = client.download(&video_url, &dest).await.expect("download");

    assert_eq!(written, video.len() as u64);
    assert_eq!(std::fs::read(&dest).expect("read back"), video);
    assert!(
        !dest.with_extension("part").exists(),
        "the partial file is renamed away on success"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn surfaces_rate_limiting_with_its_retry_after() {
    let server = MockServer::start(|_, _| {
        Response::json(429, r#"{"detail":"too many requests"}"#).with_header("retry-after", "30")
    });
    let client = Client::new(config(&server)).expect("client");

    let err = client.submit(&request()).await.unwrap_err();
    match &err {
        HiggsfieldError::RateLimited { retry_after_secs } => {
            assert_eq!(*retry_after_secs, Some(30));
        }
        other => panic!("expected a rate limit, got {other:?}"),
    }
    assert!(err.is_retryable(), "a throttled request is worth retrying");
    assert_eq!(
        server.request_count(),
        1,
        "and it is not retried behind the caller's back"
    );
}

#[tokio::test]
async fn surfaces_a_bad_key_as_unauthorized() {
    let server = MockServer::start(|_, _| Response::json(401, r#"{"detail":"bad key"}"#));
    let client = Client::new(config(&server)).expect("client");

    let err = client.submit(&request()).await.unwrap_err();
    assert!(
        matches!(err, HiggsfieldError::Unauthorized { status: 401 }),
        "{err:?}"
    );
    assert!(!err.is_retryable(), "a bad key is not fixed by retrying");
}

#[tokio::test]
async fn reports_a_failed_job_with_its_reason() {
    let server = MockServer::start(|req, _| match req.method.as_str() {
        "POST" => Response::json(200, r#"{"job_set_id":"js_bad"}"#),
        _ => Response::json(
            200,
            r#"{"jobs":[{"status":"failed","error":"content policy"}]}"#,
        ),
    });
    let client = Client::new(config(&server)).expect("client");

    client.submit(&request()).await.expect("submit");
    assert_eq!(
        client.poll("js_bad").await.expect("poll"),
        JobState::Failed {
            message: "content policy".into()
        }
    );
}

#[tokio::test]
async fn rejects_html_error_pages_instead_of_pretending_they_parsed() {
    let server = MockServer::start(|_, _| Response::json(200, "<html>gateway timeout</html>"));
    let client = Client::new(config(&server)).expect("client");

    let err = client.submit(&request()).await.unwrap_err();
    assert!(matches!(err, HiggsfieldError::Malformed(_)), "{err:?}");
    assert!(
        err.to_string().contains("gateway timeout"),
        "the body is quoted back: {err}"
    );
}

#[tokio::test]
async fn a_failed_download_leaves_no_playable_file_behind() {
    let server = MockServer::start(|_, _| Response::json(404, r#"{"detail":"gone"}"#));
    let client = Client::new(config(&server)).expect("client");

    let dir = std::env::temp_dir().join(format!("solcut-test-404-{}", std::process::id()));
    let dest = dir.join("missing.mp4");
    let err = client
        .download(&format!("{}/missing.mp4", server.base_url()), &dest)
        .await
        .unwrap_err();

    assert!(
        matches!(err, HiggsfieldError::Http { status: 404, .. }),
        "{err:?}"
    );
    assert!(!dest.exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn credential_check_accepts_a_404_but_rejects_a_401() {
    let ok = MockServer::start(|_, _| Response::json(404, r#"{"detail":"no such job set"}"#));
    assert!(Client::new(config(&ok))
        .unwrap()
        .check_credentials()
        .await
        .is_ok());

    let bad = MockServer::start(|_, _| Response::json(403, r#"{"detail":"forbidden"}"#));
    let err = Client::new(config(&bad))
        .unwrap()
        .check_credentials()
        .await
        .unwrap_err();
    assert!(
        matches!(err, HiggsfieldError::Unauthorized { status: 403 }),
        "{err:?}"
    );
}
