//! Higgsfield image-to-video client.
//!
//! Deliberately free of Tauri, GUI and platform dependencies so it compiles and tests on
//! any machine — the desktop shell in `src-tauri/` is a thin wrapper over this.
//!
//! The flow is: [`Client::submit`] a prompt plus the two rendered keyframes, poll
//! [`Client::poll`] until it reports [`JobState::Succeeded`], then [`Client::download`]
//! the result next to the project.

mod error;
mod parse;

pub use error::{HiggsfieldError, JobState, Result};
pub use parse::{find_video_url, parse_state, parse_submit};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;

pub const DEFAULT_BASE_URL: &str = "https://platform.higgsfield.ai";
pub const DEFAULT_MODEL: &str = "dop";
pub const DEFAULT_ENDPOINT: &str = "/v1/image2video";

/// Connection settings. Held by the desktop app, never handed to the webview.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub api_key: String,
    #[serde(default)]
    pub api_secret: String,
    #[serde(default = "default_base_url")]
    pub base_url: String,
    #[serde(default = "default_model")]
    pub model: String,
    /// Path appended to `base_url` for submissions. Exposed so a new API revision can be
    /// pointed at from Settings without shipping a new build.
    #[serde(default = "default_endpoint")]
    pub endpoint: String,
}

fn default_base_url() -> String {
    DEFAULT_BASE_URL.into()
}
fn default_model() -> String {
    DEFAULT_MODEL.into()
}
fn default_endpoint() -> String {
    DEFAULT_ENDPOINT.into()
}

impl Default for Config {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            api_secret: String::new(),
            base_url: default_base_url(),
            model: default_model(),
            endpoint: default_endpoint(),
        }
    }
}

impl Config {
    pub fn is_configured(&self) -> bool {
        !self.api_key.trim().is_empty()
    }

    fn submit_url(&self) -> String {
        let base = self.base_url.trim_end_matches('/');
        let path = self.endpoint.trim_start_matches('/');
        format!("{base}/{path}")
    }

    fn poll_url(&self, job_set_id: &str) -> String {
        let base = self.base_url.trim_end_matches('/');
        format!("{base}/v1/job-sets/{job_set_id}")
    }
}

/// A still handed to the API as the start or end of the motion.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Frame {
    /// `data:image/jpeg;base64,…` — how the editor sends locally rendered keyframes.
    DataUrl(String),
    /// An already-hosted image.
    Url(String),
}

impl Frame {
    /// Build a data URL from raw encoded image bytes.
    pub fn from_jpeg_bytes(bytes: &[u8]) -> Self {
        let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
        Self::DataUrl(format!("data:image/jpeg;base64,{b64}"))
    }

    fn as_str(&self) -> &str {
        match self {
            Self::DataUrl(s) | Self::Url(s) => s,
        }
    }
}

/// One "animate the gap between these two keyframes" request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerateRequest {
    pub prompt: String,
    /// The photo framed as the first keyframe describes it.
    pub start_frame: Frame,
    /// The photo framed as the second keyframe describes it. Omitted for a
    /// single-image animation; supplied, it pins where the motion ends.
    pub end_frame: Option<Frame>,
    pub duration_seconds: f32,
    pub seed: Option<u64>,
}

impl GenerateRequest {
    /// The JSON body sent to Higgsfield.
    ///
    /// Kept as its own function so the wire format is unit-testable without a network.
    pub fn to_body(&self, model: &str) -> Value {
        let mut images = vec![json!({
            "type": "image_url",
            "image_url": self.start_frame.as_str(),
            "role": "start",
        })];
        if let Some(end) = &self.end_frame {
            images.push(json!({
                "type": "image_url",
                "image_url": end.as_str(),
                "role": "end",
            }));
        }

        let mut params = json!({
            "model": model,
            "prompt": self.prompt,
            "input_images": images,
            "duration": round2(self.duration_seconds),
        });
        if let Some(seed) = self.seed {
            params["seed"] = json!(seed);
        }
        json!({ "params": params })
    }
}

/// Round to two decimals *in f64*. Serialising an f32 straight to JSON turns 3.2 into
/// 3.200000047683716, which some validators reject and all of them log badly.
fn round2(v: f32) -> f64 {
    ((v as f64) * 100.0).round() / 100.0
}

/// The id of an accepted job set, used for polling.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JobHandle {
    pub job_set_id: String,
}

pub struct Client {
    http: reqwest::Client,
    config: Config,
}

/// Hand-written so a stray `{:?}` in a log line cannot print the API key.
impl std::fmt::Debug for Client {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Client")
            .field("base_url", &self.config.base_url)
            .field("model", &self.config.model)
            .field("configured", &self.config.is_configured())
            .finish()
    }
}

impl Client {
    pub fn new(config: Config) -> Result<Self> {
        if !config.is_configured() {
            return Err(HiggsfieldError::NotConfigured);
        }
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()?;
        Ok(Self { http, config })
    }

    pub fn config(&self) -> &Config {
        &self.config
    }

    fn auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        let req = req
            .header("hf-api-key", &self.config.api_key)
            .header("Authorization", format!("Key {}", self.config.api_key));
        if self.config.api_secret.trim().is_empty() {
            req
        } else {
            req.header("hf-secret", &self.config.api_secret)
        }
    }

    /// Send a generation request. Returns as soon as the API has accepted the job.
    pub async fn submit(&self, req: &GenerateRequest) -> Result<JobHandle> {
        let body = req.to_body(&self.config.model);
        let response = self
            .auth(self.http.post(self.config.submit_url()))
            .json(&body)
            .send()
            .await?;

        let value = read_json(response).await?;
        Ok(JobHandle {
            job_set_id: parse_submit(&value)?,
        })
    }

    /// Ask where a job set has got to.
    pub async fn poll(&self, job_set_id: &str) -> Result<JobState> {
        let response = self
            .auth(self.http.get(self.config.poll_url(job_set_id)))
            .send()
            .await?;

        let value = read_json(response).await?;
        Ok(parse_state(&value))
    }

    /// Cheap credential check for the Settings dialog: a poll of a known-absent job set.
    /// Anything other than an auth rejection means the key was accepted.
    pub async fn check_credentials(&self) -> Result<()> {
        let response = self
            .auth(self.http.get(self.config.poll_url("connection-check")))
            .send()
            .await?;

        match response.status().as_u16() {
            401 | 403 => Err(HiggsfieldError::Unauthorized {
                status: response.status().as_u16(),
            }),
            status if status >= 500 => Err(HiggsfieldError::Http {
                status,
                body: response.text().await.unwrap_or_default(),
            }),
            _ => Ok(()),
        }
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

/// Turn a response into JSON, mapping the status codes the UI has distinct states for.
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
        401 | 403 => Err(HiggsfieldError::Unauthorized {
            status: status.as_u16(),
        }),
        429 => Err(HiggsfieldError::RateLimited {
            retry_after_secs: retry_after,
        }),
        other => Err(HiggsfieldError::Http {
            status: other,
            body: preview(&body),
        }),
    }
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
            api_key: "k".into(),
            ..Default::default()
        }
    }

    #[test]
    fn refuses_to_build_a_client_without_a_key() {
        let err = Client::new(Config::default()).unwrap_err();
        assert!(matches!(err, HiggsfieldError::NotConfigured));
    }

    #[test]
    fn builds_urls_without_doubling_slashes() {
        let c = Config {
            base_url: "https://api.test/".into(),
            ..cfg()
        };
        assert_eq!(c.submit_url(), "https://api.test/v1/image2video");
        assert_eq!(c.poll_url("js_1"), "https://api.test/v1/job-sets/js_1");
    }

    #[test]
    fn body_carries_both_keyframes_in_order() {
        let req = GenerateRequest {
            prompt: "slow dolly-in".into(),
            start_frame: Frame::Url("https://x.test/a.jpg".into()),
            end_frame: Some(Frame::Url("https://x.test/b.jpg".into())),
            duration_seconds: 3.2,
            seed: Some(7),
        };
        let body = req.to_body("dop");
        let images = body["params"]["input_images"].as_array().unwrap();

        assert_eq!(images.len(), 2);
        assert_eq!(images[0]["role"], "start");
        assert_eq!(images[0]["image_url"], "https://x.test/a.jpg");
        assert_eq!(images[1]["role"], "end");
        assert_eq!(body["params"]["prompt"], "slow dolly-in");
        assert_eq!(body["params"]["model"], "dop");
        assert_eq!(body["params"]["duration"], 3.2);
        assert_eq!(body["params"]["seed"], 7);
    }

    #[test]
    fn a_single_keyframe_sends_one_image_and_no_seed() {
        let req = GenerateRequest {
            prompt: "drift".into(),
            start_frame: Frame::Url("https://x.test/a.jpg".into()),
            end_frame: None,
            duration_seconds: 2.0,
            seed: None,
        };
        let body = req.to_body("dop");
        assert_eq!(body["params"]["input_images"].as_array().unwrap().len(), 1);
        assert!(body["params"].get("seed").is_none());
    }

    #[test]
    fn jpeg_bytes_become_a_data_url() {
        let Frame::DataUrl(url) = Frame::from_jpeg_bytes(&[0xff, 0xd8, 0xff]) else {
            panic!("expected a data url");
        };
        assert!(url.starts_with("data:image/jpeg;base64,"));
    }

    #[test]
    fn error_titles_are_distinct_per_state() {
        assert_eq!(HiggsfieldError::NotConfigured.title(), "Not connected");
        assert_eq!(
            HiggsfieldError::RateLimited {
                retry_after_secs: Some(30)
            }
            .title(),
            "Rate limited"
        );
        assert!(HiggsfieldError::RateLimited {
            retry_after_secs: None
        }
        .is_retryable());
        assert!(!HiggsfieldError::Unauthorized { status: 401 }.is_retryable());
        assert!(HiggsfieldError::Http {
            status: 503,
            body: String::new()
        }
        .is_retryable());
        assert!(!HiggsfieldError::Http {
            status: 400,
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
