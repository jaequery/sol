//! End-to-end exercise of the client against a local stub of the documented Higgsfield
//! API: upload both frames, submit the prompt, poll until done, download the result.
//!
//! Every URL, header and JSON key the stub asserts on comes from
//! <https://docs.higgsfield.ai> and its OpenAPI document, so this file doubles as the
//! record of what the integration is supposed to put on the wire.

mod mock_server;

use mock_server::{MockServer, Request, Response};
use solcut_higgsfield::{Client, Config, Frame, GenerateRequest, HiggsfieldError, JobState};
use std::sync::{Arc, OnceLock};

const START_JPEG: &[u8] = &[0xff, 0xd8, 0x01];
const END_JPEG: &[u8] = &[0xff, 0xd8, 0x02];

fn request() -> GenerateRequest {
    GenerateRequest {
        prompt: "slow dolly-in over the water".into(),
        start_frame: Frame::from_jpeg_bytes(START_JPEG),
        end_frame: Some(Frame::from_jpeg_bytes(END_JPEG)),
        seed: None,
    }
}

fn config(server: &MockServer) -> Config {
    Config {
        api_key_id: "test-id".into(),
        api_key_secret: "test-secret".into(),
        base_url: server.base_url(),
        ..Config::default()
    }
}

/// The stub's own address, which the payloads have to name but which is only known once
/// it is listening — so the handler reads it from a cell filled immediately after start.
fn shared_base() -> Arc<OnceLock<String>> {
    Arc::new(OnceLock::new())
}

#[tokio::test]
async fn uploads_submits_polls_and_downloads_a_generated_clip() {
    let video = b"\x00\x00\x00\x18ftypmp42-pretend-this-is-an-mp4".to_vec();
    let payload = video.clone();

    let base = shared_base();
    let handler_base = Arc::clone(&base);
    let polls = std::sync::atomic::AtomicUsize::new(0);

    let server = MockServer::start(move |req: &Request, _| {
        let base = handler_base
            .get()
            .expect("base url is set before any request");
        match (req.method.as_str(), req.path.as_str()) {
            // 1. a presigned upload, one per frame
            ("POST", "/files/generate-upload-url") => Response::json(
                200,
                &format!(
                    r#"{{"public_url":"{base}/cdn/frame.jpeg",
                         "upload_url":"{base}/storage/presigned",
                         "content_type":"image/jpeg",
                         "upload_headers":{{"Content-Type":"image/jpeg","x-amz-tagging":"retention=temporary"}}}}"#
                ),
            ),
            ("PUT", "/storage/presigned") => Response::json(200, "{}"),

            // 2. the submission
            ("POST", "/minimax/hailuo-02/standard/image-to-video") => Response::json(
                200,
                &format!(
                    r#"{{"status":"queued",
                         "request_id":"d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff",
                         "status_url":"{base}/requests/d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff/status",
                         "cancel_url":"{base}/requests/d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff/cancel"}}"#
                ),
            ),

            // 3. queued -> in_progress -> completed
            ("GET", "/requests/d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff/status") => {
                let n = polls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                match n {
                    0 => Response::json(200, r#"{"status":"queued","request_id":"d7e6c0f3"}"#),
                    1 => Response::json(
                        200,
                        r#"{"status":"in_progress","request_id":"d7e6c0f3","progress":42}"#,
                    ),
                    _ => Response::json(
                        200,
                        &format!(
                            r#"{{"status":"completed","request_id":"d7e6c0f3",
                                 "video":{{"url":"{base}/cdn/generated.mp4"}}}}"#
                        ),
                    ),
                }
            }

            // 4. the finished file
            ("GET", "/cdn/generated.mp4") => Response::bytes(200, payload.clone()),

            _ => Response::json(500, r#"{"detail":"unexpected request"}"#),
        }
    });
    base.set(server.base_url()).expect("set once");

    let client = Client::new(config(&server)).expect("client");

    // ---- submit (which uploads both stills first)
    let accepted = client.submit(&request()).await.expect("submit");
    assert_eq!(accepted.request_id, "d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff");
    assert!(
        accepted.status_url.ends_with("/status"),
        "the status_url the API returned is used verbatim: {}",
        accepted.status_url
    );

    server.with_first("/files/generate-upload-url", |req| {
        assert_eq!(
            req.header("authorization"),
            Some("Key test-id:test-secret"),
            "the documented `Key {{id}}:{{secret}}` header"
        );
        assert_eq!(req.json()["content_type"], "image/jpeg");
    });

    server.with_first("/storage/presigned", |req| {
        assert_eq!(req.body, START_JPEG, "the raw JPEG is PUT, not a data URL");
        assert_eq!(req.header("content-type"), Some("image/jpeg"));
        assert_eq!(
            req.header("x-amz-tagging"),
            Some("retention=temporary"),
            "every returned upload header is replayed"
        );
        assert_eq!(
            req.header("authorization"),
            None,
            "the API credential never reaches the storage host"
        );
    });

    server.with_first("/minimax/hailuo-02/standard/image-to-video", |req| {
        assert_eq!(req.header("authorization"), Some("Key test-id:test-secret"));
        let body = req.json();
        assert_eq!(body["prompt"], "slow dolly-in over the water");
        assert_eq!(
            body["image_url"],
            format!("{}/cdn/frame.jpeg", server.base_url())
        );
        assert_eq!(
            body["end_image_url"],
            format!("{}/cdn/frame.jpeg", server.base_url())
        );
        assert!(
            body.get("params").is_none(),
            "the body is flat, with no `params` envelope: {body}"
        );
    });

    assert_eq!(
        server.paths()[..2],
        [
            "POST /files/generate-upload-url".to_string(),
            "PUT /storage/presigned".to_string()
        ],
        "each still is uploaded before the submission that references it"
    );

    // ---- poll through queued -> running -> succeeded
    assert_eq!(
        client.poll(&accepted.status_url).await.expect("poll"),
        JobState::Queued
    );
    assert_eq!(
        client.poll(&accepted.status_url).await.expect("poll"),
        JobState::Running { progress: 0.42 }
    );

    let done = client.poll(&accepted.status_url).await.expect("poll");
    let JobState::Succeeded { video_url } = done else {
        panic!("expected success, got {done:?}");
    };
    assert!(video_url.ends_with("/cdn/generated.mp4"), "{video_url}");

    // ---- download
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
async fn a_queued_request_is_cancelled_through_the_api() {
    let base = shared_base();
    let handler_base = Arc::clone(&base);

    let server = MockServer::start(move |req: &Request, _| {
        let base = handler_base.get().expect("base url");
        match (req.method.as_str(), req.path.as_str()) {
            ("POST", "/minimax/hailuo-02/standard/image-to-video") => Response::json(
                200,
                &format!(
                    r#"{{"status":"queued","request_id":"r1","cancel_url":"{base}/requests/r1/cancel"}}"#
                ),
            ),
            // 202 with an empty body is the documented success for a cancellation.
            ("POST", "/requests/r1/cancel") => Response::json(202, ""),
            ("POST", "/requests/started/cancel") => {
                Response::json(400, r#"{"detail":"request already processing"}"#)
            }
            _ => Response::json(200, r#"{"public_url":"u","upload_url":"u"}"#),
        }
    });
    base.set(server.base_url()).expect("set once");

    let client = Client::new(config(&server)).expect("client");
    let accepted = client
        .submit(&GenerateRequest {
            prompt: "drift".into(),
            start_frame: Frame::Url("https://cdn.test/a.jpg".into()),
            end_frame: None,
            seed: None,
        })
        .await
        .expect("submit");

    assert!(client.cancel(&accepted.cancel_url).await.expect("cancel"));
    assert!(
        !client
            .cancel(&format!("{}/requests/started/cancel", server.base_url()))
            .await
            .expect("a 400 is a lost race, not an error"),
        "a request that has already started reports itself as not cancelled"
    );
}

#[tokio::test]
async fn an_already_hosted_frame_is_passed_through_without_an_upload() {
    let server = MockServer::start(|req: &Request, _| match req.path.as_str() {
        "/minimax/hailuo-02/standard/image-to-video" => {
            Response::json(200, r#"{"request_id":"r1"}"#)
        }
        _ => Response::json(500, r#"{"detail":"nothing else should be called"}"#),
    });
    let client = Client::new(config(&server)).expect("client");

    client
        .submit(&GenerateRequest {
            prompt: "drift".into(),
            start_frame: Frame::Url("https://cdn.test/a.jpg".into()),
            end_frame: None,
            seed: None,
        })
        .await
        .expect("submit");

    assert_eq!(
        server.paths(),
        ["POST /minimax/hailuo-02/standard/image-to-video".to_string()],
        "no presigned upload is minted for an image that already has a URL"
    );
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
async fn surfaces_a_bad_credential_as_unauthorized() {
    let server =
        MockServer::start(|_, _| Response::json(401, r#"{"detail":"Invalid credentials"}"#));
    let client = Client::new(config(&server)).expect("client");

    let err = client.submit(&request()).await.unwrap_err();
    let HiggsfieldError::Unauthorized { status, detail } = &err else {
        panic!("expected an auth failure, got {err:?}");
    };
    assert_eq!(*status, 401);
    assert_eq!(
        detail, "Invalid credentials",
        "the FastAPI detail is quoted back"
    );
    assert!(
        !err.is_retryable(),
        "a bad credential is not fixed by retrying"
    );
}

#[tokio::test]
async fn a_403_is_reported_as_missing_credits_rather_than_a_bad_key() {
    let server =
        MockServer::start(|_, _| Response::json(403, r#"{"detail":"Insufficient credits"}"#));
    let err = Client::new(config(&server))
        .unwrap()
        .submit(&request())
        .await
        .unwrap_err();

    assert!(
        matches!(err, HiggsfieldError::InsufficientCredits { .. }),
        "{err:?}"
    );
    assert_eq!(err.title(), "Out of credits");
}

/// A pydantic 422 echoes the whole submitted body back under `input` — two long image
/// URLs here — and the card used to show that echo, truncated, instead of the message.
/// The message is what has to reach the user.
#[tokio::test]
async fn a_rejected_body_quotes_the_validation_message_not_the_echoed_urls() {
    let server = MockServer::start(|req: &Request, _| match req.path.as_str() {
        "/minimax/hailuo-02/standard/image-to-video" => Response::json(
            422,
            &format!(
                r#"{{"detail":[{{"type":"missing","loc":["body","image_url"],"msg":"Field required",
                     "input":{{"end_image_url":"https://cdn.test/{long}/echoed.jpeg","prompt":"drift"}}}}]}}"#,
                long = "e".repeat(120),
            ),
        ),
        _ => Response::json(
            200,
            r#"{"public_url":"https://cdn.test/a.jpg","upload_url":"https://cdn.test/put"}"#,
        ),
    });
    let client = Client::new(config(&server)).expect("client");

    let err = client
        .submit(&GenerateRequest {
            prompt: "drift".into(),
            start_frame: Frame::Url("https://cdn.test/a.jpg".into()),
            end_frame: None,
            seed: None,
        })
        .await
        .unwrap_err();

    let HiggsfieldError::Http { status, body } = &err else {
        panic!("expected an HTTP error, got {err:?}");
    };
    assert_eq!(*status, 422);
    assert_eq!(body, "image_url: Field required");
    assert!(
        !err.is_retryable(),
        "a rejected body is not fixed by retrying"
    );
}

#[tokio::test]
async fn reports_a_failed_generation_with_its_reason() {
    let server = MockServer::start(|req: &Request, _| match req.method.as_str() {
        "GET" => Response::json(
            200,
            r#"{"status":"failed","request_id":"r1","error":"content policy"}"#,
        ),
        _ => Response::json(200, r#"{"request_id":"r1"}"#),
    });
    let client = Client::new(config(&server)).expect("client");

    let accepted = client
        .submit(&GenerateRequest {
            prompt: "drift".into(),
            start_frame: Frame::Url("https://cdn.test/a.jpg".into()),
            end_frame: None,
            seed: None,
        })
        .await
        .expect("submit");
    assert_eq!(
        accepted.status_url,
        format!("{}/requests/r1/status", server.base_url()),
        "a response without a status_url still yields the documented path"
    );
    assert_eq!(
        client.poll(&accepted.status_url).await.expect("poll"),
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
async fn the_connection_check_proves_the_credential_without_generating_anything() {
    let ok = MockServer::start(|_, _| {
        Response::json(
            200,
            r#"{"public_url":"https://cdn.test/a.jpeg","upload_url":"https://storage.test/put"}"#,
        )
    });
    Client::new(config(&ok))
        .unwrap()
        .check_credentials()
        .await
        .expect("a 200 from the upload endpoint means the credential works");
    assert_eq!(
        ok.paths(),
        ["POST /files/generate-upload-url".to_string()],
        "nothing is submitted, so nothing is charged"
    );

    let bad = MockServer::start(|_, _| Response::json(401, r#"{"detail":"Invalid credentials"}"#));
    let err = Client::new(config(&bad))
        .unwrap()
        .check_credentials()
        .await
        .unwrap_err();
    assert!(
        matches!(err, HiggsfieldError::Unauthorized { status: 401, .. }),
        "{err:?}"
    );
}

/// A credential pasted whole — the single `key_id:key_secret` string Higgsfield's own
/// SDKs take — authenticates with exactly the header the docs specify.
///
/// <https://docs.higgsfield.ai/docs/authentication>
#[tokio::test]
async fn a_credential_pasted_whole_still_sends_the_documented_header() {
    let server = MockServer::start(|_, _| {
        Response::json(
            200,
            r#"{"public_url":"https://cdn.test/a.jpeg","upload_url":"https://storage.test/put"}"#,
        )
    });

    let pasted = Config {
        // Nothing in the secret box: the whole credential arrived in one paste.
        api_key_id: "  test-id:test-secret\n".into(),
        base_url: server.base_url(),
        ..Config::default()
    };
    Client::new(pasted)
        .expect("a whole credential, however it was pasted")
        .check_credentials()
        .await
        .expect("authenticated");

    server.with_first("/files/generate-upload-url", |req| {
        assert_eq!(
            req.header("authorization"),
            Some("Key test-id:test-secret"),
            "the scheme is `Key id:secret` — never a bearer token, and never a trailing colon"
        );
        assert!(
            req.header("hf-api-key").is_none() && req.header("hf-secret").is_none(),
            "the legacy header pair is not what a new integration sends"
        );
    });
}

/// The `Authorization` header is the only place the credential goes: no query string, no
/// second header, and nothing at all on the presigned storage host.
#[tokio::test]
async fn the_credential_travels_only_in_the_authorization_header() {
    let base = shared_base();
    let seen = Arc::clone(&base);
    let server = MockServer::start(move |req, _| match req.path.as_str() {
        "/files/generate-upload-url" => {
            let here = seen.get().cloned().unwrap_or_default();
            Response::json(
                200,
                &format!(
                    r#"{{"public_url":"https://cdn.test/a.jpeg","upload_url":"{here}/storage/put",
                        "upload_headers":{{"Content-Type":"image/jpeg"}}}}"#
                ),
            )
        }
        _ => Response::json(200, "{}"),
    });
    base.set(server.base_url()).unwrap();

    Client::new(config(&server))
        .unwrap()
        .upload_image(START_JPEG.to_vec(), "image/jpeg")
        .await
        .expect("uploaded");

    server.with_first("/files/generate-upload-url", |req| {
        assert!(
            !req.path.contains("key") && !req.path.contains('?'),
            "the credential is never put in a URL: {}",
            req.path
        );
    });
    server.with_first("/storage/put", |req| {
        assert!(
            req.header("authorization").is_none(),
            "the presigned storage host must never see the API credential"
        );
    });
}
