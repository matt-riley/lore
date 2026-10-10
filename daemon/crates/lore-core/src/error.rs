//! Error type crossing the core boundary, already shaped for the wire.

use protocol::{code, reason};

/// Core error carrying the HTTP status and stable wire code/reason.
#[derive(Debug, Clone)]
pub struct CoreError {
    pub http: u16,
    pub code: String,
    pub reason: String,
    pub message: String,
    pub retryable: bool,
}

pub type CoreResult<T> = Result<T, CoreError>;

impl CoreError {
    pub fn new(
        http: u16,
        code: &str,
        reason: &str,
        message: impl Into<String>,
        retryable: bool,
    ) -> Self {
        Self {
            http,
            code: code.to_string(),
            reason: reason.to_string(),
            message: message.into(),
            retryable,
        }
    }

    pub fn invalid(reason: &str, message: impl Into<String>) -> Self {
        Self::new(400, code::INVALID_ARGUMENT, reason, message, false)
    }

    pub fn not_found(reason: &str, message: impl Into<String>) -> Self {
        Self::new(404, code::NOT_FOUND, reason, message, false)
    }

    pub fn conflict(reason: &str, message: impl Into<String>) -> Self {
        Self::new(409, code::ALREADY_EXISTS, reason, message, false)
    }

    pub fn precondition(reason: &str, message: impl Into<String>) -> Self {
        Self::new(412, code::FAILED_PRECONDITION, reason, message, false)
    }

    pub fn quota(reason: &str, message: impl Into<String>) -> Self {
        Self::new(429, code::RESOURCE_EXHAUSTED, reason, message, false)
    }

    pub fn deadline(message: impl Into<String>) -> Self {
        Self::new(
            504,
            code::DEADLINE_EXCEEDED,
            reason::REQUEST_DEADLINE,
            message,
            true,
        )
    }

    pub fn internal(reason: &str, message: impl Into<String>) -> Self {
        Self::new(500, code::INTERNAL, reason, message, false)
    }

    pub fn unavailable(reason: &str, message: impl Into<String>) -> Self {
        Self::new(503, code::UNAVAILABLE, reason, message, true)
    }
}

impl std::fmt::Display for CoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{}: {} ({})",
            self.code, self.message, self.reason
        )
    }
}

impl std::error::Error for CoreError {}

impl From<rusqlite::Error> for CoreError {
    fn from(error: rusqlite::Error) -> Self {
        CoreError::internal("IO_FAILURE", format!("sqlite error: {error}"))
    }
}

impl From<std::io::Error> for CoreError {
    fn from(error: std::io::Error) -> Self {
        CoreError::internal("IO_FAILURE", format!("io error: {error}"))
    }
}

impl From<serde_json::Error> for CoreError {
    fn from(error: serde_json::Error) -> Self {
        CoreError::internal("INTERNAL_FAILURE", format!("json error: {error}"))
    }
}
