//! The Cloud API key check, over a real socket.
//!
//! [`solcut_higgsfield::classify`] is unit-tested against every status in the crate
//! itself; what this file proves is the part a unit test cannot see — that the request
//! actually sent is the documented one: `GET /requests/{request_id}/status` carrying
//! `Authorization: Key {id}:{secret}` and nothing else, with the credential never in a
//! URL and nothing generated.

mod mock_server;

use mock_server::{MockServer, Response};
use solcut_higgsfield::{check_credential, Credential, KeyVerdict};

/// The all-zero request id the probe asks after — one that belongs to nobody, so an
/// authenticated caller is answered 404.
const NIL_REQUEST: &str = "/requests/00000000-0000-0000-0000-000000000000/status";

fn credential() -> Credential {
    Credential::parse("test-id", "test-secret").expect("a whole credential")
}

/// A 404 for a request that belongs to nobody is the documented answer to an
/// *authenticated* caller — so it is the proof the key works. Nothing is submitted, so
/// nothing is charged.
#[tokio::test]
async fn a_documented_404_proves_the_key_without_generating_anything() {
    let server = MockServer::start(|_req, _n| {
        Response::json(
            404,
            r#"{"detail":"The request does not exist or belongs to another account."}"#,
        )
    });

    let verdict = check_credential(&credential(), &server.base_url()).await;
    assert_eq!(verdict, KeyVerdict::Accepted);
    assert!(verdict.accepted());

    assert_eq!(
        server.paths(),
        [format!("GET {NIL_REQUEST}")],
        "one read-only call to the documented route, and nothing else"
    );
}

/// The scheme is `Key id:secret` — not a bearer token, and not the legacy header pair the
/// docs steer new integrations away from.
#[tokio::test]
async fn the_documented_authorization_header_is_what_goes_out() {
    let server = MockServer::start(|_req, _n| Response::json(404, r#"{"detail":"nope"}"#));
    check_credential(&credential(), &server.base_url()).await;

    server.with_first(NIL_REQUEST, |req| {
        assert_eq!(req.method, "GET", "the check never writes anything");
        assert_eq!(req.header("authorization"), Some("Key test-id:test-secret"));
        assert!(
            req.header("hf-api-key").is_none() && req.header("hf-secret").is_none(),
            "the legacy header pair is not what a new integration sends"
        );
        assert!(req.body.is_empty(), "a GET carries no body");
    });
}

/// A credential pasted whole — the single `key_id:key_secret` string Higgsfield's own
/// SDKs take — authenticates exactly as two typed halves do.
#[tokio::test]
async fn a_credential_pasted_whole_sends_the_same_header() {
    let server = MockServer::start(|_req, _n| Response::json(404, "{}"));
    let pasted = Credential::parse("  test-id:test-secret\n", "").expect("pasted whole");

    check_credential(&pasted, &server.base_url()).await;

    server.with_first(NIL_REQUEST, |req| {
        assert_eq!(req.header("authorization"), Some("Key test-id:test-secret"));
    });
}

/// The credential travels in one header and nowhere else — never in the path or a query
/// string, where it would end up in logs and history.
#[tokio::test]
async fn the_credential_never_goes_into_the_url() {
    let server = MockServer::start(|_req, _n| Response::json(401, r#"{"detail":"nope"}"#));
    check_credential(&credential(), &server.base_url()).await;

    server.with_first(NIL_REQUEST, |req| {
        assert!(
            !req.path.contains("test-secret") && !req.path.contains('?'),
            "the credential is never put in a URL: {}",
            req.path
        );
    });
}

/// Each documented answer reaches its own verdict over the wire, and an answer the route
/// does not publish decides nothing — the gateway answers 405 for a GET it cannot route,
/// before it has looked at any credential.
#[tokio::test]
async fn each_answer_reaches_its_own_verdict_over_the_wire() {
    let rejected =
        MockServer::start(|_req, _n| Response::json(401, r#"{"detail":"Invalid credentials"}"#));
    assert_eq!(
        check_credential(&credential(), &rejected.base_url()).await,
        KeyVerdict::Rejected {
            detail: "Invalid credentials".into()
        }
    );

    let refused =
        MockServer::start(|_req, _n| Response::json(403, r#"{"detail":"Insufficient credits"}"#));
    assert_eq!(
        check_credential(&credential(), &refused.base_url()).await,
        KeyVerdict::Refused {
            detail: "Insufficient credits".into()
        }
    );

    let unrouted = MockServer::start(|_req, _n| Response::json(405, ""));
    let verdict = check_credential(&credential(), &unrouted.base_url()).await;
    assert!(
        matches!(verdict, KeyVerdict::Inconclusive { status: 405, .. }),
        "an unrouted GET says nothing about the key: {verdict:?}"
    );
    assert!(!verdict.accepted());
}

/// A host that is not there is not a rejected key — reporting it as one would send
/// someone off to re-mint a credential that was fine all along.
#[tokio::test]
async fn a_host_that_never_answers_is_not_a_rejection() {
    // Port 1 on loopback: nothing listens, so the connection is refused immediately.
    let verdict = check_credential(&credential(), "http://127.0.0.1:1").await;
    assert!(
        matches!(verdict, KeyVerdict::Unreachable { .. }),
        "{verdict:?}"
    );
    assert!(!verdict.accepted());
}

/// A trailing slash on the base URL must not produce `//requests/…`.
#[tokio::test]
async fn a_trailing_slash_on_the_base_url_is_not_doubled() {
    let server = MockServer::start(|_req, _n| Response::json(404, "{}"));
    check_credential(&credential(), &format!("{}/", server.base_url())).await;
    assert_eq!(server.paths(), [format!("GET {NIL_REQUEST}")]);
}
