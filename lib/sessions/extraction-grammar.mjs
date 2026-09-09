import { normalizeText } from "../utils/text-normalizer.mjs";

export function splitSentences(value, { splitSemicolons = true } = {}) {
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
    if (!quote && (splitSemicolons ? /[.!?;]/ : /[.!?]/).test(character) && (index === text.length - 1 || /\s/.test(text[index + 1]))) {
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
    .split(/;\s*|\s+(?:and|but)\s+(?=(?:never|do\s+not|don't|avoid|please)\b)|\s+so\s+(?=please\s+(?:use|prefer|keep|include)\b)/i)
    .map((clause) => clause.replace(/;+$/, "").trim())
    .filter(Boolean);
}

function isQuotedSentence(text) {
  // Quoted terms and objects can be part of a direct instruction (for
  // example, `Always use "node test"`). A reported or wholly quoted phrase
  // remains non-directive evidence; fenced code is filtered by the caller.
  const reported = /\b(?:guide|example|report|runbook|source|document|prompt|message|user|assistant)\s+(?:says?|said|quotes?)\b|\b(?:example|guide)\s*:/i.test(text);
  if (reported) return true;

  const quotedSpans = [
    ...text.matchAll(/"([^"\n]*)"|“([^”\n]*)”|‘([^’\n]*)’|(?<![\p{L}\p{N}])'([^'\n]*)'/gu),
  ];
  const straightDoubleQuotes = (text.match(/"/g) ?? []).length;
  const straightSingleQuotes = (text.match(/(?<![\p{L}\p{N}])'|(?<=[\p{L}\p{N}])'(?![\p{L}\p{N}])/gu) ?? []).length;
  const curlySingleOpens = (text.match(/‘/g) ?? []).length;
  const curlySingleCloses = (text.match(/(?<![\p{L}\p{N}])’|(?<=[\p{L}\p{N}])’(?![\p{L}\p{N}])/gu) ?? []).length;
  if (straightDoubleQuotes % 2 !== 0 || straightSingleQuotes % 2 !== 0
    || (text.match(/“/g) ?? []).length !== (text.match(/”/g) ?? []).length
    || curlySingleOpens !== curlySingleCloses) {
    return true;
  }
  if (quotedSpans.length === 0) return /["“‘]|(?:^|[\s:(])'/.test(text);

  const trimmed = text.trim();
  const directive = directiveBody(trimmed).trim();
  if (/^(?:"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|'[^'\n]*')\s*[.!?]?$/u.test(trimmed)) return true;
  // A direct preference/imperative can quote a natural multiword object.
  // Without this lead, quoted phrases are conservatively treated as reports.
  return !/^(?:(?:for|in)\s+[^,]+,\s*)?(?:please\s+)?(?:i|we)\s+(?:really\s+)?prefer\b|^(?:(?:for|in)\s+[^,]+,\s*)?(?:please\s+)?(?:always\s+)?(?:use|prefer|keep|choose|select|write|run|include|show|ask|check|preserve|make|never|avoid|stop|merge)\b|^(?:(?:for|in)\s+[^,]+,\s*)?(?:please\s+)?(?:do\s+not|don't)\b/i.test(directive);
}

export function directiveSentences(text, options = {}) {
  const withoutFencedCode = String(text || "").replace(/```[\s\S]*?```/gu, "\n");
  return withoutFencedCode
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => [line.match(/^(?:[-*+]\s+|\d+[.)]\s+)(.+)$/u)?.[1] ?? line])
    .flatMap((line) => splitSentences(line, options));
}

export function isNonDirectiveSentence(text, { allowConditions = false } = {}) {
  const trimmed = String(text || "").trim();
  return !trimmed
    || trimmed.endsWith("?")
    || /\?[^\w]*$/u.test(trimmed)
    || isQuotedSentence(trimmed)
    || /^(?:please\s+)?(?:suppose|imagine|assuming|should we|could we|would you|could you|can you|am i able|can i|what do i|how do i|is there|would there be|were the|what if)\b/i.test(trimmed)
    || (!allowConditions && /^(?:if|unless|when)\b/i.test(trimmed))
    || /\b(?:don't|do not|never|not)\s+(?:really\s+)?prefer\b/i.test(trimmed)
    || /\bprefer\s+not\s+to\b/i.test(trimmed)
    || /\bi\s+meant\s+to\s+(?:ask|know|understand)\b/i.test(trimmed)
    || /\b(?:would|could|might|may)\s+(?:prefer|use|choose|avoid)\b/i.test(trimmed);
}

const EXPLICIT_SCOPE_PREAMBLE_PATTERN = /^(?:(?:for|in)\s+(?:this|the current)(?:\s+[a-z][a-z0-9_-]*){0,2}\s+(?:repo(?:sitory)?|project|app)|for\s+[a-z][a-z0-9_-]*(?:\s+[a-z][a-z0-9_-]*){0,4}|(?:across|in|for)\s+(?:all\s+)?(?:of\s+)?(?:my\s+)?(?:projects|repositories|repos)|make\s+(?:this\s+)?rule\s+global\s+across\s+(?:all\s+)?(?:projects|repositories|repos)|globally)\s*(?:,|:)\s*/i;

export function directiveBody(text) {
  return String(text || "")
    .replace(EXPLICIT_SCOPE_PREAMBLE_PATTERN, "")
    .replace(/^(?:as\s+(?:a\s+)?policy|in\s+(?:the\s+)?future|going\s+forward|from\s+now\s+on)\s*(?:,|:)\s*/i, "")
    .replace(/^(?:if|when|whenever|unless)\s+[^,]+,\s*/i, "")
    .replace(/^actually\s*,?\s*(?:that(?:'s| is)\s+wrong\s*:\s*)/i, "");
}

export function isHypotheticalDirectiveSentence(text) {
  return /\b(?:if|when|unless)\b[^.!?;]*\b(?:ever|were\s+to)\b|\b(?:might|could|would|may)\s+(?:prefer|use|choose|avoid)|\b(?:hypothetical|only\s+a\s+scenario|not\s+current\s+guidance)\b/i.test(text);
}

const TASK_CONSTRAINT_PATTERN = /\b(?:do not|don't)\s+(?:edit\s+(?:any\s+)?files?|make\s+(?:any\s+)?(?:code\s+)?changes?|run\s+(?:git\s+)?commit|run\s+git\b|commit(?:\s+(?:any\s+)?changes?)?|modify\s+(?:any\s+)?files?|change\s+(?:any\s+)?files?|touch\s+(?:any\s+)?files?)\b/i;
const TASK_REQUEST_START_PATTERN = /^(?:please\s+)?(?:review|draft|audit|inspect|check\s+(?:if|whether|for|the|this|that|a|an|all)\b|find|search|analyze|examine|look\s+at|generate|write\s+(?:a|an)\s+(?:[a-z-]+\s+)?(?:commit|bug\s+report|reproduction|summary|test|script|function|draft|response|report|description|message|note|doc|review|patch)\b|explain\s+(?:how|what|why|the|this|that|to\s+me|whether|where)\b|tell\s+me\s+if|summarize)\b/i;

// A topic (payments, failures, logging) does not make a request temporary.
// Explicit duration wins; otherwise distinguish a particular incident artifact
// from a standing rule about a class of work.
export function isOneOffDirectiveRequest(text) {
  const body = directiveBody(text);
  const scopedText = text.replace(EXPLICIT_SCOPE_PREAMBLE_PATTERN, "");
  if (/\b(?:just\s+this\s+once|this\s+time|for\s+(?:now|today)|(?:for|during)\s+this\s+(?:incident|run|request|response|reply|answer|attempt|reproduction|session|task)|(?:right\s+)?now|today)\b/i.test(body)
    || /^(?:for|during)\s+this\s+(?:incident|run|request|response|reply|answer|attempt|reproduction|session|task)\b/i.test(text)) {
    return true;
  }
  if (TASK_CONSTRAINT_PATTERN.test(body) || TASK_CONSTRAINT_PATTERN.test(text)) {
    return true;
  }
  if (/^(?:as\s+(?:a\s+)?policy|in\s+(?:the\s+)?future|going\s+forward|from\s+now\s+on)\b/i.test(scopedText)
    || /^(?:please\s+)?(?:(?:i|we)\s+)?(?:always|never|prefer)\b/i.test(body)
    || /^(?:i|we)\s+(?:really\s+)?prefer\b|^my\s+preference\s+is\b|^remember\b/i.test(body)
    || /\b(?:each|every)\s+[a-z]|\b(?:all|future)\s+(?:requests|responses|reports|incidents|mutations|reviews|commits|runs|projects)\b/i.test(body)) {
    return false;
  }
  if (TASK_REQUEST_START_PATTERN.test(body) || TASK_REQUEST_START_PATTERN.test(text)) {
    return true;
  }
  const target = body.split(/\s+(?:before|after|when|because|so)\s+/i)[0];
  return /\b(?:a|an|this|that|the)\s+(?:[a-z-]+\s+){0,2}(?:attachment|report|reproduction|request|response|incident|issue)\b(?=\s+(?:to|for|in|into|from|open|closed|updated|and|but)\b|[.,;]|$)/i.test(target)
    || /\b(?:this|that|the)\s+(?:(?:currently|failing|failed|captured|broken|payment|bug)\s+){1,3}(?:request|response|endpoint|logs?|report|issue|reproduction)\b/i.test(target)
    || /\b(?:this|that|the)\s+(?:bug|incident|issue|reproduction)\b/i.test(target)
    || /^(?:please\s+)?(?:run|check|inspect|reproduce|attach|report)\s+(?:(?:the|this|that|a|an)\s+|tests?[.!]?\s*$)/i.test(target);
}

// Standing policy is remember/prefer/always/never/must/should — not a bare
// imperative verb ("run the tests", "use bun for this task").
const POLICY_VERBS = "use|keep|require|preserve|redact|validate|run|schedule|key|read|sample|expose|represent|chain|store|fall back|send|write|version|name|classify|fail|return|rotate|encrypt|publish|renew|cap|inject|index|move|pause|distinguish|set|propagate|invalidate|limit|process|record|infer|retain|restore|parse|tell|link|label|acknowledge|explain|put|format|include|split|ask|check|make|say";
const PROHIBITION_VERBS = `${POLICY_VERBS}|retry|commit|push|delete|merge|overwrite|ignore|assume|rely|start|choose|concatenate|cast|truncate|emit|print|drop|remove|disable`;
const PROHIBITION = new RegExp(`^(?:please\\s+)?(?:do not|don't|never)\\s+(?:[a-z]+ly\\s+|ever\\s+)?(?!(?:forget)\\b)(?:${PROHIBITION_VERBS})\\s+.+$`, "i");
const SUBJECT_REQUIREMENT = /^[a-z][a-z0-9 ,'-]{1,90}?\s+(?:must|should)\s+(?:(?:not|never)\s+)?[a-z]+\b/i;

export function standingDirectiveType(text) {
  if (isNonDirectiveSentence(text, { allowConditions: true })) return null;
  const body = directiveBody(text);
  const isDontForget = /^(?:please\s+)?(?:do not|don't)\s+forget\b/i.test(body);
  if (!isDontForget && (PROHIBITION.test(body) || /^(?:please\s+)?(?:reject|avoid|stop)\s+.+/i.test(body))) return "rejected_approach";
  const mainClause = body.split(/\s+(?:because|so|before|after|when)\s+/i)[0];
  if (/\b(?:says|said|asked|whether|claims|claimed|suggests|suggested|proposes|proposed)\b/i.test(mainClause)) return null;
  if (SUBJECT_REQUIREMENT.test(mainClause)) {
    return /\b(?:must|should)\s+(?:not|never)\b/i.test(mainClause) ? "rejected_approach" : "directive";
  }
  if (/^[a-z][a-z0-9 ,'-]{1,90}?\s+is\s+not\s+acceptable\b/i.test(body)) return "rejected_approach";
  if (/^[a-z][a-z0-9 ,'-]{1,90}?\s+(?:is|are)\s+mandatory\b/i.test(body)) return "directive";
  return null;
}
