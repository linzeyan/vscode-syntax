//! What kind of defect a rule reports, in one vocabulary for every language.
//!
//! The data is `catalog.toml`, compiled in, and its header explains what a
//! category is and which gates hold it up. This is the way in: one lookup for
//! the diagnostic path, and the whole table for the gates.

use std::collections::BTreeMap;
use std::sync::OnceLock;

/// The file itself, so the gate that checks its ordering can read what a
/// parsed `BTreeMap` no longer remembers.
pub const SOURCE: &str = include_str!("catalog.toml");

/// Every category, with the `tool/rule` ids in it.
///
/// Parsed once and panicking on a malformed file, because the file is compiled
/// into this binary: a catalog that does not parse is not a user's broken
/// config, it is poly shipped broken, and `the_catalog_is_ordered_and_unique`
/// is what stops that reaching a release.
pub fn catalog() -> &'static BTreeMap<String, Vec<String>> {
    static PARSED: OnceLock<BTreeMap<String, Vec<String>>> = OnceLock::new();
    PARSED.get_or_init(|| toml::from_str(SOURCE).expect("the compiled-in rule catalog parses"))
}

/// The category `source/code` belongs to, if it has one.
///
/// `None` is the ordinary answer for most upstream rules and not a failure:
/// ruff, clippy and eslint each have hundreds, a project can enable any of
/// them, and a hand-written entry per rule would be a second full rule set to
/// keep current -- the same drift `09 §2` refuses for detection itself. What
/// is categorized is what poly wrote plus the upstream rules poly replaced or
/// deliberately maps; the rest are named by `tool/rule`, which is what their
/// own documentation calls them anyway.
pub fn category_of(source: &str, code: &str) -> Option<&'static str> {
    let id = format!("{source}/{code}");
    if let Some(category) = find(&id) {
        return Some(category);
    }
    // hadolint's codes are not in the file: each takes the category of the
    // poly rule that replaced it, so a renamed rule cannot leave a hadolint
    // code pointing at a category nobody has.
    if source == "hadolint" {
        let (_, poly) = crate::HADOLINT_REPLACEMENTS
            .iter()
            .find(|(dl, _)| *dl == code)?;
        return find(&format!("poly/{poly}"));
    }
    None
}

fn find(id: &str) -> Option<&'static str> {
    static INDEX: OnceLock<BTreeMap<&'static str, &'static str>> = OnceLock::new();
    INDEX
        .get_or_init(|| {
            catalog()
                .iter()
                .flat_map(|(category, rules)| {
                    rules
                        .iter()
                        .map(move |rule| (rule.as_str(), category.as_str()))
                })
                .collect()
        })
        .get(id)
        .copied()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The file is sorted and says each thing once.
    ///
    /// Sorted because the whole point of one file for every language is reading
    /// it, and an unsorted list is one a reviewer cannot diff. Unique because a
    /// rule in two categories has no category: `category_of` would answer with
    /// whichever the index built last, and a `[lint]` line naming the other one
    /// would silently miss it.
    #[test]
    fn the_catalog_is_ordered_and_unique() {
        let keys: Vec<&str> = SOURCE
            .lines()
            .filter_map(|line| line.split_once(" = "))
            .map(|(key, _)| key)
            .filter(|key| !key.starts_with([' ', '#']))
            .collect();
        let mut sorted = keys.clone();
        sorted.sort_unstable();
        assert_eq!(keys, sorted, "categories are out of order");

        let mut seen: BTreeMap<&str, &str> = BTreeMap::new();
        for (category, rules) in catalog() {
            let mut sorted = rules.clone();
            sorted.sort();
            assert_eq!(rules, &sorted, "{category} lists its rules out of order");
            for rule in rules {
                assert!(
                    rule.split_once('/')
                        .is_some_and(|(t, r)| !t.is_empty() && !r.is_empty()),
                    "{rule} is not a tool/rule id"
                );
                if let Some(first) = seen.insert(rule, category) {
                    panic!("{rule} is in both {first} and {category}");
                }
            }
        }
    }

    /// hadolint's codes reach a category without being written down.
    #[test]
    fn a_hadolint_code_borrows_the_category_of_the_rule_that_replaced_it() {
        assert_eq!(
            category_of("hadolint", "DL3008"),
            category_of("poly", "docker-apt-get-unpinned")
        );
        assert_eq!(category_of("hadolint", "DL9999"), None);
        // Nothing is claimed about the rules poly never replaced.
        assert_eq!(category_of("ruff", "F401"), None);
    }
}
