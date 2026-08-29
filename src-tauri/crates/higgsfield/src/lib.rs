//! Higgsfield image-to-video client.
//!
//! Deliberately free of Tauri, GUI and platform dependencies so it compiles and tests on
//! any machine — the desktop shell in `src-tauri/` is a thin wrapper over this.
//!
//! Everything here follows the published API at <https://docs.higgsfield.ai>:
//!
//! 0. Every call carries `Authorization: Key {key_id}:{key_secret}`
//!    (<https://docs.higgsfield.ai/docs/authentication>) — the credential is one thing in
//!    two halves, and [`Config::credential`] accepts it either as two fields or as the
//!    single `key_id:key_secret` string Higgsfield's own SDKs take.
//! 1. [`Client::upload_image`] puts each rendered still behind a public HTTPS URL,
//!    because every model parameter that takes an image takes a URL and nothing else.
//! 2. [`Client::submit`] posts a flat JSON body to a model endpoint and gets back a
//!    `request_id` with a `status_url`.
//! 3. [`Client::poll`] reads that `status_url` until it reports a terminal state, and
//!    [`Client::download`] fetches the finished MP4 next to the project.
//! 4. [`Client::cancel`] stops a request that has not started processing yet.

mod error;
mod parse;

pub use error::{HiggsfieldError, JobState, Result};
pub use parse::{find_video_url, parse_state, parse_submit, Accepted};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

pub const DEFAULT_BASE_URL: &str = "https://api.higgsfield.ai";
/// The default model endpoint: MiniMax Hailuo-02, a documented image-to-video operation
/// whose contract is exactly a SolCut segment — a first frame under `image_url`, a last
/// frame under `end_image_url`, and a prompt for the motion between them, nothing else
/// required.
///
/// It was [`LEGACY_DEFAULT_ENDPOINT`] (Higgsfield's own "DoP") before. dop's published
/// schema declares the same two frame fields, but the live endpoint is the API face of a
/// single-image, motion-preset product — its product docs have no start→end-frame mode,
/// and the API gives no way to list the preset ids it is built around — and it rejects
/// this app's two-frame requests with a body-level 422 its schema does not predict. The
/// dop endpoints can still be typed into Settings.
pub const DEFAULT_ENDPOINT: &str = "/minimax/hailuo-02/standard/image-to-video";
/// The default endpoint of earlier builds. Every save writes the whole config, so a
/// settings file from one of them carries this literal even when the user never chose a
/// model; `settings::load` in the desktop shell moves it forward to [`DEFAULT_ENDPOINT`].
pub const LEGACY_DEFAULT_ENDPOINT: &str = "/higgsfield-ai/dop/standard";
/// Where a presigned upload URL is minted. See the "File uploads" guide.
pub const UPLOAD_URL_PATH: &str = "/files/generate-upload-url";

/// The documented authentication scheme. `Authorization: Key {key_id}:{key_secret}` — not
/// a bearer token, and not the legacy `hf-api-key`/`hf-secret` pair, which the API still
/// accepts but the docs steer new integrations away from.
/// <https://docs.higgsfield.ai/docs/authentication>
pub const AUTH_SCHEME: &str = "Key";

/// Connection settings. Held by the desktop app, never handed to the webview.
///
/// A credential is a key *id* and a *secret*; both are required, and they travel together
/// in one `Authorization` header. The `api_key`/`api_secret` aliases keep settings files
/// written by earlier builds readable.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    #[serde(alias = "api_key")]
    pub api_key_id: String,
    #[serde(default, alias = "api_secret")]
    pub api_key_secret: String,
    #[serde(default = "default_base_url")]
    pub base_url: String,
    /// The model endpoint appended to `base_url`. Exposed so another documented model can
    /// be pointed at from Settings without shipping a new build.
    #[serde(default = "default_endpoint")]
    pub endpoint: String,
}

fn default_base_url() -> String {
    DEFAULT_BASE_URL.into()
}
fn default_endpoint() -> String {
    DEFAULT_ENDPOINT.into()
}

impl Default for Config {
    fn default() -> Self {
        Self {
            api_key_id: String::new(),
            api_key_secret: String::new(),
            base_url: default_base_url(),
            endpoint: default_endpoint(),
        }
    }
}

impl Config {
    /// The two halves of the credential as they will be sent, or `None` when what is held
    /// is not a whole one.
    ///
    /// Higgsfield issues *one* credential in two parts, and its own SDKs pass the pair
    /// around as a single `key_id:key_secret` string — that is what `HF_KEY` and
    /// `HF_CREDENTIALS` hold. Someone who pastes that whole string into the key-id box has
    /// a perfectly good credential, so split it on the first colon rather than sending
    /// `Key id:secret:` and telling them their key is invalid. The secret itself may
    /// contain colons, so only the first one separates.
    pub fn credential(&self) -> Option<(String, String)> {
        let id = self.api_key_id.trim();
        let secret = self.api_key_secret.trim();

        if !secret.is_empty() {
            return (!id.is_empty()).then(|| (id.to_string(), secret.to_string()));
        }

        let (id, secret) = id.split_once(':')?;
        let (id, secret) = (id.trim(), secret.trim());
        (!id.is_empty() && !secret.is_empty()).then(|| (id.to_string(), secret.to_string()))
    }

    /// Both halves of the credential are needed: the API authenticates on
    /// `Key {id}:{secret}` and rejects a header missing either one.
    pub fn is_configured(&self) -> bool {
        self.credential().is_some()
    }

    /// The same settings with a pasted credential split into its two halves and stray
    /// whitespace gone.
    ///
    /// Applied before anything is stored or displayed, so the settings file and the masked
    /// hint the dialog shows both describe the credential that actually goes on the wire —
    /// a combined string left in the key-id field would otherwise mask the tail of the
    /// *secret* and show it as the key id.
    ///
    /// It also carries [`LEGACY_DEFAULT_ENDPOINT`] forward to [`DEFAULT_ENDPOINT`]:
    /// settings files always store a concrete endpoint, so "never chose a model" and
    /// "chose the then-default" are the same bytes, and the old default rejects every
    /// request this editor can make. The other dop endpoints are left alone — typing one
    /// is unambiguously a choice.
    pub fn normalized(mut self) -> Self {
        match self.credential() {
            Some((id, secret)) => {
                self.api_key_id = id;
                self.api_key_secret = secret;
            }
            None => {
                self.api_key_id = self.api_key_id.trim().to_string();
                self.api_key_secret = self.api_key_secret.trim().to_string();
            }
        }
        self.base_url = self.base_url.trim().to_string();
        self.endpoint = self.endpoint.trim().to_string();
        if self.endpoint == LEGACY_DEFAULT_ENDPOINT {
            self.endpoint = DEFAULT_ENDPOINT.to_string();
        }
        self
    }

    fn url(&self, path: &str) -> String {
        let base = self.base_url.trim_end_matches('/');
        let path = path.trim_start_matches('/');
        format!("{base}/{path}")
    }

    fn submit_url(&self) -> String {
        self.url(&self.endpoint)
    }
}

/// A still handed to the API as the start or end of the motion.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Frame {
    /// `data:image/jpeg;base64,…` — how the editor hands over a locally rendered
    /// still. It is uploaded before submission, because the API only takes URLs.
    DataUrl(String),
    /// An already-hosted image, passed straight through.
    Url(String),
}

impl Frame {
    /// Build a data URL from raw encoded image bytes.
    pub fn from_jpeg_bytes(bytes: &[u8]) -> Self {
        let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
        Self::DataUrl(format!("data:image/jpeg;base64,{b64}"))
    }
}

/// The image content types the upload endpoint accepts.
const SUPPORTED_IMAGE_TYPES: &[&str] = &[
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "image/gif",
];

/// Split `data:image/jpeg;base64,…` into its content type and bytes.
fn decode_data_url(url: &str) -> Result<(String, Vec<u8>)> {
    let rest = url
        .strip_prefix("data:")
        .ok_or_else(|| HiggsfieldError::Malformed("a frame is not a data URL".into()))?;
    let (meta, payload) = rest
        .split_once(',')
        .ok_or_else(|| HiggsfieldError::Malformed("a frame data URL has no payload".into()))?;

    let content_type = meta.split(';').next().unwrap_or("").to_ascii_lowercase();
    if !SUPPORTED_IMAGE_TYPES.contains(&content_type.as_str()) {
        return Err(HiggsfieldError::Malformed(format!(
            "{content_type:?} is not an image type the API accepts"
        )));
    }
    if !meta.contains("base64") {
        return Err(HiggsfieldError::Malformed(
            "a frame data URL must be base64-encoded".into(),
        ));
    }

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|e| HiggsfieldError::Malformed(format!("undecodable frame data URL: {e}")))?;
    Ok((content_type, bytes))
}

/// One "animate from this frame to that frame" request.
///
/// There is deliberately no duration here: no documented endpoint takes a free-form
/// length. The models publish fixed choices (the default hailuo-02 operation has none at
/// all), and the editor fits whatever comes back into the segment it replaces.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerateRequest {
    pub prompt: String,
    /// The photo the motion starts from.
    pub start_frame: Frame,
    /// The same for the photo the motion ends on. Omitted for a single-image animation;
    /// supplied, it pins where the motion ends.
    pub end_frame: Option<Frame>,
    pub seed: Option<u64>,
}

/// The JSON body for a model endpoint, from already-uploaded image URLs.
///
/// Every documented image-to-video model takes a flat `{prompt, image_url, …}` object —
/// there is no `params` envelope and no `model` field, the model *is* the path. Two
/// details vary by endpoint and are the only thing this branches on:
///
/// * the veo `first-last-frame-to-video` operations name their images
///   `first_frame_url`/`last_frame_url` rather than `image_url`/`end_image_url`;
/// * only the `dop` and `wan-25-preview` schemas declare a `seed`, and an undeclared
///   field is a `422`.
///
/// Kept as its own function so the wire format is unit-testable without a network.
pub fn build_body(
    endpoint: &str,
    prompt: &str,
    start_url: &str,
    end_url: Option<&str>,
    seed: Option<u64>,
) -> Value {
    let (start_key, end_key) = if endpoint.contains("first-last-frame-to-video") {
        ("first_frame_url", "last_frame_url")
    } else {
        ("image_url", "end_image_url")
    };

    let mut body = Map::new();
    body.insert("prompt".into(), json!(prompt));
    body.insert(start_key.into(), json!(start_url));
    if let Some(end) = end_url {
        body.insert(end_key.into(), json!(end));
    }
    if let Some(seed) = seed.filter(|_| endpoint_takes_a_seed(endpoint)) {
        body.insert("seed".into(), json!(seed));
    }
    Value::Object(body)
}

fn endpoint_takes_a_seed(endpoint: &str) -> bool {
    endpoint.contains("/dop/") || endpoint.contains("wan-25-preview")
}

pub struct Client {
    http: reqwest::Client,
    config: Config,
    /// `Key {id}:{secret}`, built and validated once at construction and flagged sensitive
    /// so reqwest keeps it out of its own diagnostics.
    auth: reqwest::header::HeaderValue,
}

/// Hand-written so a stray `{:?}` in a log line cannot print the credential.
impl std::fmt::Debug for Client {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Client")
            .field("base_url", &self.config.base_url)
            .field("endpoint", &self.config.endpoint)
            .field("configured", &self.config.is_configured())
            .finish()
    }
}

impl Client {
    pub fn new(config: Config) -> Result<Self> {
        let config = config.normalized();
        let (key_id, key_secret) = config.credential().ok_or(HiggsfieldError::NotConfigured)?;

        // A credential copied out of a dashboard can arrive with a line break or a
        // non-ASCII character in it. reqwest would defer that to `send()` and report it as
        // an opaque "builder error" transport failure, which reads like the network is
        // down; catch it here and say what is actually wrong.
        let mut auth =
            reqwest::header::HeaderValue::from_str(&format!("{AUTH_SCHEME} {key_id}:{key_secret}"))
                .map_err(|_| {
                    HiggsfieldError::BadCredential(
                        "the key id or secret contains a character that cannot go in an HTTP \
                         header — re-copy the credential from cloud.higgsfield.ai"
                            .into(),
                    )
                })?;
        auth.set_sensitive(true);

        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()?;
        Ok(Self { http, config, auth })
    }

    pub fn config(&self) -> &Config {
        &self.config
    }

    /// `Authorization: Key {key_id}:{key_secret}`, the documented scheme.
    fn auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        req.header(reqwest::header::AUTHORIZATION, self.auth.clone())
    }

    /// Put an image behind a public HTTPS URL: mint a presigned upload, PUT the bytes with
    /// every header the API returned, and hand back the `public_url` to pass as a model
    /// parameter.
    pub async fn upload_image(&self, bytes: Vec<u8>, content_type: &str) -> Result<String> {
        let minted = self
            .auth(self.http.post(self.config.url(UPLOAD_URL_PATH)))
            .json(&json!({ "content_type": content_type }))
            .send()
            .await?;
        let minted = read_json(minted).await?;

        let upload_url = minted
            .get("upload_url")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                HiggsfieldError::Malformed("the upload response carried no upload_url".into())
            })?;
        let public_url = minted
            .get("public_url")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                HiggsfieldError::Malformed("the upload response carried no public_url".into())
            })?
            .to_string();

        // The presigned URL is storage, not Higgsfield: it wants the headers it was signed
        // with and must never see the API credential.
        let mut put = self.http.put(upload_url);
        for (name, value) in upload_headers(&minted, content_type) {
            put = put.header(name, value);
        }
        let stored = put.body(bytes).send().await?;
        if !stored.status().is_success() {
            return Err(HiggsfieldError::Http {
                status: stored.status().as_u16(),
                body: preview(&stored.text().await.unwrap_or_default()),
            });
        }

        Ok(public_url)
    }

    /// A [`Frame`] as a URL the API can fetch, uploading it first when it is inline data.
    async fn frame_url(&self, frame: &Frame) -> Result<String> {
        match frame {
            Frame::Url(url) => Ok(url.clone()),
            Frame::DataUrl(url) => {
                let (content_type, bytes) = decode_data_url(url)?;
                self.upload_image(bytes, &content_type).await
            }
        }
    }

    /// Send a generation request. Returns as soon as the API has accepted it, with the
    /// `status_url` to poll.
    pub async fn submit(&self, req: &GenerateRequest) -> Result<Accepted> {
        let start_url = self.frame_url(&req.start_frame).await?;
        let end_url = match &req.end_frame {
            Some(frame) => Some(self.frame_url(frame).await?),
            None => None,
        };

        let body = build_body(
            &self.config.endpoint,
            &req.prompt,
            &start_url,
            end_url.as_deref(),
            req.seed,
        );
        let response = self
            .auth(self.http.post(self.config.submit_url()))
            .json(&body)
            .send()
            .await?;

        parse_submit(&read_json(response).await?, &self.config.base_url)
    }

    /// Ask where a request has got to. `status_url` comes from the submit response, which
    /// the docs ask callers to use rather than build a URL themselves.
    pub async fn poll(&self, status_url: &str) -> Result<JobState> {
        let response = self.auth(self.http.get(status_url)).send().await?;
        parse_state(&read_json(response).await?)
    }

    /// Cancel a request that has not started processing.
    ///
    /// `202` means it is cancelled; `400` means generation had already begun and the
    /// request will run to completion, which is a normal race rather than an error.
    pub async fn cancel(&self, cancel_url: &str) -> Result<bool> {
        let response = self.auth(self.http.post(cancel_url)).send().await?;
        match response.status().as_u16() {
            200..=299 => Ok(true),
            400 => Ok(false),
            _ => Err(read_json(response).await.unwrap_err()),
        }
    }

    /// Credential check for the Settings dialog. Minting a presigned upload URL is free
    /// and generates nothing, and a `200` proves the base URL, the key id, the secret and
    /// the account are all good — which a 404-shaped probe cannot.
    pub async fn check_credentials(&self) -> Result<()> {
        let response = self
            .auth(self.http.post(self.config.url(UPLOAD_URL_PATH)))
            .json(&json!({ "content_type": "image/jpeg" }))
            .send()
            .await?;
        read_json(response).await.map(|_| ())
    }

    /// Stream the finished video to `dest`, returning the bytes written.
    pub async fn download(&self, url: &str, dest: &Path) -> Result<u64> {
        use tokio::io::AsyncWriteExt as _;

        let response = self.http.get(url).send().await?;
        if !response.status().is_success() {
            return Err(HiggsfieldError::Http {
                status: response.status().as_u16(),
                body: "could not download the generated video".into(),
            });
        }

        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| HiggsfieldError::Io(e.to_string()))?;
        }

        // Write beside the target and rename, so a cancelled download never leaves a
        // truncated file that the timeline would happily try to play.
        let tmp = dest.with_extension("part");
        let mut file = tokio::fs::File::create(&tmp)
            .await
            .map_err(|e| HiggsfieldError::Io(e.to_string()))?;

        let mut written = 0u64;
        let mut stream = response;
        while let Some(chunk) = stream
            .chunk()
            .await
            .map_err(|e| HiggsfieldError::Transport(e.to_string()))?
        {
            file.write_all(&chunk)
                .await
                .map_err(|e| HiggsfieldError::Io(e.to_string()))?;
            written += chunk.len() as u64;
        }
        file.flush()
            .await
            .map_err(|e| HiggsfieldError::Io(e.to_string()))?;
        drop(file);

        tokio::fs::rename(&tmp, dest)
            .await
            .map_err(|e| HiggsfieldError::Io(e.to_string()))?;
        Ok(written)
    }
}

/// The headers a presigned PUT has to carry. The docs say to send every entry of
/// `upload_headers`; `Content-Type` is spelled out because the upload has to match the
/// type the URL was signed for.
fn upload_headers(minted: &Value, content_type: &str) -> BTreeMap<String, String> {
    let mut headers = BTreeMap::new();
    headers.insert("Content-Type".to_string(), content_type.to_string());
    if let Some(map) = minted.get("upload_headers").and_then(Value::as_object) {
        for (name, value) in map {
            if let Some(value) = value.as_str() {
                headers.insert(name.clone(), value.to_string());
            }
        }
    }
    headers
}

/// Turn a response into JSON, mapping the status codes the UI has distinct states for.
///
/// Errors use the FastAPI envelope `{"detail": …}`, so the detail is lifted out and shown
/// instead of the raw body wherever there is one.
async fn read_json(response: reqwest::Response) -> Result<Value> {
    let status = response.status();
    let retry_after = response
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());

    let body = response.text().await.unwrap_or_default();

    match status.as_u16() {
        200..=299 => serde_json::from_str(&body).map_err(|e| {
            HiggsfieldError::Malformed(format!("{e} (body started with: {})", preview(&body)))
        }),
        401 => Err(HiggsfieldError::Unauthorized {
            status: 401,
            detail: detail_of(&body),
        }),
        403 => Err(HiggsfieldError::InsufficientCredits {
            detail: detail_of(&body),
        }),
        429 => Err(HiggsfieldError::RateLimited {
            retry_after_secs: retry_after,
        }),
        other => Err(HiggsfieldError::Http {
            status: other,
            body: detail_of(&body),
        }),
    }
}

/// The human part of an error body: `detail` when it parses as the documented envelope,
/// the truncated body otherwise (an HTML gateway page, say).
fn detail_of(body: &str) -> String {
    match serde_json::from_str::<Value>(body) {
        Ok(value) => match value.get("detail") {
            Some(Value::String(s)) => s.clone(),
            // Validation errors put a list of problems in `detail`.
            Some(Value::Array(problems)) => validation_messages(problems)
                .unwrap_or_else(|| preview(&Value::Array(problems.clone()).to_string())),
            Some(other) => preview(&other.to_string()),
            None => preview(body),
        },
        Err(_) => preview(body),
    }
}

/// A validation list reduced to what was actually wrong: `field: message` per entry.
///
/// Each entry of a FastAPI/pydantic 422 also carries `input` — the rejected value echoed
/// back, which for a submission is the whole body including two long image URLs. Dumping
/// the raw list put that echo (serialised first, keys being sorted) in front of `msg`,
/// and the length cap then cut off exactly the part that said what was invalid. So: keep
/// `loc` and `msg`, drop the rest.
fn validation_messages(problems: &[Value]) -> Option<String> {
    let lines: Vec<String> = problems
        .iter()
        .filter_map(|problem| {
            let msg = problem.get("msg").and_then(Value::as_str)?;
            let field = problem
                .get("loc")
                .and_then(Value::as_array)
                .map(|loc| {
                    loc.iter()
                        // Skip the constant "body" prefix and numeric list indexes —
                        // "motions.id" reads better than "body.motions.0.id".
                        .filter_map(Value::as_str)
                        .filter(|part| *part != "body")
                        .collect::<Vec<_>>()
                        .join(".")
                })
                .filter(|field| !field.is_empty());
            Some(match field {
                Some(field) => format!("{field}: {msg}"),
                None => msg.to_string(),
            })
        })
        .collect();
    (!lines.is_empty()).then(|| preview(&lines.join("; ")))
}

fn preview(body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.chars().count() <= 200 {
        return trimmed.to_string();
    }
    let head: String = trimmed.chars().take(200).collect();
    format!("{head}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> Config {
        Config {
            api_key_id: "id".into(),
            api_key_secret: "secret".into(),
            ..Default::default()
        }
    }

    #[test]
    fn refuses_to_build_a_client_without_both_halves_of_the_credential() {
        let err = Client::new(Config::default()).unwrap_err();
        assert!(matches!(err, HiggsfieldError::NotConfigured));

        // A key id on its own cannot form a `Key id:secret` header.
        let id_only = Config {
            api_key_id: "id".into(),
            ..Config::default()
        };
        assert!(!id_only.is_configured());
        assert!(matches!(
            Client::new(id_only).unwrap_err(),
            HiggsfieldError::NotConfigured
        ));
    }

    #[test]
    fn a_credential_pasted_whole_is_split_on_its_first_colon() {
        // The form Higgsfield's own SDKs take, in `HF_KEY` / `HF_CREDENTIALS`.
        let pasted = Config {
            api_key_id: "key-id:key-secret".into(),
            ..Config::default()
        };
        assert!(pasted.is_configured(), "a whole credential, in one box");
        assert_eq!(
            pasted.credential(),
            Some(("key-id".into(), "key-secret".into()))
        );

        let split = pasted.normalized();
        assert_eq!(split.api_key_id, "key-id");
        assert_eq!(split.api_key_secret, "key-secret");
    }

    #[test]
    fn a_secret_with_colons_in_it_survives_the_split() {
        let pasted = Config {
            api_key_id: "key-id:sec:ret".into(),
            ..Config::default()
        };
        assert_eq!(
            pasted.credential(),
            Some(("key-id".into(), "sec:ret".into())),
            "only the first colon separates the two halves"
        );
    }

    #[test]
    fn two_filled_boxes_are_never_re_split() {
        let typed = Config {
            api_key_id: "key:id".into(),
            api_key_secret: "secret".into(),
            ..Config::default()
        };
        assert_eq!(
            typed.credential(),
            Some(("key:id".into(), "secret".into())),
            "a colon in a key id the user typed in full is part of the key id"
        );
    }

    #[test]
    fn whitespace_around_a_pasted_credential_is_ignored() {
        let messy = Config {
            api_key_id: "  key-id\n".into(),
            api_key_secret: "\tkey-secret ".into(),
            ..Config::default()
        };
        assert_eq!(
            messy.credential(),
            Some(("key-id".into(), "key-secret".into()))
        );

        let pasted = Config {
            api_key_id: " key-id : key-secret \n".into(),
            ..Config::default()
        };
        assert_eq!(
            pasted.credential(),
            Some(("key-id".into(), "key-secret".into()))
        );
    }

    #[test]
    fn half_a_pasted_credential_is_still_not_a_credential() {
        for id in ["key-id:", ":key-secret", ":", "key-id"] {
            let config = Config {
                api_key_id: id.into(),
                ..Config::default()
            };
            assert!(!config.is_configured(), "{id:?} is not a whole credential");
        }
    }

    #[test]
    fn a_credential_that_cannot_form_a_header_says_so_instead_of_failing_as_a_network_error() {
        // An interior line break survives a paste and cannot go in a header value.
        // reqwest would defer this to `send()` and report "builder error".
        let broken = Config {
            api_key_id: "key-id".into(),
            api_key_secret: "sec\nret".into(),
            ..Config::default()
        };
        let err = Client::new(broken).unwrap_err();
        let HiggsfieldError::BadCredential(detail) = &err else {
            panic!("expected a credential error, got {err:?}");
        };
        assert!(detail.contains("cloud.higgsfield.ai"), "{detail}");
        assert_eq!(err.title(), "Authentication failed");
        assert!(
            !err.is_retryable(),
            "retrying the same bad paste cannot help"
        );
    }

    #[test]
    fn the_defaults_are_the_documented_api() {
        let c = Config::default();
        assert_eq!(c.base_url, "https://api.higgsfield.ai");
        assert_eq!(c.endpoint, "/minimax/hailuo-02/standard/image-to-video");
        assert_eq!(
            AUTH_SCHEME, "Key",
            "the documented scheme is `Key id:secret`, not a bearer token"
        );
    }

    #[test]
    fn builds_urls_without_doubling_slashes() {
        let c = Config {
            base_url: "https://api.test/".into(),
            ..cfg()
        };
        assert_eq!(
            c.submit_url(),
            "https://api.test/minimax/hailuo-02/standard/image-to-video"
        );
        assert_eq!(
            c.url(UPLOAD_URL_PATH),
            "https://api.test/files/generate-upload-url"
        );
    }

    /// The regression behind "error when generating a transition": earlier builds stored
    /// `/higgsfield-ai/dop/standard` the moment a key was saved, chosen or not, and that
    /// endpoint rejects the two-frame requests this editor makes with a body-level 422.
    #[test]
    fn the_legacy_default_endpoint_follows_the_default_forward() {
        let stale = Config {
            endpoint: LEGACY_DEFAULT_ENDPOINT.into(),
            ..cfg()
        }
        .normalized();
        assert_eq!(stale.endpoint, DEFAULT_ENDPOINT);
        assert_eq!(stale.api_key_id, "id", "the credential is untouched");
    }

    #[test]
    fn any_other_endpoint_is_a_choice_and_kept() {
        for chosen in [
            "/higgsfield-ai/dop/turbo",
            "/veo3.1/first-last-frame-to-video",
        ] {
            let config = Config {
                endpoint: chosen.into(),
                ..cfg()
            }
            .normalized();
            assert_eq!(config.endpoint, chosen);
        }
    }

    #[test]
    fn a_settings_file_from_an_earlier_build_still_reads() {
        let stored = r#"{"api_key":"old-id","api_secret":"old-secret","model":"dop"}"#;
        let config: Config = serde_json::from_str(stored).expect("legacy settings");
        assert_eq!(config.api_key_id, "old-id");
        assert_eq!(config.api_key_secret, "old-secret");
        assert!(config.is_configured());

        // An earlier build stored whatever was pasted, combined form included.
        let combined = r#"{"api_key":"old-id:old-secret"}"#;
        let config: Config = serde_json::from_str::<Config>(combined)
            .expect("legacy settings")
            .normalized();
        assert_eq!(config.api_key_id, "old-id");
        assert_eq!(config.api_key_secret, "old-secret");
    }

    #[test]
    fn the_body_is_flat_and_names_both_frames() {
        let body = build_body(
            "/higgsfield-ai/dop/standard",
            "slow dolly-in",
            "https://cdn.test/a.jpg",
            Some("https://cdn.test/b.jpg"),
            Some(7),
        );
        assert_eq!(body["prompt"], "slow dolly-in");
        assert_eq!(body["image_url"], "https://cdn.test/a.jpg");
        assert_eq!(body["end_image_url"], "https://cdn.test/b.jpg");
        assert_eq!(body["seed"], 7);
        assert!(
            body.get("params").is_none() && body.get("model").is_none(),
            "no envelope and no model field: the model is the endpoint"
        );
    }

    #[test]
    fn the_default_endpoint_names_both_frames_and_declares_no_seed() {
        let body = build_body(
            DEFAULT_ENDPOINT,
            "slow dolly-in",
            "https://cdn.test/a.jpg",
            Some("https://cdn.test/b.jpg"),
            Some(7),
        );
        assert_eq!(body["image_url"], "https://cdn.test/a.jpg");
        assert_eq!(body["end_image_url"], "https://cdn.test/b.jpg");
        assert!(
            body.get("seed").is_none(),
            "hailuo-02 declares no seed, and an undeclared field risks a 422"
        );
    }

    #[test]
    fn a_single_frame_sends_one_image() {
        let body = build_body(
            "/higgsfield-ai/dop/standard",
            "drift",
            "https://cdn.test/a.jpg",
            None,
            None,
        );
        assert!(body.get("end_image_url").is_none());
        assert!(body.get("seed").is_none());
    }

    #[test]
    fn the_veo_first_last_endpoint_uses_its_own_parameter_names() {
        let body = build_body(
            "/veo3.1/first-last-frame-to-video",
            "pan",
            "https://cdn.test/a.jpg",
            Some("https://cdn.test/b.jpg"),
            Some(7),
        );
        assert_eq!(body["first_frame_url"], "https://cdn.test/a.jpg");
        assert_eq!(body["last_frame_url"], "https://cdn.test/b.jpg");
        assert!(
            body.get("seed").is_none(),
            "veo declares no seed, and an undeclared field is a 422"
        );
    }

    #[test]
    fn jpeg_bytes_round_trip_through_a_data_url() {
        let Frame::DataUrl(url) = Frame::from_jpeg_bytes(&[0xff, 0xd8, 0xff]) else {
            panic!("expected a data url");
        };
        assert!(url.starts_with("data:image/jpeg;base64,"));

        let (content_type, bytes) = decode_data_url(&url).expect("decode");
        assert_eq!(content_type, "image/jpeg");
        assert_eq!(bytes, vec![0xff, 0xd8, 0xff]);
    }

    #[test]
    fn an_unsupported_frame_type_is_refused_before_it_is_uploaded() {
        let err = decode_data_url("data:image/tiff;base64,AAAA").unwrap_err();
        assert!(matches!(err, HiggsfieldError::Malformed(_)), "{err:?}");
    }

    #[test]
    fn presigned_uploads_carry_every_header_the_api_returned() {
        let minted = json!({
            "upload_headers": {"Content-Type": "image/jpeg", "x-amz-tagging": "retention=temporary"}
        });
        let headers = upload_headers(&minted, "image/jpeg");
        assert_eq!(
            headers.get("x-amz-tagging").map(String::as_str),
            Some("retention=temporary")
        );
        assert_eq!(
            headers.get("Content-Type").map(String::as_str),
            Some("image/jpeg")
        );
        assert!(
            !headers
                .keys()
                .any(|k| k.eq_ignore_ascii_case("authorization")),
            "the API credential never reaches the storage host"
        );
    }

    #[test]
    fn error_bodies_are_reduced_to_their_detail() {
        assert_eq!(
            detail_of(r#"{"detail":"Invalid credentials"}"#),
            "Invalid credentials"
        );
        assert!(detail_of(r#"{"detail":[{"loc":["body","image_url"]}]}"#).contains("image_url"));
        assert_eq!(
            detail_of("<html>bad gateway</html>"),
            "<html>bad gateway</html>"
        );
    }

    /// The regression behind "Generation failed" cards that showed nothing but URLs: a
    /// 422's entries echo the whole submitted body under `input`, and serialising the
    /// raw list put ~230 characters of image URL in front of `msg` — which the length
    /// cap then cut off. What must survive is the message; what must go is the echo.
    #[test]
    fn a_validation_list_surfaces_the_message_not_the_echoed_input() {
        let url = format!(
            "https://cdn.test/{}/{}.jpeg",
            "a".repeat(80),
            "b".repeat(40)
        );
        let body = json!({
            "detail": [{
                "type": "value_error",
                "loc": ["body"],
                "msg": "Value error, end frame is not supported by this model",
                "input": {"end_image_url": url, "image_url": url, "prompt": "drift"}
            }]
        });
        let detail = detail_of(&body.to_string());
        assert_eq!(
            detail,
            "Value error, end frame is not supported by this model"
        );
        assert!(
            !detail.contains("cdn.test"),
            "the input echo is dropped: {detail}"
        );
    }

    #[test]
    fn every_validation_problem_is_named_with_its_field() {
        let body = json!({
            "detail": [
                {"type": "missing", "loc": ["body", "duration"], "msg": "Field required", "input": {}},
                {"type": "missing", "loc": ["body", "motions", 0, "id"], "msg": "Field required", "input": {}}
            ]
        });
        assert_eq!(
            detail_of(&body.to_string()),
            "duration: Field required; motions.id: Field required",
            "the constant `body` prefix and list indexes are noise"
        );
    }

    #[test]
    fn a_validation_list_without_messages_still_shows_something() {
        let detail = detail_of(r#"{"detail":[{"loc":["body","seed"],"type":"int_type"}]}"#);
        assert!(detail.contains("seed"), "{detail}");
    }

    #[test]
    fn error_titles_are_distinct_per_state() {
        assert_eq!(HiggsfieldError::NotConfigured.title(), "Not connected");
        assert_eq!(
            HiggsfieldError::InsufficientCredits {
                detail: String::new()
            }
            .title(),
            "Out of credits"
        );
        assert!(HiggsfieldError::RateLimited {
            retry_after_secs: None
        }
        .is_retryable());
        assert!(!HiggsfieldError::Unauthorized {
            status: 401,
            detail: String::new()
        }
        .is_retryable());
        assert!(HiggsfieldError::Http {
            status: 503,
            body: String::new()
        }
        .is_retryable());
        assert!(
            HiggsfieldError::Http {
                status: 423,
                body: String::new()
            }
            .is_retryable(),
            "423 is a temporarily blocked model, which is worth another go"
        );
        assert!(!HiggsfieldError::Http {
            status: 422,
            body: String::new()
        }
        .is_retryable());
    }

    #[test]
    fn long_error_bodies_are_truncated() {
        let long = "x".repeat(5_000);
        assert!(preview(&long).chars().count() <= 201);
    }
}
