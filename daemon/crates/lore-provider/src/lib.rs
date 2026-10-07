//! OpenAI-compatible embedding provider client.
//!
//! Response validation follows the v2 contract: bounded body, complete and
//! unique indices, expected dimensions, finite values, nonzero norm and no
//! partial vectors on a malformed batch. Results are mapped by validated
//! index, never by array position.

use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::Request;
use hyper_util::rt::TokioIo;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::net::TcpStream;

/// Hard cap for a provider response body.
pub const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
/// Hard cap for decoded dimensions.
pub const MAX_DIMENSIONS: usize = 3_072;
/// Preprocessing identity; changing the tokenizer/input shape requires a bump.
pub const PREPROCESSING: &str = "utf8-v1";

/// Sanitized, persistent provider identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderIdentity {
    endpoint_hash: String,
    pub model: String,
    pub generation: u32,
    pub dimensions: usize,
    pub preprocessing: &'static str,
}

impl ProviderIdentity {
    /// Build an identity from configuration. The endpoint is hashed, never
    /// stored raw, so credentials cannot leak through identity strings.
    pub fn new(
        endpoint: &str,
        model: &str,
        generation: u32,
        dimensions: usize,
    ) -> Result<Self, ProviderError> {
        if model.trim().is_empty() {
            return Err(ProviderError::Config(
                "embedding model is required".to_string(),
            ));
        }
        if dimensions == 0 || dimensions > MAX_DIMENSIONS {
            return Err(ProviderError::Config(format!(
                "dimensions must be 1-{MAX_DIMENSIONS}"
            )));
        }
        let parsed = url::Url::parse(endpoint)
            .map_err(|_| ProviderError::Config("endpoint must be an absolute URL".to_string()))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(ProviderError::Config(
                "endpoint must be http or https".to_string(),
            ));
        }
        if parsed.host_str().is_none() {
            return Err(ProviderError::Config("endpoint needs a host".to_string()));
        }
        let mut sanitized = format!(
            "{}://{}",
            parsed.scheme(),
            parsed.host_str().unwrap_or_default().to_lowercase()
        );
        if let Some(port) = parsed.port() {
            sanitized.push_str(&format!(":{port}"));
        }
        sanitized.push_str(parsed.path().trim_end_matches('/'));
        let digest = format!("{:x}", Sha256::digest(sanitized.as_bytes()));
        Ok(Self {
            endpoint_hash: digest[..16].to_string(),
            model: model.trim().to_string(),
            generation,
            dimensions,
            preprocessing: PREPROCESSING,
        })
    }

    /// Stable identity string persisted beside vectors and intents.
    pub fn slug(&self) -> String {
        format!(
            "{}:{}:g{}:d{}:{}",
            self.endpoint_hash, self.model, self.generation, self.dimensions, self.preprocessing
        )
    }

    /// Short human-readable identity for Status (no endpoint material).
    pub fn display(&self) -> String {
        format!("{}#{}", self.model, self.endpoint_hash)
    }
}

/// Categorized provider failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderError {
    Config(String),
    Transient(String),
    Auth(String),
    ModelInvalid(String),
    Malformed(String),
    Dimensions(String),
    TooLarge,
}

impl ProviderError {
    pub fn category(&self) -> &'static str {
        match self {
            Self::Config(_) => "PROVIDER_CONFIG",
            Self::Transient(_) => "PROVIDER_OFFLINE",
            Self::Auth(_) => "PROVIDER_AUTH",
            Self::ModelInvalid(_) => "PROVIDER_MODEL_INVALID",
            Self::Malformed(_) => "PROVIDER_INVALID",
            Self::Dimensions(_) => "PROVIDER_DIMENSIONS",
            Self::TooLarge => "PROVIDER_INVALID",
        }
    }

    /// Only connection-level failures are retried automatically.
    pub fn retryable(&self) -> bool {
        matches!(self, Self::Transient(_))
    }
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            Self::Config(message)
            | Self::Transient(message)
            | Self::Auth(message)
            | Self::ModelInvalid(message)
            | Self::Malformed(message)
            | Self::Dimensions(message) => message.as_str(),
            Self::TooLarge => "provider response exceeded the size cap",
        };
        write!(formatter, "{}: {message}", self.category())
    }
}

impl std::error::Error for ProviderError {}

#[derive(Debug, Deserialize)]
struct EmbeddingResponse {
    data: Vec<EmbeddingDatum>,
}

#[derive(Debug, Deserialize)]
struct EmbeddingDatum {
    embedding: Vec<f64>,
    index: usize,
}

/// OpenAI-compatible embeddings provider.
#[derive(Debug, Clone)]
pub struct EmbeddingProvider {
    identity: ProviderIdentity,
    endpoint: url::Url,
    timeout: Duration,
}

impl EmbeddingProvider {
    pub fn new(
        identity: ProviderIdentity,
        endpoint: &str,
        timeout: Duration,
    ) -> Result<Self, ProviderError> {
        let endpoint = url::Url::parse(endpoint)
            .map_err(|_| ProviderError::Config("invalid endpoint URL".to_string()))?;
        Ok(Self {
            identity,
            endpoint,
            timeout,
        })
    }

    pub fn identity(&self) -> &ProviderIdentity {
        &self.identity
    }

    /// Whether the provider is a loopback endpoint. Remote endpoints require
    /// an explicit opt-in before any text is submitted.
    pub fn is_loopback(&self) -> bool {
        matches!(
            self.endpoint.host_str().unwrap_or_default(),
            "127.0.0.1" | "::1" | "localhost" | "[::1]"
        )
    }

    fn request_path(&self) -> String {
        let path = self.endpoint.path().trim_end_matches('/');
        format!("{path}/embeddings")
    }

    fn request_uri(&self) -> String {
        let host = self.endpoint.host_str().unwrap_or("127.0.0.1");
        match self.endpoint.port() {
            Some(port) => format!("http://{host}:{port}{}", self.request_path()),
            None => format!("http://{host}{}", self.request_path()),
        }
    }

    /// Embed a batch of inputs, validating every response field.
    pub async fn embed(&self, inputs: &[String]) -> Result<Vec<Vec<f32>>, ProviderError> {
        if inputs.is_empty() {
            return Ok(Vec::new());
        }
        let body = serde_json::to_vec(&serde_json::json!({
            "model": self.identity.model,
            "input": inputs,
            "encoding_format": "float",
        }))
        .map_err(|error| ProviderError::Malformed(error.to_string()))?;
        let request = Request::builder()
            .method("POST")
            .uri(self.request_uri())
            .header(
                hyper::header::HOST,
                self.endpoint.host_str().unwrap_or("127.0.0.1"),
            )
            .header(hyper::header::CONTENT_TYPE, "application/json")
            .body(Full::new(Bytes::from(body)))
            .map_err(|error| ProviderError::Malformed(error.to_string()))?;
        let work = async {
            let host = self.endpoint.host_str().unwrap_or("127.0.0.1");
            let port = self.endpoint.port_or_known_default().unwrap_or(80);
            let stream = TcpStream::connect((host, port))
                .await
                .map_err(|error| ProviderError::Transient(error.to_string()))?;
            let (mut sender, connection) =
                hyper::client::conn::http1::handshake(TokioIo::new(stream))
                    .await
                    .map_err(|error| ProviderError::Transient(error.to_string()))?;
            tokio::spawn(async move {
                let _ = connection.await;
            });
            let response = sender
                .send_request(request)
                .await
                .map_err(|error| ProviderError::Transient(error.to_string()))?;
            let status = response.status();
            let collected = Limited::new(response.into_body(), MAX_RESPONSE_BYTES)
                .collect()
                .await
                .map_err(|_| ProviderError::TooLarge)?;
            let bytes = collected.to_bytes();
            classify_status(status.as_u16(), &bytes)?;
            let parsed: EmbeddingResponse = serde_json::from_slice(&bytes)
                .map_err(|error| ProviderError::Malformed(format!("response JSON: {error}")))?;
            validate_batch(&parsed, inputs.len(), self.identity.dimensions)
        };
        tokio::time::timeout(self.timeout, work)
            .await
            .map_err(|_| ProviderError::Transient("provider request timed out".to_string()))?
    }
}

fn classify_status(status: u16, body: &[u8]) -> Result<(), ProviderError> {
    if (200..300).contains(&status) {
        return Ok(());
    }
    let text = String::from_utf8_lossy(body).to_lowercase();
    match status {
        401 | 403 => Err(ProviderError::Auth(format!("provider returned {status}"))),
        404 => Err(ProviderError::ModelInvalid(format!(
            "provider endpoint or model not found ({status})"
        ))),
        429 => Err(ProviderError::Transient(
            "provider rate limited".to_string(),
        )),
        status if status >= 500 => Err(ProviderError::Transient(format!(
            "provider returned {status}"
        ))),
        400 if text.contains("model") => Err(ProviderError::ModelInvalid(
            "provider rejected the model".to_string(),
        )),
        _ => Err(ProviderError::Malformed(format!(
            "provider returned {status}: {}",
            text.chars().take(160).collect::<String>()
        ))),
    }
}

fn validate_batch(
    response: &EmbeddingResponse,
    expected_count: usize,
    dimensions: usize,
) -> Result<Vec<Vec<f32>>, ProviderError> {
    if response.data.len() != expected_count {
        return Err(ProviderError::Malformed(format!(
            "expected {expected_count} embeddings, received {}",
            response.data.len()
        )));
    }
    let mut slots: Vec<Option<&EmbeddingDatum>> = vec![None; expected_count];
    for datum in &response.data {
        if datum.index >= expected_count {
            return Err(ProviderError::Malformed(format!(
                "embedding index {} is out of range",
                datum.index
            )));
        }
        if slots[datum.index].is_some() {
            return Err(ProviderError::Malformed(format!(
                "duplicate embedding index {}",
                datum.index
            )));
        }
        slots[datum.index] = Some(datum);
    }
    let mut vectors = Vec::with_capacity(expected_count);
    for (position, slot) in slots.into_iter().enumerate() {
        let datum = slot.ok_or_else(|| {
            ProviderError::Malformed(format!("missing embedding index {position}"))
        })?;
        if datum.embedding.len() != dimensions {
            return Err(ProviderError::Dimensions(format!(
                "expected {dimensions} dimensions, received {}",
                datum.embedding.len()
            )));
        }
        let mut vector = Vec::with_capacity(dimensions);
        let mut squared_norm = 0.0f64;
        for value in &datum.embedding {
            if !value.is_finite() {
                return Err(ProviderError::Malformed(
                    "embedding contains a non-finite value".to_string(),
                ));
            }
            squared_norm += value * value;
            let narrowed = *value as f32;
            if !narrowed.is_finite() {
                return Err(ProviderError::Malformed(
                    "embedding value overflows float32".to_string(),
                ));
            }
            vector.push(narrowed);
        }
        if squared_norm <= 0.0 || !squared_norm.is_finite() {
            return Err(ProviderError::Malformed(
                "embedding has a zero or non-finite norm".to_string(),
            ));
        }
        vectors.push(vector);
    }
    Ok(vectors)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn serve(body: String, status: u16) -> (String, tokio::task::JoinHandle<()>) {
        serve_delayed(body, status, Duration::ZERO).await
    }

    async fn serve_delayed(
        body: String,
        status: u16,
        delay: Duration,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let address = listener.local_addr().expect("addr");
        let handle = tokio::spawn(async move {
            if let Ok((mut stream, _)) = listener.accept().await {
                let mut buffer = vec![0u8; 65_536];
                let _ = stream.read(&mut buffer).await;
                if !delay.is_zero() {
                    tokio::time::sleep(delay).await;
                }
                let response = format!(
                    "HTTP/1.1 {status} OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.shutdown().await;
            }
        });
        (format!("http://127.0.0.1:{}/v1", address.port()), handle)
    }

    fn provider(endpoint: &str) -> EmbeddingProvider {
        let identity = ProviderIdentity::new(endpoint, "test-model", 1, 3).expect("identity");
        EmbeddingProvider::new(identity, endpoint, Duration::from_secs(5)).expect("provider")
    }

    fn inputs() -> Vec<String> {
        vec!["alpha".to_string(), "beta".to_string()]
    }

    #[tokio::test]
    async fn maps_reordered_indices_back_to_inputs() {
        let (endpoint, _) = serve(
            r#"{"data":[{"index":1,"embedding":[0,1,0]},{"index":0,"embedding":[1,0,0]}]}"#
                .to_string(),
            200,
        )
        .await;
        let vectors = provider(&endpoint).embed(&inputs()).await.expect("embed");
        assert_eq!(vectors[0], vec![1.0, 0.0, 0.0]);
        assert_eq!(vectors[1], vec![0.0, 1.0, 0.0]);
    }

    #[tokio::test]
    async fn rejects_missing_duplicate_and_out_of_range_indices() {
        for body in [
            r#"{"data":[{"index":0,"embedding":[1,0,0]}]}"#,
            r#"{"data":[{"index":0,"embedding":[1,0,0]},{"index":0,"embedding":[0,1,0]}]}"#,
            r#"{"data":[{"index":2,"embedding":[1,0,0]},{"index":0,"embedding":[0,1,0]}]}"#,
        ] {
            let (endpoint, _) = serve(body.to_string(), 200).await;
            let error = provider(&endpoint)
                .embed(&inputs())
                .await
                .expect_err("rejected");
            assert!(matches!(error, ProviderError::Malformed(_)), "{error}");
        }
    }

    #[tokio::test]
    async fn rejects_wrong_dimensions_nonfinite_and_zero_norm() {
        let cases = [
            (
                r#"{"data":[{"index":0,"embedding":[1,0]},{"index":1,"embedding":[0,1,0]}]}"#,
                "PROVIDER_DIMENSIONS",
            ),
            (
                r#"{"data":[{"index":0,"embedding":[1e999,0,0]},{"index":1,"embedding":[0,1,0]}]}"#,
                "PROVIDER_INVALID",
            ),
            (
                r#"{"data":[{"index":0,"embedding":[0,0,0]},{"index":1,"embedding":[0,1,0]}]}"#,
                "PROVIDER_INVALID",
            ),
        ];
        for (body, category) in cases {
            let (endpoint, _) = serve(body.to_string(), 200).await;
            let error = provider(&endpoint)
                .embed(&inputs())
                .await
                .expect_err("rejected");
            assert_eq!(error.category(), category, "{error}");
        }
    }

    #[tokio::test]
    async fn classifies_http_failures() {
        for (status, category) in [
            (401, "PROVIDER_AUTH"),
            (429, "PROVIDER_OFFLINE"),
            (500, "PROVIDER_OFFLINE"),
        ] {
            let (endpoint, _) = serve(r#"{"error":"nope"}"#.to_string(), status).await;
            let error = provider(&endpoint)
                .embed(&inputs())
                .await
                .expect_err("rejected");
            assert_eq!(error.category(), category, "{error}");
            assert_eq!(error.retryable(), status == 429 || status >= 500);
        }
        let (endpoint, _) = serve(r#"{"error":"model not found"}"#.to_string(), 404).await;
        let error = provider(&endpoint)
            .embed(&inputs())
            .await
            .expect_err("rejected");
        assert_eq!(error.category(), "PROVIDER_MODEL_INVALID");
    }

    #[tokio::test]
    async fn classifies_timeouts_as_transient() {
        let (endpoint, _) = serve_delayed(
            r#"{"data":[]}"#.to_string(),
            200,
            Duration::from_millis(300),
        )
        .await;
        let identity = ProviderIdentity::new(&endpoint, "test-model", 1, 3).expect("identity");
        let provider = EmbeddingProvider::new(identity, &endpoint, Duration::from_millis(50))
            .expect("provider");
        let error = provider.embed(&inputs()).await.expect_err("timeout");
        assert_eq!(error.category(), "PROVIDER_OFFLINE");
    }

    #[test]
    fn identity_hashes_the_endpoint_and_rejects_bad_config() {
        let identity = ProviderIdentity::new("http://user:secret@127.0.0.1:12434/v1", "m", 2, 768)
            .expect("identity");
        assert!(!identity.slug().contains("secret"));
        assert!(identity.slug().contains(":m:g2:d768:"));
        assert!(ProviderIdentity::new("http://127.0.0.1:1/v1", "", 1, 3).is_err());
        assert!(ProviderIdentity::new("http://127.0.0.1:1/v1", "m", 1, 0).is_err());
        assert!(ProviderIdentity::new("ftp://127.0.0.1/v1", "m", 1, 3).is_err());
    }
}
