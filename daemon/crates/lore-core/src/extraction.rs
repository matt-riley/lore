//! Deterministic extraction over verified normalized evidence.
//!
//! Ports the v1 rule grammar's intent without copying its implementation:
//! standing directives, explicit preferences, rejections/reversals and
//! completed decisions become proposals with scope, evidence and rule
//! version. Questions, quotations, hypotheticals, one-off task constraints
//! and assistant reports never become standing instructions.

use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

/// Grammar version persisted with every run. Changing output requires an
/// explicit reprocessing run, never a silent history rewrite.
pub const RULE_VERSION: &str = "rules-v1";

/// A normalized evidence turn as consumed by extraction.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnInput {
    pub role: String,
    pub text: String,
    #[serde(default)]
    pub evidence_key: String,
    #[serde(default)]
    pub turn_index: i64,
    #[serde(default)]
    pub completeness: String,
}

/// One extracted proposition.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Proposal {
    /// `user_preference`, `directive`, `rejected_approach` or `decision`.
    pub kind: String,
    pub content: String,
    /// `global`, `repo` or `unresolved`.
    pub scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    pub confidence: f64,
    pub evidence_key: String,
    pub turn_index: i64,
    pub source_role: String,
    pub rule_version: String,
    /// Normalized content used for identity, corrections and suppression.
    pub topic_key: String,
    /// Topic keys of prior proposals this one supersedes.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub retires: Vec<String>,
    #[serde(default)]
    pub correction: bool,
}

/// Extraction outcome for one evidence batch.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ExtractionResult {
    pub proposals: Vec<Proposal>,
    /// Turns skipped because they are not eligible evidence.
    pub skipped: usize,
    /// Proposals left unresolved because repository identity is missing.
    pub unresolved: usize,
}

fn regex(pattern: &str) -> Regex {
    Regex::new(pattern).expect("static extraction pattern")
}

struct Patterns {
    preference: Vec<Regex>,
    prohibition_lead: Regex,
    avoidance: Vec<Regex>,
    subject_requirement: Regex,
    subject_prohibition: Regex,
    decision: Vec<Regex>,
    global_scope: Regex,
    task_constraint: Regex,
    task_request_start: Regex,
    incident_artifact: Vec<Regex>,
    hypothetical: Regex,
    non_directive: Vec<Regex>,
    reported: Regex,
    correction_lead: Regex,
}

static PATTERNS: LazyLock<Patterns> = LazyLock::new(|| Patterns {
    preference: vec![
        regex(r"(?i)^(?:i|we)\s+(?:always\s+)?(?:really\s+)?prefer\s+.+$"),
        regex(r"(?i)^(?:please\s+)?prefer\s+.+$"),
        regex(r"(?i)^my\s+preference\s+is\s+.+$"),
        regex(
            r"(?i)^(?:please\s+)?always\s+(?:use|keep|include|show|run|write|ask|check|preserve|make)\s+.+$",
        ),
        regex(
            r"(?i)^(?:i|we)\s+always\s+(?:use|keep|include|show|run|write|ask|check|preserve|make)\s+.+$",
        ),
        regex(r"(?i)^please\s+(?:use|keep|include|show|run|write|ask|check|preserve|make)\s+.+$"),
        regex(r"(?i)^(?:i|we)\s+work\s+best\s+with\s+.+$"),
        regex(
            r"(?i)^(?:across|in)\s+(?:all\s+)?(?:of\s+)?(?:my\s+)?projects?\s+i\s+work\s+best\s+with\s+.+$",
        ),
        regex(r"(?i)^(?:no\s*,?\s*)?i\s+meant\s+.+$"),
        regex(r"(?i)^(?:please\s+)?remember\s+.+$"),
        regex(r"(?i)^split\s+(?:changes|commits)\b.+$"),
        regex(
            r"(?i)^(?:please\s+)?(?:use|keep|include|show|run|write|ask|check|preserve|make)\s+.+\s+(?:for|when|in)\s+(?:this|the)\s+(?:repo|repository|project)\b.*$",
        ),
        regex(r"(?i)^please\s+(?:keep|make|write|format)\s+.+$"),
    ],
    prohibition_lead: regex(
        r"(?i)^(?:please\s+)?(?:do not|don't|never)\s+(?:[a-z]+ly\s+|ever\s+)?([a-z]+)\b(.+)$",
    ),
    avoidance: vec![
        regex(r"(?i)^(?:please\s+)?avoid\s+.+$"),
        regex(r"(?i)^(?:please\s+)?stop\s+.+$"),
        regex(
            r"(?i)^(?:i|we)\s+(?:do not|don't|never)\s+(?:want|like|use|need|store|include|see)\s+.+$",
        ),
    ],
    subject_requirement: regex(
        r"^(?i)[a-z][a-z0-9 ,'-]{1,90}?\s+(?:must|should)\s+(?:(?:not|never)\s+)?[a-z]+\b",
    ),
    subject_prohibition: regex(r"(?i)\b(?:must|should)\s+(?:not|never)\b"),
    decision: vec![
        regex(r"(?i)^(?:we|i)\s+(?:have\s+)?decided\s+to\s+(.+?)(?:\s+because\s+(.+))?$"),
        regex(
            r"(?i)^(?:we|i)\s+(?:(?:initially|ultimately|finally)\s+)?(?:chose|selected|settled\s+on)\s+(.+?)(?:\s+because\s+(.+))?$",
        ),
        regex(r"(?i)^(?:we|i)\s+(?:changed|switched|moved)\s+to\s+(.+?)(?:\s+because\s+(.+))?$"),
        regex(
            r"(?i)^(?:after|following)\s+[^,]+,\s*(?:we|i)\s+(?:(?:initially|ultimately|finally)\s+)?(?:chose|selected|settled\s+on)\s+(.+?)(?:\s+because\s+(.+))?$",
        ),
        regex(
            r"(?i)^the\s+decision\s+changed\b.*?:\s*(?:use|choose)\s+(.+?)(?:\s+because\s+(.+))?$",
        ),
        regex(
            r"(?i)^the\s+(?:[a-z][a-z0-9-]*\s+){0,4}decision\s+is\s+(?:to\s+)?(.+?)(?:\s+because\s+(.+))?$",
        ),
    ],
    global_scope: regex(
        r"(?i)\b(?:for\s+all\s+work|(?:in|for)\s+(?:any|every)\s+(?:project|repository|repo)|reviewing\s+any\s+(?:project|repository|repo)|globally|across\s+(?:all\s+)?(?:of\s+)?(?:my\s+)?(?:projects|repositories|repos)|for\s+(?:every|all)\s+(?:my\s+)?(?:project|repository|repo)|regardless\s+of\s+(?:the\s+)?repo(?:sitory)?|in\s+all\s+(?:of\s+)?(?:my\s+)?(?:projects|repositories|repos))\b",
    ),
    task_constraint: regex(
        r"(?i)\b(?:do not|don't)\s+(?:edit\s+(?:any\s+)?files?|make\s+(?:any\s+)?(?:code\s+)?changes?|run\s+(?:git\s+)?commit|run\s+git\b|commit(?:\s+(?:any\s+)?changes?)?|modify\s+(?:any\s+)?files?|change\s+(?:any\s+)?files?|touch\s+(?:any\s+)?files?)\b",
    ),
    task_request_start: regex(
        r"(?i)^(?:please\s+)?(?:review|draft|audit|inspect|check\s+(?:if|whether|for|the|this|that|a|an|all)\b|find|search|analyze|examine|look\s+at|generate|write\s+(?:a|an)\s+(?:[a-z-]+\s+)?(?:commit|bug\s+report|reproduction|summary|test|script|function|draft|response|report|description|message|note|doc|review|patch)\b|explain\s+(?:how|what|why|the|this|that|to\s+me|whether|where)\b|tell\s+me\s+if|summarize)\b",
    ),
    incident_artifact: vec![
        regex(
            r"(?i)\b(?:a|an|this|that)\s+(?:[a-z-]+\s+){0,2}(?:attachment|report|reproduction|request|response|incident|issue)\b\s+(?:to|for|in|into|from|open|closed|updated|and|but)\b",
        ),
        regex(
            r"(?i)\b(?:this|that|the)\s+(?:(?:currently|failing|failed|captured|broken|payment|bug)\s+){1,3}(?:request|response|endpoint|logs?|report|issue|reproduction)\b",
        ),
    ],
    hypothetical: regex(
        r"(?i)\b(?:if|when|unless)\b[^.!?;]*\b(?:ever|were\s+to)\b|\b(?:might|could|would|may)\s+(?:prefer|use|choose|avoid)|\b(?:hypothetical|only\s+a\s+scenario|not\s+current\s+guidance)\b",
    ),
    non_directive: vec![
        regex(
            r"(?i)^(?:please\s+)?(?:suppose|imagine|assuming|should we|could we|would you|could you|can you|am i able|can i|what do i|how do i|is there|would there be|were the|what if)\b",
        ),
        regex(r"(?i)^(?:if|unless|when)\b"),
        regex(r"(?i)\b(?:don't|do not|never|not)\s+(?:really\s+)?prefer\b"),
        regex(r"(?i)\bprefer\s+not\s+to\b"),
        regex(r"(?i)\bi\s+meant\s+to\s+(?:ask|know|understand)\b"),
    ],
    reported: regex(
        r"(?i)\b(?:guide|example|report|runbook|source|document|prompt|message|user|assistant)\s+(?:says?|said|quotes?)\b|\b(?:example|guide)\s*:",
    ),
    correction_lead: regex(
        r"(?i)^(?:no|nope|nah|actually|instead|rather|not\s+quite|that(?:'s| is)\s+wrong|incorrect|still|that\s+still|decision\s+changed|no\s+longer|i\s+meant)\b",
    ),
});

fn normalize(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Sentence split with quote awareness, splitting on `.`, `!`, `?` and `;`
/// followed by whitespace or end of text.
pub fn split_sentences(text: &str) -> Vec<String> {
    let mut sentences = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let characters: Vec<char> = text.chars().collect();
    for (index, character) in characters.iter().enumerate() {
        current.push(*character);
        match character {
            '"' => {
                quote = if quote == Some('"') {
                    None
                } else {
                    quote.or(Some('"'))
                }
            }
            '\'' => {
                let previous = index.checked_sub(1).and_then(|value| characters.get(value));
                if quote == Some('\'') || !previous.is_some_and(|value| value.is_alphanumeric()) {
                    quote = if quote == Some('\'') {
                        None
                    } else {
                        quote.or(Some('\''))
                    };
                }
            }
            '\u{201c}' => quote = Some('\u{201d}'),
            '\u{201d}' if quote == Some('\u{201d}') => quote = None,
            _ => {}
        }
        let terminates = matches!(character, '.' | '!' | '?' | ';');
        let next = characters.get(index + 1);
        let previous_terminates = index
            .checked_sub(1)
            .and_then(|value| characters.get(value))
            .is_some_and(|value| matches!(value, '.' | '!' | '?' | ';'));
        let closes_quote = matches!(character, '"' | '\'' | '\u{201d}' | '\u{2019}');
        if closes_quote
            && previous_terminates
            && (next.is_none() || next.is_some_and(|value| value.is_whitespace()))
        {
            quote = None;
            let sentence = normalize(&current);
            if !sentence.is_empty() {
                sentences.push(sentence);
            }
            current.clear();
            continue;
        }
        if quote.is_none()
            && terminates
            && (next.is_none() || next.is_some_and(|value| value.is_whitespace()))
        {
            let sentence = normalize(&current);
            if !sentence.is_empty() {
                sentences.push(sentence);
            }
            current.clear();
        }
    }
    let remainder = normalize(&current);
    if !remainder.is_empty() {
        sentences.push(remainder);
    }
    sentences
}

/// Strip scope preambles and lead-ins from a directive sentence.
pub fn directive_body(text: &str) -> String {
    static SCOPE_PREAMBLE: LazyLock<Regex> = LazyLock::new(|| {
        regex(
            r"(?i)^(?:(?:for|in)\s+(?:this|the current)(?:\s+[a-z][a-z0-9_-]*){0,2}\s+(?:repo(?:sitory)?|project|app)|for\s+[a-z][a-z0-9_-]*(?:\s+[a-z][a-z0-9_-]*){0,4}|(?:across|in|for)\s+(?:all\s+)?(?:of\s+)?(?:my\s+)?(?:projects|repositories|repos)|make\s+(?:this\s+)?rule\s+global\s+across\s+(?:all\s+)?(?:projects|repositories|repos)|globally)\s*(?:,|:)\s*",
        )
    });
    static FUTURE_LEAD: LazyLock<Regex> = LazyLock::new(|| {
        regex(
            r"(?i)^(?:as\s+(?:a\s+)?policy|in\s+(?:the\s+)?future|going\s+forward|from\s+now\s+on)\s*(?:,|:)\s*",
        )
    });
    static CONDITION_LEAD: LazyLock<Regex> =
        LazyLock::new(|| regex(r"(?i)^(?:if|when|whenever|unless)\s+[^,]+,\s*"));
    static CORRECTION_LEAD: LazyLock<Regex> = LazyLock::new(|| {
        regex(
            r"(?i)^(?:actually\s*,?\s*(?:that(?:'s| is)\s+wrong\s*:\s*)|no\s*,\s*i\s+meant\s+|no\s*,\s*i\s+mean\s+|no\s*,\s+|not\s+quite\s*[,:]\s*|that(?:'s| is)\s+wrong\s*[,:]\s*|incorrect\s*[,:]\s*|instead\s*[,:]\s*|rather\s*[,:]\s*)",
        )
    });
    normalize(
        CORRECTION_LEAD
            .replace_all(
                &CONDITION_LEAD.replace_all(
                    &FUTURE_LEAD.replace_all(&SCOPE_PREAMBLE.replace(text, ""), ""),
                    "",
                ),
                "",
            )
            .trim(),
    )
}

fn masked_quotes(text: &str) -> String {
    static UNICODE_QUOTES: LazyLock<Regex> =
        LazyLock::new(|| regex(r#""[^"\n]*"|“[^”\n]*”|‘[^’\n]*’"#));
    UNICODE_QUOTES
        .replace_all(text, "quoted object")
        .to_string()
}

fn quote_like_apostrophes(text: &str) -> usize {
    let characters: Vec<char> = text.chars().collect();
    characters
        .iter()
        .enumerate()
        .filter(|(index, character)| {
            if **character != '\'' {
                return false;
            }
            let previous = index.checked_sub(1).and_then(|value| characters.get(value));
            let next = characters.get(index + 1);
            !previous.is_some_and(|value| value.is_alphanumeric())
                || !next.is_some_and(|value| value.is_alphanumeric())
        })
        .count()
}

fn quote_counts_are_odd(text: &str) -> bool {
    let straight_double = text.matches('"').count();
    let straight_single = quote_like_apostrophes(text);
    let curly_open = text.matches('\u{201c}').count();
    let curly_close = text.matches('\u{201d}').count();
    let single_open = text.matches('\u{2018}').count();
    let single_close = text.matches('\u{2019}').count();
    straight_double % 2 == 1
        || straight_single % 2 == 1
        || curly_open != curly_close
        || single_open != single_close
}

/// Whether a sentence is quoted or reported rather than a live instruction.
pub fn is_quoted_sentence(text: &str) -> bool {
    let trimmed = text.trim();
    if PATTERNS.reported.is_match(trimmed) {
        return true;
    }
    if quote_counts_are_odd(trimmed) {
        return true;
    }
    let quoted_whole = regex(r#"(?i)^(?:"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|'[^'\n]*')\s*[.!?]?$"#);
    if quoted_whole.is_match(trimmed) {
        return true;
    }
    let masked = masked_quotes(trimmed);
    if masked == trimmed {
        return false;
    }
    !is_accepted_directive_syntax(&directive_body(&masked))
}

fn is_accepted_directive_syntax(text: &str) -> bool {
    PATTERNS
        .preference
        .iter()
        .any(|pattern| pattern.is_match(text))
        || is_rejection(text)
        || standing_directive_type(text).is_some()
}

/// Explicit preference sentences.
pub fn is_explicit_preference(text: &str) -> bool {
    let body = directive_body(text);
    PATTERNS
        .preference
        .iter()
        .any(|pattern| pattern.is_match(&body) || pattern.is_match(text))
}

const PROHIBITION_VERBS: &[&str] = &[
    "use",
    "keep",
    "require",
    "preserve",
    "redact",
    "validate",
    "run",
    "schedule",
    "key",
    "read",
    "sample",
    "expose",
    "represent",
    "chain",
    "store",
    "fall",
    "send",
    "write",
    "version",
    "name",
    "classify",
    "fail",
    "return",
    "rotate",
    "encrypt",
    "publish",
    "renew",
    "cap",
    "inject",
    "index",
    "move",
    "pause",
    "distinguish",
    "set",
    "propagate",
    "invalidate",
    "limit",
    "process",
    "record",
    "infer",
    "retain",
    "restore",
    "parse",
    "tell",
    "link",
    "label",
    "acknowledge",
    "explain",
    "put",
    "format",
    "include",
    "split",
    "ask",
    "check",
    "make",
    "say",
    "retry",
    "commit",
    "push",
    "delete",
    "merge",
    "overwrite",
    "ignore",
    "assume",
    "rely",
    "start",
    "choose",
    "concatenate",
    "cast",
    "truncate",
    "emit",
    "print",
    "drop",
    "remove",
    "disable",
    "log",
    "add",
    "change",
    "modify",
    "expose",
    "concatenate",
];

fn is_prohibition(text: &str) -> bool {
    let Some(captures) = PATTERNS.prohibition_lead.captures(text) else {
        return false;
    };
    let verb = captures
        .get(1)
        .map(|value| value.as_str().to_lowercase())
        .unwrap_or_default();
    verb != "forget" && PROHIBITION_VERBS.contains(&verb.as_str())
}

fn is_rejection(text: &str) -> bool {
    let body = directive_body(text);
    is_prohibition(text)
        || is_prohibition(&body)
        || PATTERNS
            .avoidance
            .iter()
            .any(|pattern| pattern.is_match(text) || pattern.is_match(&body))
        || regex(r"(?i)^(?:please\s+)?(?:reject|avoid|stop)\s+.+").is_match(&body)
}

/// Standing policy classification: `directive` or `rejected_approach`.
pub fn standing_directive_type(text: &str) -> Option<&'static str> {
    if is_non_directive(text) {
        return None;
    }
    let body = directive_body(text);
    let dont_forget = regex(r"(?i)^(?:please\s+)?(?:do not|don't)\s+forget\b").is_match(&body);
    if !dont_forget
        && (is_prohibition(&body)
            || PATTERNS
                .avoidance
                .iter()
                .any(|pattern| pattern.is_match(&body)))
    {
        return Some("rejected_approach");
    }
    let main_clause = body
        .split(" because ")
        .next()
        .unwrap_or(&body)
        .split(" so ")
        .next()
        .unwrap_or(&body);
    let reported = regex(
        r"(?i)\b(?:says|said|asked|whether|claims|claimed|suggests|suggested|proposes|proposed)\b",
    );
    if reported.is_match(main_clause) {
        return None;
    }
    if PATTERNS.subject_requirement.is_match(main_clause) {
        return Some(if PATTERNS.subject_prohibition.is_match(main_clause) {
            "rejected_approach"
        } else {
            "directive"
        });
    }
    if regex(r"(?i)^[a-z][a-z0-9 ,'-]{1,90}?\s+is\s+not\s+acceptable\b").is_match(&body) {
        return Some("rejected_approach");
    }
    if regex(r"(?i)^[a-z][a-z0-9 ,'-]{1,90}?\s+(?:is|are)\s+mandatory\b").is_match(&body) {
        return Some("directive");
    }
    None
}

/// Non-directive detection: questions, quotations, hypotheticals, weak
/// modal preferences and meta-questions.
pub fn is_non_directive(text: &str) -> bool {
    if is_non_directive_soft(text) {
        return true;
    }
    PATTERNS
        .non_directive
        .iter()
        .any(|pattern| pattern.is_match(text.trim()))
}

/// Non-directive checks excluding the leading-condition rule, used where a
/// condition is part of the standing statement ("If the index is
/// unavailable, return an empty result").
fn is_non_directive_soft(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.ends_with('?') {
        return true;
    }
    if is_quoted_sentence(trimmed) || is_hypothetical(trimmed) {
        return true;
    }
    PATTERNS.non_directive[2..]
        .iter()
        .any(|pattern| pattern.is_match(trimmed))
}

pub fn is_hypothetical(text: &str) -> bool {
    PATTERNS.hypothetical.is_match(text)
}

/// One-off task requests and incident-scoped constraints are not standing.
pub fn is_one_off(text: &str) -> bool {
    let body = directive_body(text);
    let temporal = regex(
        r"(?i)\b(?:just\s+this\s+once|this\s+time|for\s+(?:now|today)|(?:for|during)\s+this\s+(?:incident|run|request|response|reply|answer|attempt|reproduction|session|task)|(?:right\s+)?now|today)\b",
    );
    if temporal.is_match(text) || temporal.is_match(&body) {
        return true;
    }
    if PATTERNS.task_constraint.is_match(&body) || PATTERNS.task_constraint.is_match(text) {
        return true;
    }
    let standing_start = regex(
        r"(?i)^(?:as\s+(?:a\s+)?policy|in\s+(?:the\s+)?future|going\s+forward|from\s+now\s+on)\b",
    );
    let always = regex(r"(?i)^(?:please\s+)?(?:(?:i|we)\s+)?(?:always|never|prefer)\b");
    let strong =
        regex(r"(?i)^(?:i|we)\s+(?:really\s+)?prefer\b|^my\s+preference\s+is\b|^remember\b");
    let repeated = regex(
        r"(?i)\b(?:each|every)\s+[a-z]|\b(?:all|future)\s+(?:requests|responses|reports|incidents|mutations|reviews|commits|runs|projects)\b",
    );
    if always.is_match(&body)
        || strong.is_match(&body)
        || standing_start.is_match(text)
        || repeated.is_match(&body)
    {
        return false;
    }
    if PATTERNS.task_request_start.is_match(&body) || PATTERNS.task_request_start.is_match(text) {
        return true;
    }
    PATTERNS
        .incident_artifact
        .iter()
        .any(|pattern| pattern.is_match(&body))
        || regex(r"(?i)\b(?:this|that|the)\s+(?:bug|incident|issue|reproduction)\b").is_match(&body)
}

/// Explicit global scope grammar. Missing repository identity never implies
/// global scope by itself.
pub fn has_explicit_global_scope(text: &str) -> bool {
    PATTERNS.global_scope.is_match(text)
}

fn is_non_completed_decision(text: &str) -> bool {
    regex(r"(?i)\b(?:asked|whether|unclear|not\s+decided|still\s+open|hypothetical|scenario|example|i\s+think|i\s+believe|not\s+verified|have\s+not\s+verified|perhaps|maybe|possibly|probably|did\s+not|didn't)\b")
        .is_match(text)
}

fn decision_match(sentence: &str) -> Option<(String, String)> {
    let sentence = sentence
        .trim_start_matches(|character: char| character == ',' || character.is_whitespace());
    for pattern in &PATTERNS.decision {
        if let Some(captures) = pattern.captures(sentence) {
            let choice = normalize(captures.get(1).map(|value| value.as_str()).unwrap_or(""))
                .trim_end_matches([';', ',', '.'])
                .trim()
                .trim_end_matches("instead")
                .trim_end_matches(',')
                .trim()
                .to_string();
            let rationale = normalize(captures.get(2).map(|value| value.as_str()).unwrap_or(""));
            if choice.len() >= 3 {
                return Some((choice, rationale));
            }
        }
    }
    None
}

/// Content tokens used for overlap comparisons (length ≥ 3, lowercased).
fn tokens(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|character: char| !character.is_alphanumeric())
        .filter(|token| token.len() >= 3)
        .map(str::to_string)
        .collect()
}

/// Token equality with a light stem: `invalidations` and `invalidation`
/// describe the same subject.
fn token_matches(left: &str, right: &str) -> bool {
    if left == right {
        return true;
    }
    let shorter = left.len().min(right.len());
    shorter >= 5 && (left.starts_with(right) || right.starts_with(left))
}

fn overlap(left: &str, right: &str) -> usize {
    let left_tokens = tokens(left);
    let right_tokens = tokens(right);
    let mut matched = 0;
    for token in &left_tokens {
        if right_tokens.iter().any(|other| token_matches(token, other)) {
            matched += 1;
        }
    }
    matched
}

fn scope_for(text: &str, repository: Option<&str>) -> (String, Option<String>) {
    if has_explicit_global_scope(text) {
        return ("global".to_string(), None);
    }
    match repository {
        Some(repository) => ("repo".to_string(), Some(repository.to_string())),
        None => ("unresolved".to_string(), None),
    }
}

fn make_proposal(
    kind: &str,
    content: &str,
    scope: &(String, Option<String>),
    confidence: f64,
    turn: &TurnInput,
    correction: bool,
) -> Proposal {
    Proposal {
        kind: kind.to_string(),
        content: content.to_string(),
        scope: scope.0.clone(),
        repository: scope.1.clone(),
        confidence,
        evidence_key: turn.evidence_key.clone(),
        turn_index: turn.turn_index,
        source_role: turn.role.clone(),
        rule_version: RULE_VERSION.to_string(),
        topic_key: normalize(content).to_lowercase(),
        retires: Vec::new(),
        correction,
    }
}

fn propose_from_sentence(
    sentence: &str,
    turn: &TurnInput,
    repository: Option<&str>,
) -> Option<Proposal> {
    let chained = split_chained_one_off(sentence);
    let text = chained.as_deref().unwrap_or(sentence);
    if is_non_directive_soft(text) || is_hypothetical(text) {
        return None;
    }
    let scope = scope_for(text, repository);
    let content = if scope.0 == "global" {
        normalize(text)
    } else {
        directive_body(text)
    };
    if let Some(standing) = standing_directive_type(text) {
        if is_one_off(text) {
            return None;
        }
        if content.len() < 4 {
            return None;
        }
        let kind = if standing == "rejected_approach" {
            "rejected_approach"
        } else if is_explicit_preference(text) {
            "user_preference"
        } else {
            "directive"
        };
        return Some(make_proposal(kind, &content, &scope, 0.78, turn, false));
    }
    if is_rejection(text) {
        if is_one_off(text) {
            return None;
        }
        return Some(make_proposal(
            "rejected_approach",
            &content,
            &scope,
            0.76,
            turn,
            false,
        ));
    }
    if is_explicit_preference(text) {
        if is_one_off(text) {
            return None;
        }
        if content.len() < 4 {
            return None;
        }
        return Some(make_proposal(
            "user_preference",
            &content,
            &scope,
            0.78,
            turn,
            false,
        ));
    }
    // A correction lead followed by an imperative "use …" is an explicit
    // replacement preference ("Actually, that is wrong: use a 45 second …").
    if is_correction_lead(text) {
        let body = directive_body(text);
        if regex(r"(?i)^use\s+.+").is_match(&body) && !is_one_off(text) {
            return Some(make_proposal(
                "user_preference",
                &body,
                &scope,
                0.78,
                turn,
                true,
            ));
        }
    }
    // A bare policy imperative states a standing preference when it is not a
    // task request, question, quotation, hypothesis or one-off constraint.
    if is_imperative_preference(text)
        && !is_one_off(text)
        && !is_task_request(text)
        && content.len() >= 8
    {
        return Some(make_proposal(
            "user_preference",
            &content,
            &scope,
            0.72,
            turn,
            false,
        ));
    }
    None
}

/// Imperative statements built from policy verbs rather than task verbs.
fn is_imperative_preference(text: &str) -> bool {
    static IMPERATIVE: LazyLock<Regex> = LazyLock::new(|| {
        regex(
            r"(?i)^(?:please\s+)?(?:use|keep|preserve|redact|require|validate|apply|store|include|show|format|schedule|limit|cap|lock|chain|record|emit|return|fail|retry|copy|sign|pin|mark|index|name|version|rotate|encrypt|treat|write|split|prefer|always|never|expose|tell|represent|fall|send|run|reject|classify|sample|heartbeat|accept|verify|document|configure|enable|disable|add|remove|delete|allow|block|enforce|maintain|report|honor|honour|respect|prioritize|prioritise|avoid|key|make|read|explain|renew|stop|acknowledge|inject|move|set|propagate|invalidate|pause|resume|distinguish|put|label|publish|preserve|replay|route|retain|triage|throttle|quarantine|infer|process|restore|parse|harden|isolate|reuse|link|ask|check|say|emit|fail|copy|sign|pin|mark|name|version|rotate|encrypt|write|prefer|always|never)\b",
        )
    });
    let body = directive_body(text);
    // Bare imperatives are only evidentiary when they read as statements
    // (sentence-initial capital or an explicit "Please"). Lowercase clauses
    // after a semicolon are allowed only when they are an additional rule:
    // remediation phrasing ("use X instead") is not standing policy.
    let starts_upper = text
        .trim_start()
        .chars()
        .find(|character| character.is_alphabetic())
        .is_some_and(|character| character.is_uppercase());
    let starts_please = regex(r"(?i)^please\b").is_match(&body);
    let remediation = regex(r"(?i)\b(?:instead|rather)\b").is_match(&body)
        || regex(r"(?i)^use\b").is_match(&body);
    (starts_upper || starts_please || !remediation) && IMPERATIVE.is_match(&body)
}

fn is_task_request(text: &str) -> bool {
    static REPEATED_RULE: LazyLock<Regex> =
        LazyLock::new(|| regex(r"(?i)\b(?:each|every)\s+[a-z]|\bfor\s+(?:all|every)\b"));
    if REPEATED_RULE.is_match(text) {
        return false;
    }
    PATTERNS.task_request_start.is_match(text)
        || PATTERNS.task_request_start.is_match(&directive_body(text))
}

/// Split `"<policy> and never <prohibition>"` into its two propositions.
fn embedded_prohibition(sentence: &str) -> Option<(String, String)> {
    static BOUNDARY: LazyLock<Regex> = LazyLock::new(|| regex(r"(?i)\s+(?:and|but)\s+"));
    static PROHIBITION: LazyLock<Regex> =
        LazyLock::new(|| regex(r"(?i)^(?:never|do\s+not|don't|avoid)\b"));
    for boundary in BOUNDARY.find_iter(sentence) {
        let tail = sentence[boundary.end()..].trim();
        if PROHIBITION.is_match(tail) {
            let head = sentence[..boundary.start()].trim().to_string();
            if !head.is_empty() {
                return Some((head, tail.to_string()));
            }
        }
    }
    None
}

/// Remediation phrasing that restates a prohibition rather than adding a rule.
fn is_remediation(sentence: &str) -> bool {
    let body = directive_body(sentence);
    regex(r"(?i)\b(?:instead|rather)\b").is_match(&body)
        || regex(r"(?i)^use\b").is_match(body.trim())
}

/// Split `"... and then push them up to main"` into policy and one-off parts.
fn split_chained_one_off(sentence: &str) -> Option<String> {
    static CHAINED: LazyLock<Regex> =
        LazyLock::new(|| regex(r"(?i)^(.*?)[,]?\s+and\s+then\s+(.+)$"));
    static ONE_OFF_ACTION: LazyLock<Regex> = LazyLock::new(|| {
        regex(
            r"(?i)^(?:then\s+)?(?:please\s+)?(?:push|merge|deploy|open\s+(?:a\s+|an\s+)?(?:pr|pull\s+request)|create\s+(?:a\s+|an\s+)?(?:pr|pull\s+request)|submit\s+(?:a\s+|an\s+)?(?:pr|pull\s+request)|commit(?:\s+(?:it|that|this|them|the\s+changes?))?|run\s+(?:the\s+)?(?:tests?|build|ci|deploy(?:ment)?)|close\s+(?:the\s+)?(?:issue|ticket)|ship\s+it|release\s+it|tag\s+(?:the\s+)?release)\b",
        )
    });
    let captures = CHAINED.captures(sentence)?;
    let lead = captures
        .get(1)?
        .as_str()
        .trim()
        .trim_end_matches([',', ':', ';'])
        .trim();
    let trailing = captures.get(2)?.as_str().trim();
    if lead.is_empty() || !ONE_OFF_ACTION.is_match(trailing) {
        return None;
    }
    Some(lead.to_string())
}

fn is_correction_lead(text: &str) -> bool {
    PATTERNS.correction_lead.is_match(text.trim())
}

/// A decision sentence that reverses an earlier choice ("the decision
/// changed", "no longer", "instead") supersedes the prior proposition.
fn is_decision_reversal(text: &str) -> bool {
    regex(r"(?i)\b(?:decision\s+changed|no\s+longer|instead|reconsidered|switched\s+to|changed\s+to)\b")
        .is_match(text)
}

/// Extract proposals from user turns in order, retiring superseded proposals
/// when a correction or reversal arrives. Assistant turns contribute
/// attributed decisions but never standing instructions.
fn extract_decision(
    sentence: &str,
    turn: &TurnInput,
    repository: Option<&str>,
) -> Option<Proposal> {
    if is_non_directive(sentence) || is_non_completed_decision(sentence) {
        return None;
    }
    let (choice, rationale) = decision_match(sentence)?;
    let context = decision_context(sentence);
    let content = format!(
        "Decision: {choice}{}{}",
        if rationale.is_empty() {
            String::new()
        } else {
            format!(" because {rationale}")
        },
        context
            .map(|value| format!(" ({value})"))
            .unwrap_or_default()
    );
    let scope = scope_for(sentence, repository);
    Some(make_proposal(
        "decision", &content, &scope, 0.82, turn, false,
    ))
}

fn decision_context(sentence: &str) -> Option<String> {
    static CONTEXT: LazyLock<Regex> =
        LazyLock::new(|| regex(r"(?i)^((?:after|following)\s+[^,]+),\s*(?:we|i)\s+"));
    CONTEXT
        .captures(sentence)
        .and_then(|captures| captures.get(1).map(|value| value.as_str().to_string()))
}

pub fn extract(repository: Option<&str>, turns: &[TurnInput]) -> ExtractionResult {
    let mut result = ExtractionResult::default();
    for turn in turns {
        if matches!(
            turn.completeness.as_str(),
            "summary" | "partial" | "abandoned"
        ) {
            result.skipped += 1;
            continue;
        }
        if turn.role == "assistant" {
            for sentence in split_sentences(&turn.text) {
                if let Some(proposal) = extract_decision(&sentence, turn, repository) {
                    // A report of a decision already stated in this session is
                    // attribution, not a second proposition.
                    let reported = result.proposals.iter().any(|prior| {
                        prior.kind == proposal.kind
                            && overlap(&prior.content, &proposal.content) >= 1
                    });
                    if !reported {
                        result.proposals.push(proposal);
                    }
                }
            }
            continue;
        }
        if turn.role != "user" {
            result.skipped += 1;
            continue;
        }
        let correction_lead = is_correction_lead(&turn.text);
        let mut last_rejection: Option<String> = None;
        let mut turn_has_proposal = false;
        for sentence in split_sentences(&turn.text) {
            // (h) "prefer bounded queues and never drop the request id" carries
            // a second, prohibition proposition.
            if let Some((head, prohibition)) = embedded_prohibition(&sentence)
                && let Some(proposal) = propose_from_sentence(&head, turn, repository)
            {
                result.proposals.push(proposal);
                if let Some(rejected) = propose_from_sentence(&prohibition, turn, repository) {
                    last_rejection = Some(rejected.content.clone());
                    result.proposals.push(rejected);
                }
                continue;
            }
            if let Some(mut proposal) = extract_decision(&sentence, turn, repository) {
                let reversal = correction_lead || is_decision_reversal(&sentence);
                if reversal
                    && let Some(retired) = best_retirement(
                        &result.proposals,
                        "decision",
                        &proposal.content,
                        &(proposal.scope.clone(), proposal.repository.clone()),
                    )
                {
                    proposal.retires.push(retired);
                    proposal.correction = true;
                }
                result.proposals.push(proposal);
                continue;
            }
            if let Some(rejected) = &last_rejection {
                // Actions offered after a prohibition are not new standing
                // rules when they are remediation ("use opaque identifiers
                // instead") or restate the same subject ("keep the footer
                // link"). A genuinely different rule still counts.
                let body = directive_body(&sentence);
                if is_remediation(&sentence)
                    || (is_imperative_preference(&sentence) && overlap(rejected, &body) >= 1)
                {
                    continue;
                }
            }
            // A lowercase clause is only evidentiary when the turn has
            // already stated policy; bug-report follow-ups are one-off work.
            let starts_lower = sentence
                .trim_start()
                .chars()
                .find(|character| character.is_alphabetic())
                .is_some_and(|character| character.is_lowercase());
            if starts_lower && !turn_has_proposal {
                continue;
            }
            if let Some(mut proposal) = propose_from_sentence(&sentence, turn, repository) {
                turn_has_proposal = true;
                if proposal.kind == "rejected_approach" {
                    last_rejection = Some(proposal.content.clone());
                }
                if correction_lead
                    && let Some(retired) = best_retirement(
                        &result.proposals,
                        &proposal.kind,
                        &proposal.content,
                        &(proposal.scope.clone(), proposal.repository.clone()),
                    )
                {
                    proposal.retires.push(retired);
                    proposal.correction = true;
                }
                result.proposals.push(proposal);
                continue;
            }
            // Chained clauses: "…, so please use that order in this project".
            for clause in split_directive_clauses(&sentence) {
                if clause == sentence {
                    continue;
                }
                if let Some(proposal) = propose_from_sentence(&clause, turn, repository) {
                    let body = directive_body(&sentence);
                    let mut proposal = proposal;
                    proposal.content = body.clone();
                    proposal.topic_key = normalize(&body).to_lowercase();
                    result.proposals.push(proposal);
                    break;
                }
            }
        }
    }
    result.unresolved = result
        .proposals
        .iter()
        .filter(|proposal| proposal.scope == "unresolved")
        .count();
    result
}

/// Split a sentence into directive clauses on semicolons and policy
/// conjunctions, mirroring the v1 grammar's clause handling.
fn split_directive_clauses(sentence: &str) -> Vec<String> {
    static BOUNDARY: LazyLock<Regex> = LazyLock::new(|| regex(r"(?i)\s+(?:and|but|so)\s+"));
    static POLICY_LEAD: LazyLock<Regex> =
        LazyLock::new(|| regex(r"(?i)^(?:never|do\s+not|don't|avoid|please)\b"));
    let mut clauses = Vec::new();
    for part in sentence.split(';') {
        let part = part.trim();
        if !part.is_empty() {
            clauses.push(part.to_string());
        }
    }
    let mut refined = Vec::new();
    for clause in clauses {
        let mut current = clause.clone();
        for boundary in BOUNDARY.find_iter(&clause) {
            let after = clause[boundary.end()..].trim_start();
            if POLICY_LEAD.is_match(after) {
                let head = current
                    .split(&clause[boundary.start()..boundary.end()])
                    .next()
                    .unwrap_or(&current)
                    .trim()
                    .to_string();
                if !head.is_empty() {
                    refined.push(head);
                }
                current = after.to_string();
            }
        }
        if !current.trim().is_empty() {
            refined.push(current.trim().to_string());
        }
    }
    if refined.is_empty() {
        refined.push(sentence.to_string());
    }
    refined
}

/// Choose the prior proposal a correction supersedes: same kind and scope,
/// highest topic overlap. `None` when nothing overlaps meaningfully.
fn best_retirement(
    proposals: &[Proposal],
    kind: &str,
    content: &str,
    scope: &(String, Option<String>),
) -> Option<String> {
    proposals
        .iter()
        .filter(|proposal| {
            proposal.kind == kind
                && proposal.scope == scope.0
                && proposal.repository == scope.1
                && proposal.retires.is_empty()
        })
        .map(|proposal| (proposal, overlap(&proposal.content, content)))
        .filter(|(_, overlap)| *overlap >= 1)
        .max_by_key(|(_, overlap)| *overlap)
        .map(|(proposal, _)| proposal.topic_key.clone())
}

/// Deterministic memory ID for a proposal: identical propositions extracted
/// twice map to one memory.
pub fn memory_id_for(proposal: &Proposal) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(proposal.kind.as_bytes());
    hasher.update([0]);
    hasher.update(proposal.scope.as_bytes());
    hasher.update([0]);
    hasher.update(proposal.repository.as_deref().unwrap_or("").as_bytes());
    hasher.update([0]);
    hasher.update(proposal.topic_key.as_bytes());
    format!("mem_{}", &format!("{:x}", hasher.finalize())[..32])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(role: &str, text: &str) -> TurnInput {
        TurnInput {
            role: role.to_string(),
            text: text.to_string(),
            evidence_key: format!("key:{text}"),
            turn_index: 1,
            completeness: "complete".to_string(),
        }
    }

    #[test]
    fn preferences_and_rejections_are_classified() {
        let result = extract(
            Some("acme/app"),
            &[
                turn(
                    "user",
                    "Please prefer small pure functions over clever abstractions.",
                ),
                turn(
                    "user",
                    "Never put credentials in examples, including test fixtures.",
                ),
                turn(
                    "user",
                    "Debug logs must redact bearer tokens before storage.",
                ),
                turn("user", "What timeout did we choose?"),
                turn(
                    "user",
                    "I disagree with the sentence \"Prefer one huge review commit.\"",
                ),
            ],
        );
        let kinds: Vec<&str> = result
            .proposals
            .iter()
            .map(|proposal| proposal.kind.as_str())
            .collect();
        assert_eq!(
            kinds,
            vec!["user_preference", "rejected_approach", "directive"]
        );
        assert!(
            result
                .proposals
                .iter()
                .all(|proposal| proposal.scope == "repo")
        );
    }

    #[test]
    fn global_scope_requires_explicit_language() {
        let result = extract(
            Some("acme/cli"),
            &[turn(
                "user",
                "Make this rule global across repositories: never put credentials in examples.",
            )],
        );
        assert_eq!(result.proposals.len(), 1);
        assert_eq!(result.proposals[0].scope, "global");
        assert_eq!(result.proposals[0].kind, "rejected_approach");
    }

    #[test]
    fn missing_repository_stays_unresolved() {
        let result = extract(None, &[turn("user", "Please prefer UTC timestamps.")]);
        assert_eq!(result.proposals[0].scope, "unresolved");
        assert_eq!(result.proposals[0].repository, None);
    }

    #[test]
    fn corrections_replace_prior_preferences() {
        let result = extract(
            Some("acme/worker"),
            &[
                turn("user", "Use a 30 second timeout for the worker."),
                turn(
                    "user",
                    "Actually, that is wrong: use a 45 second timeout because the upstream batch window is longer.",
                ),
            ],
        );
        assert_eq!(result.proposals.len(), 2, "{:?}", result.proposals);
        assert!(result.proposals[1].content.contains("45"));
        assert!(result.proposals[1].correction);
        assert!(
            result.proposals[1]
                .retires
                .contains(&result.proposals[0].topic_key)
        );
    }

    #[test]
    fn corrections_replace_implicit_prior_preferences() {
        let result = extract(
            Some("acme/docs-site"),
            &[
                turn("user", "Please use the short link in the guide."),
                turn(
                    "user",
                    "No, I meant the canonical full URL so copied guides remain self-contained.",
                ),
            ],
        );
        assert_eq!(result.proposals.len(), 2, "{:?}", result.proposals);
        assert!(result.proposals[1].content.contains("canonical"));
        assert!(
            result.proposals[1]
                .retires
                .contains(&result.proposals[0].topic_key)
        );
    }

    #[test]
    fn decisions_capture_choice_and_rationale() {
        let result = extract(
            Some("acme/catalog"),
            &[
                turn("user", "We initially chose Redis for catalog invalidation."),
                turn(
                    "user",
                    "The decision changed after the durability review: use PostgreSQL notifications instead, because losing invalidations is unacceptable.",
                ),
            ],
        );
        assert_eq!(result.proposals.len(), 2);
        assert_eq!(result.proposals[0].kind, "decision");
        assert!(
            result.proposals[1]
                .retires
                .contains(&result.proposals[0].topic_key)
        );
        assert!(result.proposals[1].content.contains("PostgreSQL"));
    }

    #[test]
    fn one_off_requests_and_questions_are_not_policy() {
        let result = extract(
            Some("acme/app"),
            &[
                turn("user", "Please review this pull request before lunch."),
                turn("user", "For this incident, run the export check once."),
                turn("user", "Could we prefer a different export format?"),
                turn("user", "If we ever were to prefer YAML, how would it work?"),
            ],
        );
        assert!(result.proposals.is_empty(), "{:?}", result.proposals);
    }

    #[test]
    fn deterministic_ids_are_stable() {
        let first = extract(
            Some("acme/app"),
            &[turn("user", "Please prefer UTC timestamps.")],
        );
        let second = extract(
            Some("acme/app"),
            &[turn("user", "Please prefer UTC timestamps.")],
        );
        assert_eq!(
            memory_id_for(&first.proposals[0]),
            memory_id_for(&second.proposals[0])
        );
    }
}
