//! Minimal G1 client for the v2 Unix-socket contract, shared by the `lore`
//! CLI and integration tests. Uses hyper's low-level HTTP/1 handshake over a
//! `UnixStream` because `fetch`-style clients do not speak Unix sockets.

use std::path::Path;

use anyhow::{Context, Result};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::Request;
use hyper_util::rt::TokioIo;
use tokio::net::UnixStream;

use protocol::{Envelope, HOST, RequestMeta, StatusParams};

/// Raw outcome of a status request, so callers can assert on both the HTTP
/// status and the protocol body.
#[derive(Debug, Clone)]
pub struct StatusOutcome {
    pub status_code: u16,
    pub body: String,
}

impl StatusOutcome {
    /// Whether the HTTP layer reported success.
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status_code)
    }

    /// Parsed JSON body, when it is valid JSON.
    pub fn json(&self) -> Option<serde_json::Value> {
        serde_json::from_str(&self.body).ok()
    }
}

/// Send one `POST /v2/status` request over the daemon socket.
pub async fn request_status(
    socket: &Path,
    meta: RequestMeta,
    params: StatusParams,
) -> Result<StatusOutcome> {
    let stream = UnixStream::connect(socket)
        .await
        .with_context(|| format!("connect {}", socket.display()))?;
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .context("http handshake")?;
    tokio::spawn(async move {
        let _ = connection.await;
    });

    let envelope = Envelope { meta, params };
    let body = serde_json::to_vec(&envelope).context("encode request")?;
    let request = Request::builder()
        .method("POST")
        .uri(format!("http://{HOST}/v2/status"))
        .header(hyper::header::HOST, HOST)
        .header(hyper::header::CONTENT_TYPE, "application/json")
        .body(Full::new(Bytes::from(body)))
        .context("build request")?;
    let response = sender.send_request(request).await.context("send request")?;
    let status_code = response.status().as_u16();
    let bytes = response
        .into_body()
        .collect()
        .await
        .context("read response")?
        .to_bytes();
    Ok(StatusOutcome {
        status_code,
        body: String::from_utf8_lossy(&bytes).into_owned(),
    })
}
