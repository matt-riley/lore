/**
 * Local sensitivity detection for memory content.
 *
 * TypeSafe features send memory content to a third party. A sensitivity
 * judgment cannot come from that same provider — asking it whether the payload
 * is too sensitive means sending the payload first — so detection is
 * deterministic and local. High precision beats coverage here: a false
 * positive only means one memory is not reranked, while a false negative
 * leaks a credential.
 */

const RULES = Object.freeze([
  { reason: "private_key_block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/ },
  { reason: "aws_access_key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { reason: "openai_key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { reason: "anthropic_key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { reason: "stripe_key", pattern: /\b[sr]k_live_[A-Za-z0-9]{16,}\b/ },
  { reason: "gitlab_token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { reason: "npm_token", pattern: /\bnpm_[A-Za-z0-9]{20,}\b/ },
  { reason: "pypi_token", pattern: /\bpypi-[A-Za-z0-9_-]{20,}\b/ },
  { reason: "github_token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { reason: "slack_token", pattern: /\b(?:xox[baprs]|xoxc|xoxd|xapp)-[A-Za-z0-9-]{10,}\b/ },
  { reason: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { reason: "typesafe_key", pattern: /\bapikey_[A-Za-z0-9]{16,}\b/ },
  { reason: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { reason: "bearer_token", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/i },
  { reason: "basic_auth", pattern: /\b(?:Authorization\s*:\s*)?Basic\s+[A-Za-z0-9+/=]{20,}/i },
  { reason: "azure_account_key", pattern: /\bAccountKey\s*=\s*[A-Za-z0-9+/=]{20,}/i },
  { reason: "connection_string", pattern: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|rediss?|amqp|https?):\/\/[^\s:@/]+:[^\s@/]+@/i },
  {
    reason: "secret_assignment",
    // Quoted keys (`"api_key": "…"`), compound names (`AWS_SECRET_ACCESS_KEY=…`,
    // `private_key=…`) and values containing punctuation are the shapes real
    // configs use. The value class is broad on purpose: this is a withhold-only
    // gate, and over-matching costs one un-reranked memory while under-matching
    // leaks a credential into a prompt.
    pattern: /(?:pass(?:word|wd|phrase)|secret|token|api[_-]?key|[a-z0-9_-]*key)[\w-]*["']?\s*[:=]\s*["']?[^\s"',;]{16,}/i,
  },
]);

/**
 * @param {unknown} value candidate memory content
 * @returns {{ sensitive: boolean, reason: string|null }}
 */
export function detectSensitiveContent(value) {
  const text = String(value ?? "");
  if (!text) {
    return { sensitive: false, reason: null };
  }
  for (const rule of RULES) {
    if (rule.pattern.test(text)) {
      return { sensitive: true, reason: rule.reason };
    }
  }
  return { sensitive: false, reason: null };
}

/** Convenience wrapper for callers that only need the boolean. */
export function isSensitiveMemoryContent(value) {
  return detectSensitiveContent(value).sensitive;
}

/**
 * Replace credential-shaped spans with a marker.
 *
 * This is the prompt-side half of the same gate. Keeping a secret away from
 * TypeSafe is not enough when the rendered context is handed to whichever model
 * runs the session, so recall redacts before assembly returns. The stored
 * memory is untouched: redaction is a rendering decision, not a deletion.
 */
export function redactSensitiveContent(value) {
  let text = String(value ?? "");
  if (!text) {
    return text;
  }
  for (const rule of RULES) {
    const global = new RegExp(rule.pattern.source, `${rule.pattern.flags}g`);
    text = text.replace(global, "[redacted]");
  }
  return text;
}
