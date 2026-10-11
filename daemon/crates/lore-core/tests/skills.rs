//! Skill validation: a walk cut short by a limit must never read as a clean pass.

use std::fs;
use std::path::Path;

use lore_core::skills::validate;

fn skill(root: &Path, relative: &str, name: &str) {
    let directory = root.join(relative);
    fs::create_dir_all(&directory).expect("skill directory");
    fs::write(
        directory.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: test skill\n---\n\nBody text.\n"),
    )
    .expect("write SKILL.md");
}

fn incomplete(result: &lore_core::skills::SkillValidation) -> bool {
    result.skills.iter().any(|report| {
        report
            .issues
            .iter()
            .any(|issue| issue.contains("traversal incomplete"))
    })
}

#[test]
fn complete_walk_of_valid_skills_is_ok() {
    let dir = tempfile::tempdir().expect("tempdir");
    skill(dir.path(), "alpha", "alpha");
    skill(dir.path(), "beta", "beta");
    let result = validate(&[dir.path().display().to_string()]);
    assert!(result.ok, "{result:?}");
    assert_eq!(result.scanned, 2);
    assert!(!incomplete(&result), "{result:?}");
}

#[test]
fn walk_stopped_by_the_file_limit_is_not_ok() {
    let dir = tempfile::tempdir().expect("tempdir");
    for index in 0..201 {
        let name = format!("skill-{index:03}");
        skill(dir.path(), &name, &name);
    }
    let result = validate(&[dir.path().display().to_string()]);
    assert!(!result.ok, "{result:?}");
    assert!(incomplete(&result), "{result:?}");
}

#[test]
fn walk_stopped_by_the_depth_limit_is_not_ok() {
    let dir = tempfile::tempdir().expect("tempdir");
    // Five directories below the root: the skill sits deeper than the walk reads.
    skill(dir.path(), "a/b/c/d/e", "too-deep");
    let result = validate(&[dir.path().display().to_string()]);
    assert!(!result.ok, "{result:?}");
    assert!(incomplete(&result), "{result:?}");
}
