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
  { reason: "private_key_block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { reason: "aws_access_key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { reason: "openai_key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { reason: "anthropic_key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { reason: "github_token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { reason: "slack_token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { reason: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { reason: "typesafe_key", pattern: /\bapikey_[A-Za-z0-9]{16,}\b/ },
  { reason: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { reason: "bearer_token", pattern: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/i },
  {
    reason: "secret_assignment",
    pattern: /(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9!@#$%^&*_+=/-]{16,}/i,
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
