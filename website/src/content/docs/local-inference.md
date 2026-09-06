---
title: "Local inference"
description: "Optionally connect Lore to a loopback OpenAI-compatible model server."
section: "Understand Lore"
order: 5
---

Local inference is optional and disabled by default. When enabled, Lore sends bounded evidence to an OpenAI-compatible server on the same machine. It accepts loopback hosts only: `127.0.0.1`, `localhost`, or `::1`.

## Provider requirements

The server must provide `/v1/chat/completions`. `/v1/embeddings` is optional and is needed for semantic vector search. Lore rejects embedded credentials and non-loopback URLs. There is no built-in authentication setting.

## Enable a chat model

Add a provider and model to `~/.copilot/lore.json`:

```json
{
  "localInference": {
    "enabled": true,
    "baseUrl": "http://127.0.0.1:12434/v1",
    "model": "local-chat-model",
    "timeoutMs": 30000,
    "reflection": { "enabledByDefault": false },
    "queryExpansion": { "enabled": false, "maxTerms": 8 },
    "contextCompression": { "enabled": false, "minInputTokens": 900, "targetTokens": 700, "maxSections": 8 }
  }
}
```

Reflection remains opt-in even when the provider is enabled. An explicit `useLocalInference` value on a `lore_reflect` call overrides the configured reflection default.

## Embeddings

Semantic search is separately enabled under `localInference.embeddings`:

```json
{
  "localInference": {
    "enabled": true,
    "model": "local-chat-model",
    "embeddings": {
      "enabled": true,
      "model": "local-embedding-model",
      "maxInputs": 24,
      "topK": 6,
      "minSimilarity": 0.2,
      "groundingMinSimilarity": 0.35
    }
  }
}
```

Vectors are cached in the local `memory_embedding` table. The candidate pool and evidence sent to the model are bounded. Embedding failures fall back to lexical retrieval.

## Optional consumers

Query expansion changes retrieval terms only and retries deterministic retrieval if expansion produces no evidence. Context compression is default-off and preserves required sections, source indexes, and the deterministic capsule on failure. Deferred extraction needs both `localInference.enabled` and `deferredExtraction.useLocalInference`.

## Failure and privacy behavior

Timeouts, malformed output, missing citations, weak grounding, or an unavailable server do not discard deterministic retrieval, extraction, capsule, or reflection results. Memory content and query text go only to the configured loopback endpoint when a feature explicitly uses inference. Lore makes no cloud call for this feature.

Treat the local model server as trusted local software: it can see the bounded evidence Lore sends it. See [Privacy](/guides/privacy/).
