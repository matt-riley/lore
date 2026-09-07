import { normalizeText } from "../utils/text-normalizer.mjs";

export function splitSentences(value) {
  const sentences = [];
  let current = "";
  let quote = null;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    current += character;
    if (character === "`" || (character === "'" && (quote === "'" || !/[a-z0-9]/i.test(text[index - 1] ?? "")))) {
      quote = quote === character ? null : (quote ?? character);
    } else if (character === '"') {
      quote = quote === '"' ? null : (quote ?? '"');
    } else if (character === "“") {
      quote = "”";
    } else if (character === "”" && quote === "”") {
      quote = null;
    } else if (character === "‘") {
      quote = "’";
    } else if (character === "’" && quote === "’") {
      quote = null;
    }
    if (!quote && /["”’\x27`]/.test(character) && /[.!?;]/.test(text[index - 1] ?? "")
      && (index === text.length - 1 || /\s/.test(text[index + 1]))) {
      const sentence = normalizeText(current);
      if (sentence) {
        sentences.push(sentence);
      }
      current = "";
      continue;
    }
    if (!quote && /[.!?;]/.test(character) && (index === text.length - 1 || /\s/.test(text[index + 1]))) {
      const sentence = normalizeText(current);
      if (sentence) {
        sentences.push(sentence);
      }
      current = "";
    }
  }
  const remainder = normalizeText(current);
  if (remainder) {
    sentences.push(remainder);
  }
  return sentences;
}

export function splitDirectiveClauses(sentence) {
  return sentence
    .split(/\s+(?:and|but)\s+(?=(?:never|do\s+not|don't|avoid|please)\b)|\s+so\s+(?=please\s+(?:use|prefer|keep|include)\b)/i)
    .map((clause) => clause.replace(/;+$/, "").trim())
    .filter(Boolean);
}

function isQuotedSentence(text) {
  return /["“”‘`]|(?:^|[\s:(])'/.test(text);
}

export function isNonDirectiveSentence(text) {
  return !text
    || text.endsWith("?")
    || isQuotedSentence(text)
    || /^(?:if|unless|when|suppose|imagine|assuming|should we|could we|would you|could you|can you|what if)\b/i.test(text)
    || /\b(?:don't|do not|never|not)\s+(?:really\s+)?prefer\b/i.test(text)
    || /\bprefer\s+not\s+to\b/i.test(text)
    || /\bi\s+meant\s+to\s+(?:ask|know|understand)\b/i.test(text)
    || /\b(?:would|could|might|may)\s+(?:prefer|use|choose|avoid)\b/i.test(text);
}

const EXPLICIT_SCOPE_PREAMBLE_PATTERN = /^(?:(?:for|in)\s+(?:this|the current)(?:\s+[a-z][a-z0-9_-]*){0,2}\s+(?:repo(?:sitory)?|project|app)|for\s+[a-z][a-z0-9_-]*(?:\s+[a-z][a-z0-9_-]*){0,4}|(?:across|in|for)\s+all\s+(?:of\s+)?(?:my\s+)?(?:projects|repositories|repos)|make\s+(?:this\s+)?rule\s+global\s+across\s+(?:all\s+)?(?:projects|repositories|repos)|globally)\s*(?:,|:)\s*/i;

export function directiveBody(text) {
  return String(text || "")
    .replace(EXPLICIT_SCOPE_PREAMBLE_PATTERN, "")
    .replace(/^(?:as\s+(?:a\s+)?policy|in\s+(?:the\s+)?future|going\s+forward|from\s+now\s+on)\s*(?:,|:)\s*/i, "")
    .replace(/^actually\s*,?\s*(?:that(?:'s| is)\s+wrong\s*:\s*)/i, "");
}

export function isConditionalDirectiveSentence(text) {
  return /\b(?:if|unless|when)\b/i.test(text);
}

// A topic (payments, failures, logging) does not make a request temporary.
// Explicit duration wins; otherwise distinguish a particular incident artifact
// from a standing rule about a class of work.
export function isOneOffDirectiveRequest(text) {
  const body = directiveBody(text);
  const scopedText = text.replace(EXPLICIT_SCOPE_PREAMBLE_PATTERN, "");
  if (/\b(?:just\s+this\s+once|this\s+time|for\s+(?:now|today)|(?:for|during)\s+this\s+(?:incident|run|request|attempt|reproduction|session|task)|(?:right\s+)?now|today)\b/i.test(body)
    || /^(?:for|during)\s+this\s+(?:incident|run|request|attempt|reproduction|session|task)\b/i.test(text)) {
    return true;
  }
  if (/^(?:as\s+(?:a\s+)?policy|in\s+(?:the\s+)?future|going\s+forward|from\s+now\s+on)\b/i.test(scopedText)
    || /^(?:please\s+)?(?:(?:i|we)\s+)?(?:always|never|prefer)\b/i.test(body)
    || /^(?:i|we)\s+(?:really\s+)?prefer\b|^my\s+preference\s+is\b|^remember\b/i.test(body)
    || /\b(?:each|every)\s+[a-z]|\b(?:all|future)\s+(?:requests|responses|reports|incidents|mutations|reviews|commits|runs|projects)\b/i.test(body)) {
    return false;
  }
  return /\b(?:a|an|this|that|the)\s+(?:[a-z-]+\s+){0,2}(?:attachment|report|reproduction|request|response|incident|issue)\b(?=\s+(?:to|for|in|into|from|open|closed|updated|and|but)\b|[.,;]|$)/i.test(body)
    || /\b(?:this|that|the)\s+(?:(?:currently|failing|failed|captured|broken|payment|bug)\s+){1,3}(?:request|response|endpoint|logs?|report|issue|reproduction)\b/i.test(body)
    || /\b(?:this|that|the)\s+(?:bug|incident|issue|reproduction)\b/i.test(body)
    || /^(?:please\s+)?(?:run|check|inspect|reproduce|attach|report)\b/i.test(body);
}
