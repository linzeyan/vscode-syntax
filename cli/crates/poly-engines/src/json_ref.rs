//! `$ref`: where a JSON Reference in a JSON or YAML file leads.
//!
//! One reading for two questions, so their answers cannot disagree. Go to
//! Definition on a `$ref` asks it of any JSON or YAML file -- an OpenAPI spec,
//! a JSON Schema, anything else that uses the keyword -- and
//! `openapi-unresolved-ref` asks it of every reference in a Swagger 2.0 or
//! OpenAPI 3 spec.
//!
//! What is followed is what is written in the files: a JSON Pointer into the
//! file itself (`#/components/schemas/Pet`), a path to a file beside it
//! (`./pet.yaml`), or both. A URL is not fetched and a plain-name fragment
//! (`#pet`, which is JSON Schema's `$anchor`) is not looked for; both are
//! `Target::Unknown`, which no caller reports.
//!
//! Only specs are linted, and that is a decision about noise rather than about
//! reach. In a JSON Schema a `$ref` may name an `$id` declared anywhere in the
//! file or an `$anchor`, neither of which is a place in the text, so "this leads
//! nowhere" is not something a pointer walk can say there. In a spec the two
//! shapes above are all a reference can be.

use std::collections::HashMap;
use std::ops::Range;
use std::path::{Path, PathBuf};

use jsonc_parser::ast::Value as Json;
use percent_encoding::percent_decode_str;
use poly_core::diag::{Issue, Severity};
use url::Url;

use crate::workflow::{Node, Value};

const UNRESOLVED: &str = "openapi-unresolved-ref";

/// The one rule here, with the prose `lint::rule_doc` serves for it.
///
/// `Error` because that is what `broken-reference` is everywhere else in the
/// catalog, and because it is true: measured 2026-11-26 with the
/// `@apidevtools/swagger-parser` poly's own preview bundles with, one `$ref` to
/// a key that is not there makes `bundle` and `dereference` both throw
/// `MissingPointerError` for the whole document.
pub const RULES: &[(&str, Severity, &str)] = &[(
    UNRESOLVED,
    Severity::Error,
    "A `$ref` in a Swagger or OpenAPI spec that leads nowhere: the file it names \
     does not exist, or the JSON Pointer walks into a mapping that has no such \
     key. Every tool that reads the spec follows its references first, and one \
     that cannot be followed fails the whole document rather than the one \
     schema -- a bundler stops, a generator writes nothing. The usual cause is \
     a component that was renamed, or moved to another file, while the \
     references to it were not. Reported only when the target is certain not \
     to be there. A URL is not fetched, and a pointer that passes through a \
     YAML alias, a merge key or another `$ref` is left alone, because what is \
     under those is not written where the pointer looks. A `$ref` inside an \
     `example`, `default`, `enum` or `const` is a value somebody wrote out, \
     not a reference, and is not followed.",
)];

/// The languages a `$ref` is read in.
pub fn applies(lang: &str) -> bool {
    matches!(lang, "json" | "yaml")
}

/// The language a file a reference names is read as, from its name.
fn language_of(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()? {
        "json" | "jsonc" => Some("json"),
        "yaml" | "yml" => Some("yaml"),
        _ => None,
    }
}

// ── reading ────────────────────────────────────────────────────────────────

/// A file's documents as value trees: one for JSON, one per `---` for YAML.
///
/// `None` in a document's place is one that is empty or does not parse. The
/// tree is `workflow`'s because a pointer asks of it what the workflow rules
/// ask -- "what is under this key" -- and because `schema` already puts a JSON
/// Pointer on a line by walking the same shape.
fn parse(lang: &str, text: &str) -> Vec<Option<Node>> {
    if lang == "json" {
        // Comments and trailing commas included: `.jsonc` is JSON to poly, and
        // a `tsconfig`-style file that uses `$ref` is no less navigable.
        let parsed =
            jsonc_parser::parse_to_ast(text, &Default::default(), &Default::default()).ok();
        return vec![parsed.and_then(|parsed| parsed.value.as_ref().map(from_json))];
    }
    crate::workflow::documents(text)
}

fn from_json(value: &Json) -> Node {
    let (range, value) = match value {
        Json::StringLit(lit) => (lit.range, Value::Scalar(lit.value.to_string())),
        // A number, `true` or `null` is not a string, and a string is the only
        // thing a `$ref` or a version can be: kept apart so `"$ref": 5` is not
        // read as a file named 5.
        Json::NumberLit(lit) => (lit.range, Value::Opaque),
        Json::BooleanLit(lit) => (lit.range, Value::Opaque),
        Json::NullKeyword(lit) => (lit.range, Value::Opaque),
        Json::Array(array) => (
            array.range,
            Value::Seq(array.elements.iter().map(from_json).collect()),
        ),
        Json::Object(object) => (
            object.range,
            Value::Map(
                object
                    .properties
                    .iter()
                    .map(|property| {
                        let name = jsonc_parser::common::Ranged::range(&property.name);
                        let key = Node {
                            at: name.start,
                            end: name.end,
                            value: Value::Scalar(property.name.as_str().to_string()),
                        };
                        (key, from_json(&property.value))
                    })
                    .collect(),
            ),
        ),
    };
    Node {
        at: range.start,
        end: range.end,
        value,
    }
}

fn entries(node: &Node) -> &[(Node, Node)] {
    match &node.value {
        Value::Map(entries) => entries,
        _ => &[],
    }
}

fn get<'n>(node: &'n Node, key: &str) -> Option<&'n Node> {
    entries(node)
        .iter()
        .find(|(k, _)| k.str() == Some(key))
        .map(|(_, v)| v)
}

/// Is this the top of a Swagger 2.0 or OpenAPI 3 spec?
///
/// The same two keys the Swagger preview tells a spec by. Any `3.` rather than
/// the `3.0` and `3.1` it lists: what a `$ref` is has not changed between
/// them, and a 3.2 spec's references are no less followable.
fn is_spec(root: &Node) -> bool {
    let version = |key: &str, major: &str| {
        get(root, key)
            .and_then(Node::str)
            .is_some_and(|version| version.starts_with(major))
    };
    version("swagger", "2.") || version("openapi", "3.")
}

// ── the references in a file ───────────────────────────────────────────────

/// One `$ref` and the string it holds.
struct Reference {
    /// The string's place in the text, quotes left out.
    at: Range<usize>,
    /// The same with its quotes, which is what the cursor can be on.
    written: Range<usize>,
    to: String,
    /// Which of the file's documents it is in: a pointer into "this file" is a
    /// pointer into this document of it.
    document: usize,
    /// Inside a value somebody wrote out -- an example, a default -- where
    /// `$ref` is a key like any other.
    literal: bool,
}

/// The keys whose mapping holds names rather than keywords.
///
/// Under `properties` a key called `example` or `default` is a property of
/// that name, and what is under it is a schema, not a value written out.
/// Without this list a schema with a `default` property would have its
/// references skipped as if they were data.
const NAMED: &[&str] = &[
    "$defs",
    "callbacks",
    "content",
    "definitions",
    "dependentSchemas",
    "encoding",
    "headers",
    "links",
    "parameters",
    "pathItems",
    "paths",
    "patternProperties",
    "properties",
    "requestBodies",
    "responses",
    "schemas",
    "securitySchemes",
    "variables",
    "webhooks",
];

/// The keywords whose value is data: whatever is under them is an instance
/// somebody wrote out, and a `$ref` key in it is that instance's own.
const LITERAL: &[&str] = &["const", "default", "enum", "example"];

fn references(text: &str, documents: &[Option<Node>]) -> Vec<Reference> {
    let mut found = Vec::new();
    for (document, root) in documents.iter().enumerate() {
        if let Some(root) = root {
            collect(text, document, root, None, false, &mut found);
        }
    }
    found
}

/// `under` is the keyword this node is the value of, or `None` when it sits
/// under a name or in a list.
fn collect(
    text: &str,
    document: usize,
    node: &Node,
    under: Option<&str>,
    literal: bool,
    found: &mut Vec<Reference>,
) {
    match &node.value {
        Value::Seq(items) => {
            for item in items {
                collect(text, document, item, None, literal, found);
            }
        }
        Value::Map(entries) => {
            let names = under.is_some_and(|key| NAMED.contains(&key));
            for (key, value) in entries {
                let key = key.str();
                if let (Some("$ref"), Some(to)) = (key, value.str()) {
                    found.push(Reference {
                        at: unquoted(text, value),
                        written: value.at..value.end,
                        to: to.to_string(),
                        document,
                        literal,
                    });
                } else if names {
                    collect(text, document, value, None, literal, found);
                } else if key == Some("examples") && !literal {
                    examples(text, document, value, found);
                } else {
                    let literal = literal || key.is_some_and(|key| LITERAL.contains(&key));
                    collect(text, document, value, key, literal, found);
                }
            }
        }
        Value::Scalar(_) | Value::Opaque => {}
    }
}

/// What is under an `examples` key, which is three different things.
///
/// In OpenAPI 3 it is a mapping of names to Example Objects, and an entry may
/// be a reference to one in `components` instead -- that `$ref` is real, and
/// everything else under the entry (its `value` above all) is data. In a JSON
/// Schema it is a list of instances, and in a Swagger 2.0 response a mapping of
/// media types to instances: data all the way down.
fn examples(text: &str, document: usize, node: &Node, found: &mut Vec<Reference>) {
    match &node.value {
        Value::Map(named) => {
            for (_, example) in named {
                for (key, value) in entries(example) {
                    if let (Some("$ref"), Some(to)) = (key.str(), value.str()) {
                        found.push(Reference {
                            at: unquoted(text, value),
                            written: value.at..value.end,
                            to: to.to_string(),
                            document,
                            literal: false,
                        });
                    } else {
                        collect(text, document, value, None, true, found);
                    }
                }
            }
        }
        _ => collect(text, document, node, None, true, found),
    }
}

/// A string's range without the quotes around it, if it has them.
fn unquoted(text: &str, node: &Node) -> Range<usize> {
    let written = text.get(node.at..node.end).unwrap_or("");
    let quoted = written.len() >= 2
        && ['"', '\'']
            .iter()
            .any(|&quote| written.starts_with(quote) && written.ends_with(quote));
    if quoted {
        node.at + 1..node.end - 1
    } else {
        node.at..node.end
    }
}

// ── following one ──────────────────────────────────────────────────────────

/// Where a reference leads.
#[derive(Debug, PartialEq)]
pub enum Target {
    /// A place in a file: the value there, and the key it sits under when it
    /// has one -- the top of a file and an item of a list have none.
    Found {
        path: PathBuf,
        key: Option<Range<usize>>,
        value: Range<usize>,
    },
    /// Nowhere. The sentence says what is not there.
    Missing(String),
    /// Somewhere poly does not follow (a URL, a plain-name fragment), or
    /// somewhere the text does not settle: through a YAML alias, a merge key
    /// or another `$ref`, or into a file that does not parse. Not a finding
    /// and not an answer.
    Unknown,
}

enum Loaded {
    /// No file is there.
    Absent,
    /// Something is there, and it is not JSON or YAML that parses.
    Unreadable,
    Parsed(Vec<Option<Node>>),
}

/// The files references lead into, each read and parsed once.
///
/// A spec split over a directory names the same few files from hundreds of
/// places; without this each of those would read and parse its target again.
struct Files<'r> {
    read: &'r dyn Fn(&Path) -> Option<String>,
    loaded: HashMap<PathBuf, Loaded>,
}

impl<'r> Files<'r> {
    fn new(read: &'r dyn Fn(&Path) -> Option<String>) -> Self {
        Files {
            read,
            loaded: HashMap::new(),
        }
    }

    fn load(&mut self, path: &Path) -> &Loaded {
        if !self.loaded.contains_key(path) {
            let loaded = match (self.read)(path) {
                Some(text) => {
                    let documents = match language_of(path) {
                        Some(lang) => parse(lang, &text),
                        // Named as neither. JSON first: nearly every JSON file
                        // is YAML as well, and no YAML file is JSON.
                        None => {
                            let json = parse("json", &text);
                            if json.iter().any(Option::is_some) {
                                json
                            } else {
                                parse("yaml", &text)
                            }
                        }
                    };
                    if documents.iter().any(Option::is_some) {
                        Loaded::Parsed(documents)
                    } else {
                        Loaded::Unreadable
                    }
                }
                // A directory, or bytes that are not text: there, and not
                // something a pointer can be walked into.
                None if path.exists() => Loaded::Unreadable,
                None => Loaded::Absent,
            };
            self.loaded.insert(path.to_path_buf(), loaded);
        }
        &self.loaded[path]
    }

    /// `base` is the URL of the file the reference is written in, and `own`
    /// that file's documents as they are now -- the buffer, not the disk.
    fn resolve(&mut self, base: &Url, own: &[Option<Node>], reference: &Reference) -> Target {
        // Resolved the way a URL is, because that is what a `$ref` is: `..`
        // climbs, `%20` is a space, and anything with its own scheme is not a
        // file beside this one.
        let Ok(mut url) = base.join(&reference.to) else {
            return Target::Unknown;
        };
        if url.scheme() != "file" {
            return Target::Unknown;
        }
        let Ok(fragment) = percent_decode_str(url.fragment().unwrap_or("")).decode_utf8() else {
            return Target::Unknown;
        };
        let Some(pointer) = pointer(&fragment) else {
            return Target::Unknown;
        };
        url.set_fragment(None);
        let Ok(path) = url.to_file_path() else {
            return Target::Unknown;
        };
        // The file as the reference wrote it, for the sentence; empty when the
        // reference is a pointer alone.
        let file = reference.to.split('#').next().unwrap_or("");
        let root = if url == *base {
            own.get(reference.document).and_then(Option::as_ref)
        } else {
            match self.load(&path) {
                Loaded::Absent => {
                    return Target::Missing(format!(
                        "`{}` leads nowhere: `{file}` does not exist",
                        reference.to
                    ));
                }
                Loaded::Unreadable => return Target::Unknown,
                // A pointer into a YAML stream is a pointer into its first
                // document; nothing in a reference can name another.
                Loaded::Parsed(documents) => documents.first().and_then(Option::as_ref),
            }
        };
        let Some(root) = root else {
            return Target::Unknown;
        };
        match walk(root, &pointer) {
            Walked::At(key, value) => Target::Found {
                path,
                key: key.map(|key| key.at..key.end),
                value: value.at..value.end,
            },
            Walked::Unknown => Target::Unknown,
            Walked::Missing(depth, candidates) => {
                let within = if depth == 0 && file.is_empty() {
                    "the top of this file".to_string()
                } else if depth == 0 {
                    format!("the top of `{file}`")
                } else {
                    format!("`{file}#/{}`", escaped(&pointer[..depth]))
                };
                Target::Missing(format!(
                    "`{}` leads nowhere: {within} has no `{}`{}",
                    reference.to,
                    pointer[depth],
                    crate::workflow::suggestion(&pointer[depth], &candidates)
                ))
            }
        }
    }
}

/// A fragment as the keys and indexes of a JSON Pointer (RFC 6901), or `None`
/// for one that is not a pointer -- `#pet` is a name, declared by an `$anchor`
/// or an `$id` that may be anywhere.
fn pointer(fragment: &str) -> Option<Vec<String>> {
    if fragment.is_empty() {
        return Some(Vec::new());
    }
    let rest = fragment.strip_prefix('/')?;
    Some(
        rest.split('/')
            // `~1` before `~0`, as the RFC orders them: the other way round
            // turns `~01` into a slash.
            .map(|token| token.replace("~1", "/").replace("~0", "~"))
            .collect(),
    )
}

/// A pointer's keys written back as it would be typed, for a message.
fn escaped(tokens: &[String]) -> String {
    tokens
        .iter()
        .map(|token| token.replace('~', "~0").replace('/', "~1"))
        .collect::<Vec<_>>()
        .join("/")
}

enum Walked<'n> {
    /// The value, and its key when it is a mapping's.
    At(Option<&'n Node>, &'n Node),
    /// The pointer's `usize`th token is not there; the names that are.
    Missing(usize, Vec<&'n str>),
    Unknown,
}

fn walk<'n>(root: &'n Node, pointer: &[String]) -> Walked<'n> {
    let mut key = None;
    let mut node = root;
    for (depth, token) in pointer.iter().enumerate() {
        match &node.value {
            Value::Map(entries) => {
                match entries
                    .iter()
                    .find(|(k, _)| k.str() == Some(token.as_str()))
                {
                    Some((k, v)) => {
                        key = Some(k);
                        node = v;
                    }
                    // A merge key or a reference brings keys that are written
                    // somewhere else, and following them here would be
                    // resolving the document rather than reading it. The tools
                    // that do resolve it find such a key; poly says nothing.
                    None if entries
                        .iter()
                        .any(|(k, _)| matches!(k.str(), Some("<<" | "$ref"))) =>
                    {
                        return Walked::Unknown;
                    }
                    None => {
                        let names = entries.iter().filter_map(|(k, _)| k.str()).collect();
                        return Walked::Missing(depth, names);
                    }
                }
            }
            Value::Seq(items) => match token.parse::<usize>().ok().and_then(|i| items.get(i)) {
                Some(item) => {
                    key = None;
                    node = item;
                }
                None => return Walked::Missing(depth, Vec::new()),
            },
            Value::Scalar(_) => return Walked::Missing(depth, Vec::new()),
            // An alias, a tagged node, a key with nothing under it.
            Value::Opaque => return Walked::Unknown,
        }
    }
    Walked::At(key, node)
}

/// The file a document is, as the URL its references resolve against.
fn base_of(path: &Path) -> Option<Url> {
    Url::from_file_path(std::path::absolute(path).ok()?).ok()
}

/// The `$ref` whose string `offset` is on, and where it leads.
///
/// `None` when the cursor is on no reference. `read` is how another file's
/// text is had: the caller knows which files are open in an editor with
/// changes the disk has not seen.
pub fn follow(
    lang: &str,
    path: &Path,
    text: &str,
    offset: usize,
    read: &dyn Fn(&Path) -> Option<String>,
) -> Option<(Range<usize>, Target)> {
    let documents = parse(lang, text);
    // The end included: that is where the cursor sits after the last character.
    let reference = references(text, &documents)
        .into_iter()
        .find(|one| one.written.start <= offset && offset <= one.written.end)?;
    let base = base_of(path)?;
    let target = Files::new(read).resolve(&base, &documents, &reference);
    Some((reference.at, target))
}

// ── the rule ───────────────────────────────────────────────────────────────

/// Every reference in a Swagger or OpenAPI spec that leads nowhere.
///
/// `None` when the file is not a spec, which is not the same answer as "every
/// reference resolves": the caller counts the specs that were checked, as it
/// counts the files a schema reached.
///
/// A file that does not parse is `None` as well. Its syntax error is `poly
/// fmt`'s to report, and nothing can be said about references nobody can read.
pub fn lint(lang: &str, path: &Path, text: &str) -> Option<Vec<Issue>> {
    // Asked of every JSON and YAML file in the walk, a lockfile of several
    // megabytes included, so the words a spec with references cannot be without
    // are looked for before anything is parsed.
    if !applies(lang)
        || !text.contains("$ref")
        || !(text.contains("openapi") || text.contains("swagger"))
    {
        return None;
    }
    let documents = parse(lang, text);
    if !documents
        .first()
        .and_then(Option::as_ref)
        .is_some_and(is_spec)
    {
        return None;
    }
    let base = base_of(path)?;
    let read = |path: &Path| std::fs::read_to_string(path).ok();
    let mut files = Files::new(&read);
    let mut found = Vec::new();
    for reference in references(text, &documents) {
        if reference.literal {
            continue;
        }
        if let Target::Missing(message) = files.resolve(&base, &documents, &reference) {
            found.push(issue(text, &reference.at, message));
        }
    }
    Some(found)
}

fn issue(text: &str, at: &Range<usize>, message: String) -> Issue {
    let (line, col) = crate::lint::line_col(text, at.start);
    let (end_line, end_col) = crate::lint::line_col(text, at.end);
    Issue {
        line,
        col,
        end_line,
        end_col,
        severity: crate::lint::rule_severity(UNRESOLVED),
        code: UNRESOLVED.to_string(),
        message,
        // poly's own rule, under poly's own name. See `RULES`.
        source: "poly",
        fix: None,
        // There is no page to link: the prose is in `RULES` and reaches the
        // editor through `lint::rule_doc`.
        url: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn disk(path: &Path) -> Option<String> {
        std::fs::read_to_string(path).ok()
    }

    /// Where the reference on `needle` leads, as the text it lands on: the key
    /// when there is one, and the value.
    fn landed(lang: &str, path: &Path, text: &str, needle: &str) -> (Option<String>, String) {
        let offset = text.find(needle).expect("the needle is in the text") + 1;
        let (_, target) = follow(lang, path, text, offset, &disk).expect("on a reference");
        let Target::Found {
            path: file,
            key,
            value,
        } = target
        else {
            panic!("{needle} did not resolve: {target:?}");
        };
        let there = if file == std::path::absolute(path).unwrap() {
            text.to_string()
        } else {
            std::fs::read_to_string(&file).unwrap()
        };
        (
            key.map(|key| there[key].to_string()),
            there[value].to_string(),
        )
    }

    fn target(lang: &str, path: &Path, text: &str, needle: &str) -> Target {
        let offset = text.find(needle).expect("the needle is in the text") + 1;
        follow(lang, path, text, offset, &disk)
            .expect("on a reference")
            .1
    }

    const YAML: &str = "\
openapi: 3.0.3
paths:
  /pets/{id}:
    get:
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Pet'
components:
  schemas:
    Pet:
      type: object
      properties:
        owner:
          $ref: \"#/components/schemas/Owner\"
    Owner:
      type: string
";

    /// A pointer lands on the key it names, in the file it is written in --
    /// JSON and YAML alike, since one spec is as often the other.
    #[test]
    fn a_pointer_is_followed_into_its_own_file() {
        let dir = tempfile::tempdir().unwrap();
        let yaml = dir.path().join("openapi.yaml");
        let (key, value) = landed("yaml", &yaml, YAML, "'#/components/schemas/Pet'");
        assert_eq!(key.as_deref(), Some("Pet"));
        assert!(value.starts_with("type: object"), "{value}");
        let (key, value) = landed("yaml", &yaml, YAML, "\"#/components/schemas/Owner\"");
        assert_eq!(key.as_deref(), Some("Owner"));
        assert_eq!(value, "type: string");

        let json = dir.path().join("openapi.json");
        let text = r##"{
  // jsonc is JSON here
  "swagger": "2.0",
  "paths": {"/pets": {"get": {"responses": {"200": {"schema": {"$ref": "#/definitions/Pet"}}}}}},
  "definitions": {"Pet": {"type": "object"},},
}"##;
        let (key, value) = landed("json", &json, text, "\"#/definitions/Pet\"");
        assert_eq!(key.as_deref(), Some("\"Pet\""));
        assert_eq!(value, r#"{"type": "object"}"#);
    }

    /// The origin is the string without its quotes, which is what the editor
    /// underlines; and the cursor counts as on it at either end.
    #[test]
    fn the_cursor_is_on_a_reference_anywhere_in_its_string() {
        let path = Path::new("/w/openapi.yaml");
        let quote = YAML.find("'#/components/schemas/Pet'").unwrap();
        for offset in [quote, quote + 5, quote + 26] {
            let (at, _) = follow("yaml", path, YAML, offset, &disk).expect("on the reference");
            assert_eq!(&YAML[at], "#/components/schemas/Pet");
        }
        // On the key, and on a line that has no reference.
        assert!(follow("yaml", path, YAML, quote - 3, &disk).is_none());
        assert!(follow("yaml", path, YAML, 3, &disk).is_none());
    }

    /// A path is a file beside the one it is written in, with or without a
    /// pointer into it; `..` climbs and `%20` is a space, as in any URL.
    #[test]
    fn a_path_is_followed_into_the_file_it_names() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("api")).unwrap();
        std::fs::create_dir_all(root.join("shared")).unwrap();
        std::fs::write(root.join("api/pet.yaml"), "type: object\n").unwrap();
        std::fs::write(
            root.join("shared/common models.json"),
            r#"{"definitions": {"Owner": {"type": "string"}}}"#,
        )
        .unwrap();
        let text = "\
openapi: 3.1.0
components:
  schemas:
    Pet:
      $ref: ./pet.yaml
    Owner:
      $ref: '../shared/common%20models.json#/definitions/Owner'
";
        let spec = root.join("api/openapi.yaml");
        assert_eq!(
            landed("yaml", &spec, text, "./pet.yaml"),
            (None, "type: object".to_string())
        );
        assert_eq!(
            landed("yaml", &spec, text, "'../shared/common"),
            (
                Some("\"Owner\"".to_string()),
                r#"{"type": "string"}"#.to_string()
            )
        );
    }

    /// A key with a slash in it is written `~1`, and a brace may arrive
    /// percent-encoded: both name `/pets/{id}`.
    #[test]
    fn pointer_escapes_name_the_key_they_stand_for() {
        let path = Path::new("/w/openapi.yaml");
        let text = "\
openapi: 3.0.0
paths:
  /pets/{id}:
    get: {}
  /a~b:
    get: {}
x-first:
  $ref: '#/paths/~1pets~1{id}/get'
x-second:
  $ref: '#/paths/~1pets~1%7Bid%7D'
x-third:
  $ref: '#/paths/~1a~0b'
";
        assert_eq!(
            landed("yaml", path, text, "'#/paths/~1pets~1{id}/get'").0,
            Some("get".to_string())
        );
        assert_eq!(
            landed("yaml", path, text, "'#/paths/~1pets~1%7B").0,
            Some("/pets/{id}".to_string())
        );
        assert_eq!(
            landed("yaml", path, text, "'#/paths/~1a~0b'").0,
            Some("/a~b".to_string())
        );
    }

    /// A reference too long for its line is written over two, the break
    /// escaped in the middle of a word: one reference, to the key those two
    /// halves spell.
    #[test]
    fn a_reference_continued_on_the_next_line_is_one_reference() {
        let path = Path::new("/w/swagger.yaml");
        let text = "\
swagger: '2.0'
definitions:
  Pool:
    properties:
      items:
        type: string
  Use:
    allOf:
      - $ref: \"#/definitions/Pool/prope\\
          rties/items\"
";
        assert_eq!(
            landed("yaml", path, text, "rties/items").0,
            Some("items".to_string())
        );
        assert!(lint("yaml", path, text).is_some_and(|found| found.is_empty()));
    }

    /// A pointer into a YAML stream's second document is a pointer into that
    /// document, not into the first one's key of the same name.
    #[test]
    fn each_yaml_document_resolves_its_own_pointers() {
        let path = Path::new("/w/stream.yaml");
        let text = "\
defs:
  a: first
---
defs:
  a: second
use:
  $ref: '#/defs/a'
";
        assert_eq!(
            landed("yaml", path, text, "'#/defs/a'"),
            (Some("a".to_string()), "second".to_string())
        );
    }

    /// What poly does not follow, and what the text does not settle, is
    /// neither found nor missing -- so it is never a finding.
    #[test]
    fn what_cannot_be_told_is_not_called_missing() {
        let dir = tempfile::tempdir().unwrap();
        let spec = dir.path().join("openapi.yaml");
        std::fs::write(dir.path().join("broken.yaml"), "a: [unclosed\n").unwrap();
        std::fs::write(dir.path().join("notes.md"), "# Notes\n\n* a: [b\n").unwrap();
        let text = "\
openapi: 3.0.0
x-base: &base
  inherited: {type: string}
components:
  schemas:
    Merged:
      <<: *base
      own: {type: string}
    Aliased: *base
    Referred:
      $ref: '#/components/schemas/Merged'
x-remote:
  $ref: 'https://example.com/schemas/pet.json#/Pet'
x-anchor:
  $ref: '#pet'
x-merge:
  $ref: '#/components/schemas/Merged/inherited'
x-alias:
  $ref: '#/components/schemas/Aliased/inherited'
x-through-ref:
  $ref: '#/components/schemas/Referred/own'
x-unparsable:
  $ref: './broken.yaml#/a'
x-not-data:
  $ref: './notes.md#/a'
";
        for needle in [
            "'https://example.com",
            "'#pet'",
            "'#/components/schemas/Merged/inherited'",
            "'#/components/schemas/Aliased/inherited'",
            "'#/components/schemas/Referred/own'",
            "'./broken.yaml#/a'",
            "'./notes.md#/a'",
        ] {
            assert_eq!(
                target("yaml", &spec, text, needle),
                Target::Unknown,
                "{needle}"
            );
        }
        assert!(lint("yaml", &spec, text).is_some_and(|found| found.is_empty()));
    }

    fn found(lang: &str, path: &Path, text: &str) -> Vec<(u32, u32, u32, String)> {
        lint(lang, path, text)
            .expect("a spec")
            .into_iter()
            .map(|issue| {
                assert_eq!(issue.code, UNRESOLVED);
                assert_eq!(issue.source, "poly");
                assert_eq!(issue.severity, Severity::Error);
                (issue.line, issue.col, issue.end_col, issue.message)
            })
            .collect()
    }

    /// The finding is on the reference's own string and says which step of the
    /// pointer is not there -- with the name that is, when one is a typo away,
    /// since a renamed or mistyped component is what this usually is.
    #[test]
    fn a_reference_to_nothing_says_what_is_not_there() {
        let dir = tempfile::tempdir().unwrap();
        let spec = dir.path().join("openapi.yaml");
        std::fs::write(dir.path().join("pet.yaml"), "Pet:\n  type: object\n").unwrap();
        let text = "\
openapi: 3.0.3
components:
  schemas:
    Pet:
      type: object
    A:
      $ref: '#/components/schemas/Pte'
    B:
      $ref: '#/definitions/Pet'
    C:
      $ref: './owner.yaml#/Owner'
    D:
      $ref: pet.yaml#/Pet/properties
    E:
      $ref: 'pet.yaml#/Cat'
";
        assert_eq!(
            found("yaml", &spec, text),
            vec![
                (
                    6,
                    13,
                    37,
                    "`#/components/schemas/Pte` leads nowhere: `#/components/schemas` has no \
                     `Pte`, did you mean `Pet`?"
                        .to_string()
                ),
                (
                    8,
                    13,
                    30,
                    "`#/definitions/Pet` leads nowhere: the top of this file has no `definitions`"
                        .to_string()
                ),
                (
                    10,
                    13,
                    32,
                    "`./owner.yaml#/Owner` leads nowhere: `./owner.yaml` does not exist"
                        .to_string()
                ),
                (
                    12,
                    12,
                    36,
                    "`pet.yaml#/Pet/properties` leads nowhere: `pet.yaml#/Pet` has no `properties`"
                        .to_string()
                ),
                (
                    14,
                    13,
                    26,
                    "`pet.yaml#/Cat` leads nowhere: the top of `pet.yaml` has no `Cat`, did you \
                     mean `Pet`?"
                        .to_string()
                ),
            ]
        );
    }

    /// Only a spec is checked. A JSON Schema's `$ref` may name an `$id` or an
    /// `$anchor`, which no pointer walk finds, so the same dangling pointer in
    /// one is not poly's to report; and "not checked" is `None`, which the
    /// coverage row counts apart from "checked and clean".
    #[test]
    fn only_a_spec_is_checked() {
        let path = Path::new("/w/thing.json");
        let dangling = r##""properties": {"a": {"$ref": "#/definitions/Nope"}}"##;
        let schema =
            format!(r#"{{"$schema": "https://json-schema.org/draft/2020-12/schema", {dangling}}}"#);
        assert!(lint("json", path, &schema).is_none());
        // The word is there, the key is not.
        let named = format!(r#"{{"title": "openapi", {dangling}}}"#);
        assert!(lint("json", path, &named).is_none());
        for version in [r#""swagger": "2.0""#, r#""openapi": "3.1.0""#] {
            let spec = format!("{{{version}, {dangling}}}");
            assert_eq!(found("json", path, &spec).len(), 1, "{version}");
        }
        // Not a language a reference is read in, and not a file that parses.
        assert!(lint("toml", path, "openapi = '3.0.0' # $ref").is_none());
        assert!(lint("json", path, r##"{"openapi": "3.0.0", "$ref": "#/x""##).is_none());
        // A spec with every reference in place was checked, and is clean.
        let clean = r##"{"openapi": "3.0.0", "a": {"$ref": "#/b"}, "b": {}}"##;
        assert!(lint("json", path, clean).is_some_and(|found| found.is_empty()));
    }

    /// A `$ref` in a value somebody wrote out is that value's own key: an API
    /// that returns JSON Schemas has examples full of them. The same key names
    /// under `properties` are properties, and what is under them is checked.
    #[test]
    fn a_ref_inside_written_out_data_is_not_a_reference() {
        let path = Path::new("/w/openapi.yaml");
        let text = "\
openapi: 3.0.3
components:
  examples:
    Stored:
      value:
        $ref: '#/nowhere/1'
  schemas:
    Document:
      type: object
      example:
        $ref: '#/nowhere/2'
      default: {nested: {$ref: '#/nowhere/3'}}
      enum:
        - {$ref: '#/nowhere/4'}
      properties:
        example:
          $ref: '#/nowhere/5'
        default:
          type: object
          const: {$ref: '#/nowhere/6'}
paths:
  /documents:
    get:
      responses:
        '200':
          content:
            application/json:
              examples:
                stored:
                  $ref: '#/components/examples/Stord'
                inline:
                  value: {$ref: '#/nowhere/7'}
";
        let messages: Vec<String> = found("yaml", path, text)
            .into_iter()
            .map(|(_, _, _, message)| message)
            .collect();
        assert_eq!(messages.len(), 2, "{messages:#?}");
        // A property named `example` is a schema.
        assert!(messages[0].starts_with("`#/nowhere/5`"), "{messages:#?}");
        // An entry of `examples` that is a reference is one.
        assert!(
            messages[1].ends_with("has no `Stord`, did you mean `Stored`?"),
            "{messages:#?}"
        );
    }

    /// The one fixture that trips the rule, for the both-directions check.
    const TRIGGERS: &[(&str, &str)] = &[(
        UNRESOLVED,
        "openapi: 3.0.0\ncomponents:\n  schemas:\n    A:\n      $ref: '#/components/schemas/B'\n",
    )];

    /// Every code this module emits has prose behind it, and every piece of
    /// prose belongs to a code it emits -- the same two directions
    /// `every_workflow_rule_is_documented` holds the workflow rules to.
    #[test]
    fn every_reference_rule_is_documented() {
        let mut emitted: Vec<&str> = Vec::new();
        for (code, fixture) in TRIGGERS {
            let found = lint("yaml", Path::new("/w/openapi.yaml"), fixture).unwrap();
            assert!(
                found.iter().any(|issue| issue.code == *code),
                "{code} no longer fires for its own fixture:\n{fixture}"
            );
            emitted.extend(found.iter().map(|_| *code));
        }
        emitted.sort_unstable();
        emitted.dedup();
        let mut documented: Vec<&str> = RULES.iter().map(|(code, _, _)| *code).collect();
        documented.sort_unstable();
        assert_eq!(
            emitted, documented,
            "rules and their documentation disagree"
        );
        for (code, severity, doc) in RULES {
            assert_eq!(crate::lint::rule_doc("poly", code), Some(*doc), "{code}");
            assert_eq!(crate::lint::rule_severity(code), *severity, "{code}");
            assert!(doc.len() > 80, "{code}: {doc}");
        }
    }
}
