//! Lexical retrieval helpers: safe FTS terms and deterministic rendering.

mod stopwords;

use stopwords::STOPWORDS;

/// Maximum number of MATCH terms derived from one query.
pub const MAX_TERMS: usize = 32;
/// Minimum token length that receives a prefix match. Three lets paraphrase
/// pairs such as key/keys and rotate/rotating meet the same term.
pub const PREFIX_LENGTH: usize = 3;

/// Normalize a query into safe, deduplicated terms.
///
/// The result is data, never FTS syntax: tokenization drops punctuation and
/// the caller quotes every term before it reaches SQLite.
pub fn extract_terms(query: &str) -> Vec<String> {
    let mut terms: Vec<String> = Vec::new();
    for raw in query.split(|character: char| !character.is_alphanumeric()) {
        let term = raw.to_lowercase();
        let length = term.chars().count();
        if length < 2 || STOPWORDS.binary_search(&term.as_str()).is_ok() {
            continue;
        }
        if !terms.iter().any(|existing| existing == &term) {
            terms.push(term);
        }
        if terms.len() >= MAX_TERMS {
            break;
        }
    }
    terms
}

/// Build a bound FTS5 MATCH value from safe terms.
pub fn fts_query(terms: &[String]) -> String {
    terms
        .iter()
        .map(|term| {
            let escaped = term.replace('"', "\"\"");
            if term.chars().count() >= PREFIX_LENGTH {
                format!("\"{escaped}\"*")
            } else {
                format!("\"{escaped}\"")
            }
        })
        .collect::<Vec<_>>()
        .join(" AND ")
}

/// Matches v1's OR retry when the strict AND query finds nothing.
pub fn fts_query_or(terms: &[String]) -> String {
    terms
        .iter()
        .map(|term| {
            let escaped = term.replace('"', "\"\"");
            if term.chars().count() >= PREFIX_LENGTH {
                format!("\"{escaped}\"*")
            } else {
                format!("\"{escaped}\"")
            }
        })
        .collect::<Vec<_>>()
        .join(" OR ")
}

/// Render a deterministic topical section within a byte budget.
///
/// Rows are taken in final ranking order; the first row that does not fit
/// stops rendering and the remainder are reported as omitted. Whole rows are
/// never split.
pub fn render_topical(contents: &[String], budget: usize) -> (String, usize, usize) {
    let mut rendered = String::new();
    let mut used = 0usize;
    let mut included = 0usize;
    for content in contents {
        let line = format!("- {content}");
        let cost = line.len() + usize::from(!rendered.is_empty());
        if used + cost > budget {
            break;
        }
        if !rendered.is_empty() {
            rendered.push('\n');
            used += 1;
        }
        rendered.push_str(&line);
        used += line.len();
        included += 1;
    }
    (rendered, included, contents.len() - included)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenization_drops_syntax_and_stopwords() {
        let terms = extract_terms("What's the \"status\" of memory? NEAR/2 OR *");
        assert!(terms.contains(&"status".to_string()));
        assert!(terms.contains(&"memory".to_string()));
        assert!(!terms.contains(&"the".to_string()));
        assert!(!terms.contains(&"or".to_string()));
        assert!(!terms.iter().any(|term| term.contains('"')));
    }

    #[test]
    fn scaffolding_only_queries_have_no_terms() {
        assert!(extract_terms("what is the and of how").is_empty());
        assert!(extract_terms("   ").is_empty());
    }

    #[test]
    fn unicode_identifiers_survive_tokenization() {
        let terms = extract_terms("naïve café 東京 lore_recall");
        assert!(terms.contains(&"naïve".to_string()));
        assert!(terms.contains(&"café".to_string()));
        assert!(terms.contains(&"東京".to_string()));
        assert!(terms.contains(&"lore".to_string()));
        assert!(terms.contains(&"recall".to_string()));
    }

    #[test]
    fn fts_terms_are_quoted_and_prefixed() {
        assert_eq!(
            fts_query(&["sql".to_string(), "memory".to_string()]),
            "\"sql\"* AND \"memory\"*"
        );
        assert_eq!(fts_query(&["a\"b".to_string()]), "\"a\"\"b\"*");
    }

    #[test]
    fn rendering_never_splits_a_row() {
        let contents = vec!["first".to_string(), "x".repeat(64), "third".to_string()];
        let (text, included, omitted) = render_topical(&contents, 24);
        assert_eq!(included, 1);
        assert_eq!(omitted, 2);
        assert_eq!(text, "- first");
    }
}
