//! Query embedding: bounded inference, exact-key in-memory cache and bounded
//! coalescing. No query text or vector is ever persisted.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use lore_provider::EmbeddingProvider;
use sha2::{Digest, Sha256};
use tokio::sync::{Semaphore, watch};

/// Query-provider concurrency slots (configuration-storage: 2).
pub const QUERY_SLOTS: usize = 2;
/// Bounded coalesced waiters per active key.
pub const MAX_COALESCED_WAITERS: usize = 8;
/// Inference allowance ceiling inside a recall.
pub const INFERENCE_ALLOWANCE_MS: u64 = 100;
/// Final-snapshot work reserve excluded from the inference allowance.
pub const FINAL_RESERVE_MS: u64 = 30;
const CACHE_MAX_ENTRIES: usize = 1_000;
const CACHE_MAX_BYTES: usize = 16 * 1024 * 1024;
const CACHE_TTL_MS: i64 = 24 * 60 * 60 * 1_000;

struct CacheEntry {
    vector: Vec<f32>,
    created_ms: i64,
    bytes: usize,
}

#[derive(Default)]
struct Cache {
    entries: HashMap<String, CacheEntry>,
    order: VecDeque<String>,
    bytes: usize,
}

#[derive(Clone)]
struct Slot {
    sender: watch::Sender<Option<String>>,
    receiver: watch::Receiver<Option<String>>,
    waiters: Arc<AtomicUsize>,
}

/// Result of one query-vector lookup.
pub struct QueryOutcome {
    pub vector: Option<Vec<f32>>,
    pub cache: &'static str,
    pub fallback: Option<String>,
}

/// Query-path runtime shared by routes and the background worker.
pub struct Semantics {
    provider: Mutex<Option<Arc<EmbeddingProvider>>>,
    identity: Mutex<Option<String>>,
    min_similarity: Mutex<f64>,
    cache: Mutex<Cache>,
    slots: Semaphore,
    inflight: Mutex<HashMap<String, Slot>>,
}

impl Semantics {
    pub fn new(
        provider: Option<Arc<EmbeddingProvider>>,
        identity: Option<String>,
        min_similarity: f64,
    ) -> Self {
        Self {
            provider: Mutex::new(provider),
            identity: Mutex::new(identity),
            min_similarity: Mutex::new(min_similarity),
            cache: Mutex::new(Cache::default()),
            slots: Semaphore::new(QUERY_SLOTS),
            inflight: Mutex::new(HashMap::new()),
        }
    }

    pub fn provider(&self) -> Option<Arc<EmbeddingProvider>> {
        self.provider.lock().expect("provider").clone()
    }

    pub fn identity(&self) -> Option<String> {
        self.identity.lock().expect("identity").clone()
    }

    pub fn min_similarity(&self) -> f64 {
        *self.min_similarity.lock().expect("similarity")
    }

    /// Swap the provider after a validated configuration reload.
    pub fn replace(
        &self,
        provider: Option<Arc<EmbeddingProvider>>,
        identity: Option<String>,
        min_similarity: f64,
    ) {
        *self.provider.lock().expect("provider") = provider;
        *self.identity.lock().expect("identity") = identity;
        *self.min_similarity.lock().expect("similarity") = min_similarity;
        self.cache.lock().expect("cache").entries.clear();
        self.cache.lock().expect("cache").order.clear();
        self.cache.lock().expect("cache").bytes = 0;
    }

    /// Exact cache key: query bytes, repository, cross-repository consent and
    /// complete model identity.
    pub fn cache_key(&self, query: &str, repository: Option<&str>, include_other: bool) -> String {
        let identity = self.identity().unwrap_or_default();
        let mut hasher = Sha256::new();
        hasher.update(identity.as_bytes());
        hasher.update([0]);
        hasher.update(repository.unwrap_or("").as_bytes());
        hasher.update([u8::from(include_other)]);
        hasher.update(query.as_bytes());
        format!("{:x}", hasher.finalize())
    }

    /// Inference allowance from the remaining request budget.
    pub fn allowance_ms(remaining_ms: u64) -> u64 {
        remaining_ms
            .saturating_sub(FINAL_RESERVE_MS)
            .min(INFERENCE_ALLOWANCE_MS)
    }

    /// Look up, coalesce or infer one query vector within `budget_ms`.
    pub async fn query_vector(&self, key: &str, query: &str, budget_ms: u64) -> QueryOutcome {
        if budget_ms == 0 {
            return QueryOutcome {
                vector: None,
                cache: "miss",
                fallback: Some("QUERY_BUDGET".to_string()),
            };
        }
        if let Some(vector) = self.cache_get(key) {
            return QueryOutcome {
                vector: Some(vector),
                cache: "hit",
                fallback: None,
            };
        }

        let existing = {
            let mut inflight = self.inflight.lock().expect("inflight");
            match inflight.get(key) {
                Some(slot) => {
                    let current = slot.waiters.fetch_add(1, Ordering::AcqRel) + 1;
                    if current > MAX_COALESCED_WAITERS {
                        slot.waiters.fetch_sub(1, Ordering::AcqRel);
                        return QueryOutcome {
                            vector: None,
                            cache: "miss",
                            fallback: Some("QUERY_CAPACITY".to_string()),
                        };
                    }
                    Some(slot.clone())
                }
                None => {
                    let (sender, receiver) = watch::channel(None);
                    let slot = Slot {
                        sender,
                        receiver,
                        waiters: Arc::new(AtomicUsize::new(1)),
                    };
                    inflight.insert(key.to_string(), slot.clone());
                    None
                }
            }
        };

        match existing {
            Some(slot) => {
                let mut receiver = slot.receiver;
                let changed = tokio::time::timeout(
                    Duration::from_millis(budget_ms.max(1)),
                    receiver.changed(),
                )
                .await;
                slot.waiters.fetch_sub(1, Ordering::AcqRel);
                if changed.is_err() {
                    return QueryOutcome {
                        vector: None,
                        cache: "miss",
                        fallback: Some("QUERY_TIMEOUT".to_string()),
                    };
                }
                if let Some(vector) = self.cache_get(key) {
                    QueryOutcome {
                        vector: Some(vector),
                        cache: "hit",
                        fallback: None,
                    }
                } else {
                    QueryOutcome {
                        vector: None,
                        cache: "miss",
                        fallback: Some(
                            receiver
                                .borrow()
                                .clone()
                                .unwrap_or_else(|| "QUERY_TIMEOUT".to_string()),
                        ),
                    }
                }
            }
            None => {
                let (vector, fallback) = self.infer(query, budget_ms).await;
                if let Some(vector) = &vector {
                    self.cache_put(key, vector.clone());
                }
                if let Some(slot) = self.inflight.lock().expect("inflight").remove(key) {
                    let _ = slot.sender.send(fallback.clone());
                }
                QueryOutcome {
                    vector,
                    cache: "miss",
                    fallback,
                }
            }
        }
    }

    async fn infer(&self, query: &str, budget_ms: u64) -> (Option<Vec<f32>>, Option<String>) {
        let Some(provider) = self.provider() else {
            return (None, Some("DISABLED".to_string()));
        };
        let Ok(_permit) = self.slots.try_acquire() else {
            return (None, Some("QUERY_CAPACITY".to_string()));
        };
        let input = [query.to_string()];
        let outcome = tokio::time::timeout(
            Duration::from_millis(budget_ms.max(1)),
            provider.embed(&input),
        )
        .await;
        match outcome {
            Err(_) => (None, Some("QUERY_TIMEOUT".to_string())),
            Ok(Err(error)) => (None, Some(error.category().to_string())),
            Ok(Ok(mut vectors)) => match vectors.pop() {
                Some(vector) => (Some(vector), None),
                None => (None, Some("PROVIDER_INVALID".to_string())),
            },
        }
    }

    fn cache_get(&self, key: &str) -> Option<Vec<f32>> {
        let now = now_ms();
        let mut cache = self.cache.lock().expect("cache");
        let (vector, created_ms) = {
            let entry = cache.entries.get(key)?;
            (entry.vector.clone(), entry.created_ms)
        };
        if now - created_ms > CACHE_TTL_MS {
            let entry = cache.entries.remove(key).expect("entry");
            cache.order.retain(|existing| existing != key);
            cache.bytes = cache.bytes.saturating_sub(entry.bytes);
            return None;
        }
        cache.order.retain(|existing| existing != key);
        cache.order.push_back(key.to_string());
        Some(vector)
    }

    fn cache_put(&self, key: &str, vector: Vec<f32>) {
        let bytes = vector.len() * 4 + key.len();
        let mut cache = self.cache.lock().expect("cache");
        if let Some(previous) = cache.entries.remove(key) {
            cache.bytes = cache.bytes.saturating_sub(previous.bytes);
        }
        cache.order.retain(|existing| existing != key);
        cache.order.push_back(key.to_string());
        cache.entries.insert(
            key.to_string(),
            CacheEntry {
                vector,
                created_ms: now_ms(),
                bytes,
            },
        );
        cache.bytes += bytes;
        while cache.entries.len() > CACHE_MAX_ENTRIES || cache.bytes > CACHE_MAX_BYTES {
            let Some(oldest) = cache.order.pop_front() else {
                break;
            };
            if let Some(entry) = cache.entries.remove(&oldest) {
                cache.bytes = cache.bytes.saturating_sub(entry.bytes);
            }
        }
    }

    /// Number of cached query vectors (diagnostics and tests).
    #[allow(dead_code)]
    pub fn cache_len(&self) -> usize {
        self.cache.lock().expect("cache").entries.len()
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowance_reserves_final_work_and_caps_at_100ms() {
        assert_eq!(Semantics::allowance_ms(200), 100);
        assert_eq!(Semantics::allowance_ms(130), 100);
        assert_eq!(Semantics::allowance_ms(100), 70);
        assert_eq!(Semantics::allowance_ms(30), 0);
        assert_eq!(Semantics::allowance_ms(10), 0);
    }

    #[test]
    fn cache_key_covers_query_repository_consent_and_identity() {
        let semantics = Semantics::new(None, Some("model-a".to_string()), 0.5);
        let base = semantics.cache_key("query", None, false);
        assert_eq!(base, semantics.cache_key("query", None, false));
        assert_ne!(
            base,
            semantics.cache_key("query", Some("github.com/a/b"), false)
        );
        assert_ne!(base, semantics.cache_key("query", None, true));
        assert_ne!(base, semantics.cache_key("other", None, false));
    }

    #[test]
    fn cache_reports_size_and_missing_keys() {
        let semantics = Semantics::new(None, Some("model-a".to_string()), 0.5);
        semantics.cache_put("key-a", vec![1.0, 0.0]);
        semantics.cache_put("key-b", vec![0.0, 1.0]);
        assert_eq!(semantics.cache_len(), 2);
        assert!(semantics.cache_get("key-a").is_some());
        assert_eq!(semantics.cache_len(), 2);
        assert!(semantics.cache_get("missing").is_none());
    }
}
