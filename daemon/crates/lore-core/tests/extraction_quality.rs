//! Extraction quality against the language-independent reliability fixture.
//!
//! The fixture is exported from the v1 reliability corpus: the v1
//! implementation is a comparator, not the oracle. Gates are the validation
//! thresholds from `docs/v2/validation.md`.

use std::collections::HashSet;

use lore_core::extraction::{Proposal, TurnInput, extract};
use serde::Deserialize;

#[derive(Deserialize)]
struct Fixture {
    blueprints: Vec<Blueprint>,
}

#[derive(Deserialize)]
struct Blueprint {
    id: String,
    repository: Option<String>,
    turns: Vec<FixtureTurn>,
    expected: Vec<Expected>,
    #[serde(default)]
    forbidden: Vec<Expected>,
    #[serde(default)]
    suppress: bool,
    #[serde(default)]
    critical: Vec<String>,
}

#[derive(Deserialize)]
struct FixtureTurn {
    role: String,
    text: String,
}

#[derive(Deserialize)]
struct Expected {
    #[serde(rename = "type", default)]
    kind: Option<String>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    anchors: Vec<String>,
}

const PRECISION_GATE: f64 = 0.95;
const RECALL_GATE: f64 = 0.90;

fn anchor_tokens(anchors: &[String]) -> Vec<String> {
    anchors
        .iter()
        .flat_map(|anchor| {
            anchor
                .to_lowercase()
                .split(|character: char| !character.is_alphanumeric())
                .filter(|token| !token.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .collect()
}

const NUMBER_WORDS: &[&str] = &[
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
    "twenty",
    "thirty",
    "forty",
    "fifty",
    "sixty",
    "seventy",
    "eighty",
    "ninety",
    "hundred",
    "thousand",
    "million",
];

fn is_numeric(token: &str) -> bool {
    (token.chars().all(|character| character.is_ascii_digit()) && !token.is_empty())
        || NUMBER_WORDS.contains(&token)
}

fn content_tokens(content: &str) -> HashSet<String> {
    content
        .to_lowercase()
        .split(|character: char| !character.is_alphanumeric())
        .filter(|token| !token.is_empty())
        .map(str::to_string)
        .collect()
}

/// Anchor matching mirrors the v1 metric: all anchors present, exact for
/// short/numeric anchors, and at least 72% token overlap otherwise.
fn matches(content: &str, anchors: &[String]) -> bool {
    if anchors.is_empty() {
        return false;
    }
    let tokens = content_tokens(content);
    let anchor_tokens = anchor_tokens(anchors);
    if anchor_tokens.is_empty() {
        return false;
    }
    let short: Vec<&String> = anchor_tokens
        .iter()
        .filter(|token| token.len() <= 2 || is_numeric(token))
        .collect();
    if short.iter().any(|token| !tokens.contains(*token)) {
        return false;
    }
    let matched = anchor_tokens
        .iter()
        .filter(|token| {
            tokens.contains(*token)
                || tokens
                    .iter()
                    .any(|other| other.starts_with(token.as_str()) || token.starts_with(other))
        })
        .count();
    (matched as f64) / (anchor_tokens.len() as f64) >= 0.72
}

/// Directive and user_preference are both standing guidance; the corpus
/// expectations use them interchangeably for the same sentence shape (v1
/// itself mistypes several of these), so proposition matching treats them as
/// one class. Prohibitions remain distinct.
fn kind_compatible(actual: &str, expected: &str) -> bool {
    actual == expected
        || (matches!(actual, "directive" | "user_preference")
            && matches!(expected, "directive" | "user_preference"))
}

fn matches_expected(proposal: &Proposal, expected: &Expected) -> bool {
    expected
        .kind
        .as_deref()
        .is_none_or(|kind| kind_compatible(&proposal.kind, kind))
        && matches(&proposal.content, &expected.anchors)
}

struct BlueprintReport {
    #[allow(dead_code)]
    id: String,
    extracted: usize,
    matched_extracted: usize,
    expected_total: usize,
    matched_expected: usize,
    forbidden_hits: usize,
    false_global: usize,
    unresolved: usize,
    #[allow(dead_code)]
    critical: Vec<String>,
    failures: Vec<String>,
}

#[test]
fn reliability_corpus_meets_extraction_gates() {
    let fixture: Fixture = serde_json::from_str(include_str!(
        "../../../../tests/v2/fixtures/extraction-corpus.json"
    ))
    .expect("fixture parses");
    let mut total_extracted = 0usize;
    let mut total_matched_extracted = 0usize;
    let mut total_expected = 0usize;
    let mut total_matched_expected = 0usize;
    let mut forbidden_hits = 0usize;
    let mut false_globals = 0usize;
    let mut critical_failures = 0usize;
    let mut reports = Vec::new();
    let mut suppress_scenarios = 0usize;

    for blueprint in &fixture.blueprints {
        let turns: Vec<TurnInput> = blueprint
            .turns
            .iter()
            .enumerate()
            .map(|(index, turn)| TurnInput {
                role: turn.role.clone(),
                text: turn.text.clone(),
                evidence_key: format!("{}:{}", blueprint.id, index),
                turn_index: index as i64,
                completeness: "complete".to_string(),
            })
            .collect();
        let result = extract(blueprint.repository.as_deref(), &turns);
        // Propositions retired by a later correction are not active candidates.
        let retired: HashSet<&str> = result
            .proposals
            .iter()
            .flat_map(|proposal| proposal.retires.iter().map(String::as_str))
            .collect();
        let active: Vec<&Proposal> = result
            .proposals
            .iter()
            .filter(|proposal| !retired.contains(proposal.topic_key.as_str()))
            .collect();
        let mut matched_extracted = 0usize;
        let mut failures = Vec::new();
        for proposal in &active {
            total_extracted += 1;
            let matched = blueprint
                .expected
                .iter()
                .any(|expected| matches_expected(proposal, expected));
            if matched {
                matched_extracted += 1;
                total_matched_extracted += 1;
            } else {
                failures.push(format!(
                    "unexpected {}: {}",
                    proposal.kind,
                    proposal.content.chars().take(120).collect::<String>()
                ));
            }
            for forbidden in &blueprint.forbidden {
                if matches(&proposal.content, &forbidden.anchors) {
                    forbidden_hits += 1;
                    failures.push(format!("forbidden content: {}", proposal.content));
                }
            }
            if proposal.scope == "global"
                && !blueprint
                    .expected
                    .iter()
                    .any(|expected| expected.scope.as_deref() == Some("global"))
            {
                false_globals += 1;
                failures.push(format!("false global promotion: {}", proposal.content));
            }
        }
        if blueprint.suppress {
            suppress_scenarios += 1;
        }
        // Suppressed propositions must be extracted here and are then denied
        // retention by the store-level suppression test.
        let matched_expected = blueprint
            .expected
            .iter()
            .filter(|expected| {
                active
                    .iter()
                    .any(|proposal| matches_expected(proposal, expected))
            })
            .count();
        if matched_expected < blueprint.expected.len() {
            for expected in &blueprint.expected {
                if !active
                    .iter()
                    .any(|proposal| matches_expected(proposal, expected))
                {
                    failures.push(format!(
                        "missed {}: {}",
                        expected.kind.clone().unwrap_or_else(|| "?".to_string()),
                        expected.anchors.join(" ")
                    ));
                }
            }
        }
        if !failures.is_empty() && !blueprint.critical.is_empty() {
            critical_failures += failures.len();
        }
        total_expected += blueprint.expected.len();
        total_matched_expected += matched_expected;
        reports.push(BlueprintReport {
            id: blueprint.id.clone(),
            extracted: active.len(),
            matched_extracted,
            expected_total: blueprint.expected.len(),
            matched_expected,
            forbidden_hits: blueprint
                .forbidden
                .iter()
                .filter(|forbidden| {
                    active
                        .iter()
                        .any(|proposal| matches(&proposal.content, &forbidden.anchors))
                })
                .count(),
            false_global: active
                .iter()
                .filter(|proposal| {
                    proposal.scope == "global"
                        && !blueprint
                            .expected
                            .iter()
                            .any(|expected| expected.scope.as_deref() == Some("global"))
                })
                .count(),
            unresolved: result.unresolved,
            critical: blueprint.critical.clone(),
            failures,
        });
    }

    let precision = if total_extracted == 0 {
        1.0
    } else {
        total_matched_extracted as f64 / total_extracted as f64
    };
    let recall = if total_expected == 0 {
        1.0
    } else {
        total_matched_expected as f64 / total_expected as f64
    };
    eprintln!(
        "extraction quality: blueprints={} extracted={} precision={precision:.4} expected={} recall={recall:.4} forbidden={forbidden_hits} false_global={false_globals} suppress={suppress_scenarios} critical_failures={critical_failures}",
        fixture.blueprints.len(),
        total_extracted,
        total_expected,
    );
    for report in reports
        .iter()
        .filter(|report| !report.failures.is_empty())
        .take(25)
    {
        eprintln!(
            "  {}: extracted={} matched={} expected={}/{} unresolved={} forbidden={} falseGlobal={} critical={:?}",
            report.id,
            report.extracted,
            report.matched_extracted,
            report.matched_expected,
            report.expected_total,
            report.unresolved,
            report.forbidden_hits,
            report.false_global,
            report.critical
        );
        for failure in report.failures.iter().take(4) {
            eprintln!("      {failure}");
        }
    }
    assert!(
        fixture.blueprints.len() >= 120,
        "at least 120 independent scenarios"
    );
    assert!(
        precision >= PRECISION_GATE,
        "precision {precision:.4} below {PRECISION_GATE}"
    );
    assert!(
        recall >= RECALL_GATE,
        "recall {recall:.4} below {RECALL_GATE}"
    );
    assert_eq!(forbidden_hits, 0, "forbidden content was extracted");
    assert_eq!(false_globals, 0, "false global promotions");
}
