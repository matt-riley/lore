//! Canonical operation registry loaded from the checked-in capability
//! catalog. One namespace serves canonical names and aliases; planned
//! operations fail explicitly instead of silently dispatching elsewhere.

use std::sync::LazyLock;

use serde::{Deserialize, Serialize};

const CATALOG: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../clients/capability-catalog.json"
));

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryRow {
    pub name: String,
    pub aliases: Vec<String>,
    pub support: String,
    pub mutability: String,
    pub route: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Catalog {
    rows: Vec<RegistryRow>,
}

static ROWS: LazyLock<Vec<RegistryRow>> = LazyLock::new(|| {
    let catalog: Catalog = serde_json::from_str(CATALOG).expect("capability catalog parses");
    catalog.rows
});

pub fn rows() -> &'static [RegistryRow] {
    &ROWS
}

/// Resolve a canonical name or alias to its registry row.
pub fn resolve(name: &str) -> Option<&'static RegistryRow> {
    ROWS.iter()
        .find(|row| row.name == name || row.aliases.iter().any(|alias| alias == name))
}

/// Daemon route for an implemented operation, or an explicit failure.
pub fn route_for(name: &str) -> Result<(&'static RegistryRow, &'static str), String> {
    let row = resolve(name).ok_or_else(|| format!("unknown operation: {name}"))?;
    if row.support != "implemented" {
        return Err(format!(
            "unimplemented operation: {} is planned in the v2 daemon",
            row.name
        ));
    }
    let route = row
        .route
        .as_deref()
        .ok_or_else(|| format!("operation {} has no route", row.name))?;
    Ok((row, route))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_loads_and_aliases_resolve() {
        assert_eq!(rows().len(), 27);
        assert_eq!(
            resolve("lore_save").map(|row| row.name.as_str()),
            Some("lore_retain")
        );
        assert_eq!(
            resolve("memory_save").map(|row| row.name.as_str()),
            Some("lore_retain")
        );
        assert_eq!(
            resolve("memory_status").map(|row| row.name.as_str()),
            Some("lore_status")
        );
        assert!(resolve("not_a_tool").is_none());
    }

    #[test]
    fn planned_operations_fail_explicitly() {
        let error = route_for("lore_repair").expect_err("planned");
        assert!(error.contains("unimplemented"), "{error}");
        let (row, route) = route_for("memory_forget").expect("alias");
        assert_eq!(row.name, "lore_forget");
        assert_eq!(route, "/v2/forget");
    }
}
