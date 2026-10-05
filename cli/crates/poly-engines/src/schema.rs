//! JSON Schema validation of the YAML and TOML files that name their schema.
//!
//! The schema comes from the file or from poly.toml and never from a guess: the
//! directive the two editor extensions for these languages already read --
//! `# yaml-language-server: $schema=` (redhat.vscode-yaml) and `#:schema`
//! (taplo, which is even-better-toml) -- or a `[lint.schemas]` glob. The
//! SchemaStore catalog is deliberately not consulted. Over the 1,329 YAML and
//! TOML files of the measured corpus its file patterns attached a schema to 569,
//! and 106 of those were the wrong file: one pattern, `**/scenarios/*/*.yaml`,
//! claimed 104 QA fixtures for a security tool. A file that names its own schema
//! cannot be the wrong file.
//!
//! Validation is the `jsonschema` crate's, draft 4 through 2020-12. poly's part is
//! the two conversions around it: the file into the JSON value it checks, and
//! each error's JSON pointer back into a line and column.

use std::collections::HashMap;
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use anyhow::{anyhow, Context, Result};
use jsonschema::error::ValidationErrorKind;
use jsonschema::paths::LocationSegment;
use jsonschema::{Retrieve, Uri, ValidationError, Validator};
use poly_core::diag::{severity_of, Issue, Reported};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::workflow::{Node, Value as Yaml};

/// GET one schema over HTTP(S), as text.
///
/// Passed in rather than called: the network, its timeout and its cache are
/// poly-tools', and this crate links engines and nothing that talks to a server.
pub type Fetch = fn(&str) -> Result<String>;

/// The languages a file can name a schema in.
pub fn applies(lang: &str) -> bool {
    matches!(lang, "yaml" | "toml")
}

/// Validate `text` against the schema it names, or the ones poly.toml maps it to.
///
/// `None` when no schema applies, which is not the same answer as "valid": the
/// caller counts the files that were checked, and a file nobody named a schema
/// for was not one of them. `mapped` is poly.toml's answer for this path,
/// already resolved to URLs and absolute paths (`Config::lint_schemas`).
///
/// A schema that cannot be read or compiled is an error rather than a clean
/// result, so `poly check` exits as "could not check" instead of passing a file
/// it never looked at.
pub fn lint(
    lang: &str,
    path: &Path,
    text: &str,
    mapped: &[String],
    fetch: Fetch,
) -> Result<Option<Vec<Issue>>> {
    if !applies(lang) {
        return Ok(None);
    }
    let yaml = lang == "yaml";
    // The file's own line beats poly.toml: it is the narrower statement, and it
    // is the one the editor extensions honour as well.
    let schemas = match directive(yaml, path, text) {
        Some(schema) => vec![schema],
        None => mapped.to_vec(),
    };
    if schemas.is_empty() {
        return Ok(None);
    }
    // A file that does not parse has no value to check. TOML's syntax error is
    // `toml/syntax` already and YAML's is `poly fmt`'s, so a schema finding
    // about it would be poly saying it twice.
    let Some(documents) = (if yaml {
        yaml_documents(text)
    } else {
        toml_document(text)
    }) else {
        return Ok(Some(Vec::new()));
    };
    let mut found = Vec::new();
    for schema in &schemas {
        let validator = validator(schema, fetch)?;
        // The code links to the schema when it is a page anyone can open.
        let url = remote(schema).then_some(schema.as_str());
        for document in &documents {
            let errors: Vec<_> = validator.iter_errors(&document.value).collect();
            let failed: Vec<Vec<Step>> = errors.iter().map(steps).collect();
            for (error, at) in errors.iter().zip(&failed) {
                found.extend(issues(text, document, error, at, &failed, url));
            }
        }
    }
    found.sort_by_key(|issue| (issue.line, issue.col, issue.code.clone()));
    Ok(Some(found))
}

// ── which schema ───────────────────────────────────────────────────────────

/// The schema the file names for itself, resolved: a URL as written, a relative
/// path against the file's directory -- which is how both extensions read one.
fn directive(yaml: bool, path: &Path, text: &str) -> Option<String> {
    let named = text.lines().find_map(|line| {
        let line = line.trim_start();
        if yaml {
            let rest = line
                .strip_prefix('#')?
                .trim_start()
                .strip_prefix("yaml-language-server:")?;
            Some(rest.split_once("$schema=")?.1.split_whitespace().next()?)
        } else {
            Some(line.strip_prefix("#:schema")?.trim())
        }
    })?;
    if named.is_empty() {
        return None;
    }
    if named.contains("://") {
        return Some(named.to_string());
    }
    let dir = path.parent().unwrap_or(Path::new("."));
    Some(dir.join(named).to_string_lossy().into_owned())
}

fn remote(schema: &str) -> bool {
    schema.starts_with("https://") || schema.starts_with("http://")
}

/// The file a schema location names, or `None` for one only the network has.
fn local(schema: &str) -> Option<PathBuf> {
    if remote(schema) {
        return None;
    }
    if schema.starts_with("file:") {
        return url::Url::parse(schema).ok()?.to_file_path().ok();
    }
    Some(PathBuf::from(schema))
}

// ── building validators ────────────────────────────────────────────────────

enum Built {
    Ready(Arc<Validator>),
    Failed(String, Instant),
}

/// How long a schema that failed to load is believed to still be failing.
///
/// Long enough that a dead URL costs `poly check` one timeout rather than one per
/// file; short enough that the daemon, which lives for a whole session, picks the
/// schema up once the network is back.
const RETRY_AFTER: Duration = Duration::from_secs(60);

/// The validator for `schema`, built once per process.
///
/// Building one means fetching the schema and every schema it `$ref`s, and one
/// run lints many files against few schemas. A local schema is keyed by its
/// modification time too, so editing it takes effect at the next lint rather
/// than at the next daemon restart.
///
/// ponytail: one lock for every schema, held while one is built; per-schema
/// cells if a slow fetch ever holds up files that name a different schema.
fn validator(schema: &str, fetch: Fetch) -> Result<Arc<Validator>> {
    static BUILT: OnceLock<Mutex<HashMap<String, Built>>> = OnceLock::new();
    let key = match local(schema) {
        Some(path) => {
            let modified = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
            format!("{schema}@{:?}", modified.unwrap_or(SystemTime::UNIX_EPOCH))
        }
        None => schema.to_string(),
    };
    let mut built = BUILT
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match built.get(&key) {
        Some(Built::Ready(validator)) => return Ok(Arc::clone(validator)),
        Some(Built::Failed(why, at)) if at.elapsed() < RETRY_AFTER => return Err(anyhow!("{why}")),
        _ => {}
    }
    match build(schema, fetch) {
        Ok(validator) => {
            let validator = Arc::new(validator);
            built.insert(key, Built::Ready(Arc::clone(&validator)));
            Ok(validator)
        }
        Err(error) => {
            let why = format!("{error:#}");
            built.insert(key, Built::Failed(why.clone(), Instant::now()));
            Err(anyhow!(why))
        }
    }
}

fn build(schema: &str, fetch: Fetch) -> Result<Validator> {
    let (document, base) = match local(schema) {
        Some(path) => {
            let path =
                std::path::absolute(&path).with_context(|| format!("schema {}", path.display()))?;
            // The base a relative `$ref` inside a local schema resolves against.
            let base = url::Url::from_file_path(&path)
                .map_err(|()| anyhow!("schema {} is not an absolute path", path.display()))?;
            let text = std::fs::read_to_string(&path)
                .with_context(|| format!("reading schema {}", path.display()))?;
            (parse_schema(&text, schema)?, base.to_string())
        }
        None => (parse_schema(&fetch(schema)?, schema)?, schema.to_string()),
    };
    jsonschema::options()
        .with_retriever(Retriever(fetch))
        .with_base_uri(base)
        .build(&document)
        .map_err(|error| anyhow!("schema {schema}: {error}"))
}

/// A schema is JSON, except when it is YAML: redhat.vscode-yaml accepts both,
/// and some catalogs publish the YAML one.
fn parse_schema(text: &str, schema: &str) -> Result<Value> {
    let text = text.trim_start_matches('\u{feff}');
    if let Ok(value) = serde_json::from_str(text) {
        return Ok(value);
    }
    serde_yaml::from_str::<serde_yaml::Value>(text)
        .map(from_yaml)
        .map_err(|_| anyhow!("schema {schema} is neither JSON nor YAML"))
}

/// Where a `$ref` to another document is read from: the same two places the
/// schema that holds it could have come from.
struct Retriever(Fetch);

impl Retrieve for Retriever {
    fn retrieve(
        &self,
        uri: &Uri<String>,
    ) -> Result<Value, Box<dyn std::error::Error + Send + Sync>> {
        let uri = uri.as_str();
        let text = match local(uri) {
            Some(path) => std::fs::read_to_string(&path)
                .with_context(|| format!("reading schema {}", path.display()))?,
            None => (self.0)(uri)?,
        };
        Ok(parse_schema(&text, uri)?)
    }
}

// ── the instance ───────────────────────────────────────────────────────────

/// One document's value as the schema sees it, and the tree that says where in
/// the text each part of it was written.
struct Document<'t> {
    value: Value,
    tree: Tree<'t>,
}

enum Tree<'t> {
    Yaml(Option<Node>),
    Toml(toml_edit::ImDocument<&'t str>),
}

/// Every non-empty document, or `None` if the stream does not parse.
///
/// Two readings of one text: serde_yaml for the value, because it is the one
/// that knows `1` from `"1"` and resolves `<<: *defaults`, and `yaml_parser` for
/// where things are, which serde_yaml does not keep.
fn yaml_documents(text: &str) -> Option<Vec<Document<'static>>> {
    let mut trees = crate::workflow::documents(text).into_iter();
    let mut documents = Vec::new();
    for deserializer in serde_yaml::Deserializer::from_str(text) {
        let mut value = serde_yaml::Value::deserialize(deserializer).ok()?;
        let tree = trees.next().flatten();
        // The schema describes the merged mapping, which is what the program
        // reading the file sees.
        value.apply_merge().ok()?;
        // An empty document is not an instance anybody wrote.
        if !value.is_null() {
            documents.push(Document {
                value: from_yaml(value),
                tree: Tree::Yaml(tree),
            });
        }
    }
    Some(documents)
}

fn from_yaml(value: serde_yaml::Value) -> Value {
    use serde_yaml::Value as Y;
    match value {
        Y::Null => Value::Null,
        Y::Bool(b) => Value::Bool(b),
        Y::Number(n) => {
            if let Some(i) = n.as_i64() {
                json!(i)
            } else if let Some(u) = n.as_u64() {
                json!(u)
            } else {
                n.as_f64()
                    .and_then(serde_json::Number::from_f64)
                    .map_or_else(|| Value::String(n.to_string()), Value::Number)
            }
        }
        Y::String(s) => Value::String(s),
        Y::Sequence(items) => Value::Array(items.into_iter().map(from_yaml).collect()),
        Y::Mapping(entries) => Value::Object(
            entries
                .into_iter()
                .map(|(k, v)| (yaml_key(k), from_yaml(v)))
                .collect(),
        ),
        // `!Ref` and friends are the reading program's business; the schema
        // describes the value under the tag.
        Y::Tagged(tagged) => from_yaml(tagged.value),
    }
}

/// A JSON key is a string, and a YAML one is whatever was written: `200:` in an
/// OpenAPI `responses` map is the key "200" to every schema that describes it.
fn yaml_key(key: serde_yaml::Value) -> String {
    use serde_yaml::Value as Y;
    match key {
        Y::String(s) => s,
        Y::Null => "null".to_string(),
        Y::Bool(b) => b.to_string(),
        Y::Number(n) => n.to_string(),
        other => serde_yaml::to_string(&other)
            .unwrap_or_default()
            .trim()
            .to_string(),
    }
}

fn toml_document(text: &str) -> Option<Vec<Document<'_>>> {
    let tree = toml_edit::ImDocument::parse(text).ok()?;
    let value = toml_table(tree.as_table());
    Some(vec![Document {
        value,
        tree: Tree::Toml(tree),
    }])
}

fn toml_table(table: &toml_edit::Table) -> Value {
    Value::Object(
        table
            .iter()
            .map(|(key, item)| (key.to_string(), toml_item(item)))
            .collect(),
    )
}

fn toml_item(item: &toml_edit::Item) -> Value {
    match item {
        toml_edit::Item::None => Value::Null,
        toml_edit::Item::Value(value) => toml_value(value),
        toml_edit::Item::Table(table) => toml_table(table),
        toml_edit::Item::ArrayOfTables(tables) => {
            Value::Array(tables.iter().map(toml_table).collect())
        }
    }
}

fn toml_value(value: &toml_edit::Value) -> Value {
    use toml_edit::Value as T;
    match value {
        T::String(s) => Value::String(s.value().clone()),
        T::Integer(i) => json!(*i.value()),
        // JSON has no NaN or infinity, so those reach the schema as the text
        // TOML spells them with.
        T::Float(f) => serde_json::Number::from_f64(*f.value())
            .map_or_else(|| Value::String(f.value().to_string()), Value::Number),
        T::Boolean(b) => Value::Bool(*b.value()),
        // The RFC 3339 text, which is what `"format": "date-time"` describes;
        // taplo hands its schemas the same string.
        T::Datetime(d) => Value::String(d.value().to_string()),
        T::Array(items) => Value::Array(items.iter().map(toml_value).collect()),
        T::InlineTable(table) => Value::Object(
            table
                .iter()
                .map(|(key, value)| (key.to_string(), toml_value(value)))
                .collect(),
        ),
    }
}

// ── where a finding goes ───────────────────────────────────────────────────

#[derive(Clone, PartialEq)]
enum Step {
    Key(String),
    Index(usize),
}

/// Where a pointer led: the key the value sits under, the value, whether the
/// value holds others, and whether the walk got all the way there.
///
/// The walk can stop short, and then the deepest node it did reach stands in:
/// a key that came from `<<: *defaults` is in the value but written nowhere in
/// the mapping that inherited it.
#[derive(Default)]
struct Place {
    key: Option<Range<usize>>,
    value: Option<Range<usize>>,
    container: bool,
    reached: bool,
}

impl Place {
    /// The range a finding is drawn on.
    ///
    /// A value that holds others is reported at its key: "`name` is required"
    /// underlining the first line of the mapping points at an unrelated key, and
    /// the whole mapping is most of the screen. A scalar is reported where it is,
    /// because the value is what is wrong. `at_key` is for the defect that is
    /// the key itself.
    fn anchor(self, at_key: bool) -> Range<usize> {
        let preferred = if at_key || self.container || !self.reached {
            self.key.or(self.value)
        } else {
            self.value.or(self.key)
        };
        preferred.unwrap_or(0..0)
    }
}

fn place(document: &Document, steps: &[Step]) -> Place {
    match &document.tree {
        Tree::Yaml(Some(root)) => yaml_place(root, steps),
        Tree::Yaml(None) => Place::default(),
        Tree::Toml(tree) => toml_place(tree.as_table(), steps),
    }
}

fn yaml_place(root: &Node, steps: &[Step]) -> Place {
    let mut node = root;
    let mut key = None;
    for step in steps {
        let next = match (step, &node.value) {
            (Step::Key(name), Yaml::Map(entries)) => entries
                .iter()
                .find(|(k, _)| k.str() == Some(name.as_str()))
                .map(|(k, v)| (Some(k.at..k.end), v)),
            (Step::Index(i), Yaml::Seq(items)) => items.get(*i).map(|item| (None, item)),
            _ => None,
        };
        let Some((next_key, next)) = next else {
            return Place {
                key,
                value: Some(node.at..node.end),
                container: true,
                reached: false,
            };
        };
        key = next_key;
        node = next;
    }
    Place {
        key,
        value: Some(node.at..node.end),
        container: matches!(node.value, Yaml::Map(_) | Yaml::Seq(_)),
        reached: true,
    }
}

#[derive(Clone, Copy)]
enum TomlAt<'a> {
    Table(&'a toml_edit::Table),
    Tables(&'a toml_edit::ArrayOfTables),
    Value(&'a toml_edit::Value),
}

impl<'a> TomlAt<'a> {
    fn of(item: &'a toml_edit::Item) -> Option<TomlAt<'a>> {
        match item {
            toml_edit::Item::None => None,
            toml_edit::Item::Value(value) => Some(TomlAt::Value(value)),
            toml_edit::Item::Table(table) => Some(TomlAt::Table(table)),
            toml_edit::Item::ArrayOfTables(tables) => Some(TomlAt::Tables(tables)),
        }
    }

    /// `None` for a table nobody wrote a header for: `[a.b]` alone creates an
    /// `a` that exists only implicitly.
    fn span(self) -> Option<Range<usize>> {
        match self {
            TomlAt::Table(table) => table.span(),
            TomlAt::Tables(tables) => tables.span(),
            TomlAt::Value(value) => value.span(),
        }
    }

    fn container(self) -> bool {
        !matches!(
            self,
            TomlAt::Value(value) if !value.is_array() && !value.is_inline_table()
        )
    }

    fn step(self, step: &Step) -> Option<(Option<Range<usize>>, TomlAt<'a>)> {
        match (self, step) {
            (TomlAt::Table(table), Step::Key(name)) => Some((
                table.key(name).and_then(toml_edit::Key::span),
                TomlAt::of(table.get(name)?)?,
            )),
            (TomlAt::Tables(tables), Step::Index(i)) => {
                Some((None, TomlAt::Table(tables.get(*i)?)))
            }
            (TomlAt::Value(toml_edit::Value::InlineTable(table)), Step::Key(name)) => Some((
                table.key(name).and_then(toml_edit::Key::span),
                TomlAt::Value(table.get(name)?),
            )),
            (TomlAt::Value(toml_edit::Value::Array(items)), Step::Index(i)) => {
                Some((None, TomlAt::Value(items.get(*i)?)))
            }
            _ => None,
        }
    }
}

fn toml_place(root: &toml_edit::Table, steps: &[Step]) -> Place {
    let mut at = TomlAt::Table(root);
    let mut key = None;
    // The nearest position the walk has seen, for a table that has none of its
    // own because only `[a.b]` was ever written.
    let mut seen = None;
    for step in steps {
        let Some((next_key, next)) = at.step(step) else {
            return Place {
                key: key.or(seen.clone()),
                value: at.span().or(seen),
                container: true,
                reached: false,
            };
        };
        key = next_key;
        at = next;
        seen = key.clone().or(at.span()).or(seen);
    }
    Place {
        key: key.or(seen.clone()),
        value: at.span().or(seen),
        container: at.container(),
        reached: true,
    }
}

// ── findings ───────────────────────────────────────────────────────────────

fn steps(error: &ValidationError) -> Vec<Step> {
    error
        .instance_path()
        .iter()
        .map(|segment| match segment {
            LocationSegment::Property(name) => Step::Key(name.into_owned()),
            LocationSegment::Index(i) => Step::Index(i),
        })
        .collect()
}

/// `failed` is every error's location in the same document, so an unevaluated
/// key can be told apart from a defined key whose value failed.
fn issues(
    text: &str,
    document: &Document,
    error: &ValidationError,
    steps: &[Step],
    failed: &[Vec<Step>],
    url: Option<&str>,
) -> Vec<Issue> {
    let code = error.kind().keyword();
    // The pointer of an unexpected key names the mapping that holds it, so the
    // key itself is looked up here -- one finding on each, the way a misspelt
    // key is read and fixed.
    let (what, unexpected) = match error.kind() {
        ValidationErrorKind::AdditionalProperties { unexpected } => ("Additional", unexpected),
        ValidationErrorKind::UnevaluatedProperties { unexpected } => ("Unevaluated", unexpected),
        _ => {
            let at = place(document, steps).anchor(false);
            return vec![issue(text, at, code, error.to_string(), url)];
        }
    };
    unexpected
        .iter()
        .filter_map(|name| {
            let mut steps = steps.to_vec();
            steps.push(Step::Key(name.clone()));
            // A failed subschema keeps no annotations, so a key the schema does
            // define counts as unevaluated once its value is wrong: compose's
            // `image: 42` came out as "'image' was unexpected" beside the type
            // error that is the real one.
            if what == "Unevaluated" && failed.iter().any(|f| f.starts_with(&steps)) {
                return None;
            }
            let at = place(document, &steps).anchor(true);
            let message = format!("{what} properties are not allowed ('{name}' was unexpected)");
            Some(issue(text, at, code, message, url))
        })
        .collect()
}

/// One finding, clamped to the line it starts on for the reason
/// `workflow::issue` clamps: a mapping is one range covering most of the file.
fn issue(text: &str, range: Range<usize>, code: &str, message: String, url: Option<&str>) -> Issue {
    let at = range.start.min(text.len());
    let (line, col) = crate::lint::line_col(text, at);
    let line_end = text
        .get(at..)
        .and_then(|rest| rest.find('\n'))
        .map_or(text.len(), |i| at + i);
    let end = if range.end > at && range.end <= line_end {
        range.end
    } else {
        line_end
    };
    let (end_line, end_col) = crate::lint::line_col(text, end);
    Issue {
        line,
        col,
        end_line,
        end_col,
        severity: severity_of("schema", Reported::Nothing),
        // The keyword that failed: `required`, `type`, `additionalProperties`.
        // Every schema shares that vocabulary, so `schema/required` in
        // `[lint] ignore` means the same thing whichever schema reported it.
        code: code.to_string(),
        message,
        source: "schema",
        fix: None,
        url: url.map(str::to_string),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_network(url: &str) -> Result<String> {
        Err(anyhow!("no network in tests: {url}"))
    }

    const SCHEMA: &str = r#"{
        "type": "object",
        "required": ["name"],
        "additionalProperties": false,
        "properties": {
            "name": {"type": "string"},
            "port": {"type": "integer"},
            "jobs": {"type": "object", "additionalProperties": {
                "type": "object", "required": ["run"],
                "properties": {"run": {"type": "string"}, "retries": {"type": "integer"}},
                "additionalProperties": false
            }}
        }
    }"#;

    /// A directory holding `schema.json`, and the path of a file beside it.
    fn fixture(file: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("schema.json"), SCHEMA).unwrap();
        let path = dir.path().join(file);
        (dir, path)
    }

    fn found(lang: &str, path: &Path, text: &str, mapped: &[String]) -> Vec<(u32, u32, String)> {
        lint(lang, path, text, mapped, no_network)
            .unwrap()
            .expect("a schema applies")
            .into_iter()
            .map(|issue| (issue.line, issue.col, issue.code))
            .collect()
    }

    /// The directive is what makes a file checkable at all: without one, and
    /// without a poly.toml mapping, the answer is "not checked" rather than
    /// "valid" -- the coverage row counts the difference.
    #[test]
    fn a_file_that_names_no_schema_is_not_checked() {
        let (_dir, path) = fixture("app.yaml");
        assert!(lint("yaml", &path, "name: 1\n", &[], no_network)
            .unwrap()
            .is_none());
        assert!(
            lint("json", &path, "{}", &["schema.json".into()], no_network)
                .unwrap()
                .is_none()
        );
    }

    /// Each finding lands where a person would fix it: the misspelt key, the
    /// value of the wrong type, and the key of the mapping missing a field --
    /// not the first line of the file, which is where a pointer-less report
    /// would put all three.
    #[test]
    fn yaml_findings_land_on_the_offending_text() {
        let (_dir, path) = fixture("app.yaml");
        let text = "\
# yaml-language-server: $schema=./schema.json
name: app
prot: 8080
jobs:
  build:
    retries: two
";
        assert_eq!(
            found("yaml", &path, text, &[]),
            vec![
                (2, 0, "additionalProperties".into()),
                (4, 2, "required".into()),
                (5, 13, "type".into()),
            ]
        );
    }

    #[test]
    fn toml_findings_land_on_the_offending_text() {
        let (_dir, path) = fixture("app.toml");
        let text = "\
#:schema ./schema.json
name = 'app'
port = '8080'

[jobs.build]
run = 'make'
retry = 3
";
        assert_eq!(
            found("toml", &path, text, &[]),
            vec![(2, 7, "type".into()), (6, 0, "additionalProperties".into())]
        );
    }

    /// A required field missing from the document itself has no key to point
    /// at; the top of the file is the only honest place.
    #[test]
    fn a_missing_top_level_field_is_reported_at_the_start() {
        let (_dir, path) = fixture("app.toml");
        let text = "#:schema ./schema.json\nport = 1\n";
        assert_eq!(
            found("toml", &path, text, &[]),
            vec![(0, 0, "required".into())]
        );
    }

    /// A defined key with a wrong value is one defect, not two: the type error
    /// stays and the "unexpected" that unevaluatedProperties adds goes, while a
    /// key the schema never defined is still reported. The key is defined in a
    /// subschema because that is where the second report comes from -- the
    /// failed `allOf` branch takes its annotations with it.
    #[test]
    fn a_wrong_value_does_not_make_its_key_unexpected() {
        let (dir, path) = fixture("compose.yaml");
        std::fs::write(
            dir.path().join("strict.json"),
            r#"{"allOf": [{"properties": {"image": {"type": "string"}}}],
                "unevaluatedProperties": false}"#,
        )
        .unwrap();
        let text = "# yaml-language-server: $schema=strict.json\nimage: 42\nextra: 1\n";
        assert_eq!(
            found("yaml", &path, text, &[]),
            vec![
                (1, 7, "type".into()),
                (2, 0, "unevaluatedProperties".into())
            ]
        );
    }

    /// poly.toml's mapping applies when the file says nothing, and the file's
    /// own directive wins when it does: the narrower statement is the one that
    /// was meant for this file.
    #[test]
    fn the_directive_beats_the_mapping() {
        let (dir, path) = fixture("app.yaml");
        std::fs::write(dir.path().join("other.json"), r#"{"type": "array"}"#).unwrap();
        let mapped = [dir.path().join("other.json").to_string_lossy().into_owned()];
        assert_eq!(
            found("yaml", &path, "name: app\n", &mapped),
            vec![(0, 0, "type".into())]
        );
        let text = "# yaml-language-server: $schema=schema.json\nname: app\n";
        assert!(found("yaml", &path, text, &mapped).is_empty());
    }

    /// Every document of a stream is checked, and a finding in the second one
    /// lands in the second one.
    #[test]
    fn each_yaml_document_is_checked_where_it_is() {
        let (_dir, path) = fixture("app.yaml");
        let text = "\
# yaml-language-server: $schema=./schema.json
name: a
---
name: 2
";
        assert_eq!(found("yaml", &path, text, &[]), vec![(3, 6, "type".into())]);
    }

    /// `<<: *defaults` is how YAML spells inheritance, and the schema describes
    /// what the reading program sees -- the merged mapping, so an inherited
    /// field counts as present.
    #[test]
    fn merge_keys_are_resolved_before_checking() {
        let (_dir, path) = fixture("app.yaml");
        let text = "\
# yaml-language-server: $schema=./schema.json
name: app
jobs:
  base: &base
    run: make
  test:
    <<: *base
";
        assert!(found("yaml", &path, text, &[]).is_empty());
    }

    /// A relative `$ref` inside a local schema is read from beside that schema.
    #[test]
    fn a_local_schema_resolves_its_relative_refs() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("root.json"),
            r#"{"properties": {"port": {"$ref": "port.json"}}}"#,
        )
        .unwrap();
        std::fs::write(dir.path().join("port.json"), r#"{"type": "integer"}"#).unwrap();
        let path = dir.path().join("app.toml");
        let text = "#:schema root.json\nport = 'x'\n";
        assert_eq!(found("toml", &path, text, &[]), vec![(1, 7, "type".into())]);
    }

    /// A schema that cannot be read is "could not check", never "valid": an
    /// error, which `poly check` turns into exit 2.
    #[test]
    fn an_unreadable_schema_is_an_error() {
        let (_dir, path) = fixture("app.yaml");
        let text = "# yaml-language-server: $schema=https://example.invalid/s.json\nname: a\n";
        let error = lint("yaml", &path, text, &[], no_network).unwrap_err();
        assert!(
            format!("{error:#}").contains("example.invalid"),
            "{error:#}"
        );
        let text = "# yaml-language-server: $schema=missing.json\nname: a\n";
        assert!(lint("yaml", &path, text, &[], no_network).is_err());
    }

    /// A file that does not parse is somebody else's finding.
    #[test]
    fn an_unparsable_file_reports_nothing_here() {
        let (_dir, path) = fixture("app.toml");
        let text = "#:schema ./schema.json\nname = \n";
        assert_eq!(found("toml", &path, text, &[]), Vec::new());
    }
}
