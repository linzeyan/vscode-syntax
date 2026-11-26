//! Outline, references and definitions for the languages poly answers itself.
//!
//! The editor half of `poly_engines::symbols`, which says why these languages
//! and why nothing more, and of `poly_engines::json_ref`, which follows a
//! `$ref`. This is the plumbing: which documents and which files on disk, and
//! byte offsets turned into the editor's positions.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use lsp_types::{Location, LocationLink, Position, Range, Url};
use poly_engines::json_ref::{self, Target};
use poly_engines::symbols::{self, Kind, Mention, Symbol};

/// How long a walk of the workspace is reused.
///
/// The reference lens asks once per declaration on screen, so one screen of a
/// schema is twenty requests inside a second, and each would otherwise walk
/// the whole folder again on the thread that also formats.
///
/// ponytail: a timed list, so a file created this second is found within the
/// next five; a file watcher if that ever shows.
const WALK_REUSE: Duration = Duration::from_secs(5);

/// The languages poly reads names out of, whichever of the questions below
/// it answers for each.
pub const LANGUAGES: &[&str] = &["graphql", "nginx", "makefile", "shellscript"];

/// The language ids a `$ref` is followed in, and the language poly reads each
/// as.
///
/// The ids VS Code gives a spec or a schema. `dockercompose` and
/// `github-actions-workflow` are YAML too and are left out: neither format has
/// the keyword.
pub const REF_LANGUAGES: &[(&str, &str)] = &[("json", "json"), ("jsonc", "json"), ("yaml", "yaml")];

/// The language poly reads a document of this id as when following a `$ref`,
/// or `None` for an id no `$ref` is followed in.
pub fn ref_language(id: &str) -> Option<&'static str> {
    REF_LANGUAGES
        .iter()
        .find(|(known, _)| *known == id)
        .map(|(_, language)| *language)
}

/// The registrations that make the editor ask poly, sent once per session.
///
/// Dynamic and scoped by language, never a static capability: a static
/// `referencesProvider` covers every language in the client's selector, and an
/// empty answer is still an answer -- the reference lens would then draw
/// `no refs` over CSS, which it leaves alone precisely because nothing answers
/// for it.
///
/// Definitions are Makefile and shell, the two that were asked for by name,
/// and JSON and YAML for the one thing in them poly follows: a `$ref`
/// (`ref_definition`). Those three ids get no outline and no references from
/// here, so the lens has nothing new to draw over them.
///
/// nginx's and Makefile's text is synchronised here as well. Neither is in the
/// client's selector because poly formats neither, and joining that selector
/// would make poly their formatter -- one that never changes anything, in
/// place of the editor saying there is none. Registering the sync instead
/// brings the buffer, unsaved edits included, with no formatter attached. The
/// save is part of it so the spelling lint `poly check` already runs over those
/// files is refreshed rather than left stale. Shell needs none of it: poly
/// formats shell, so its text already arrives.
pub fn registrations() -> serde_json::Value {
    let selector = |languages: &[&str]| -> Vec<serde_json::Value> {
        languages
            .iter()
            .map(|language| serde_json::json!({"language": language, "scheme": "file"}))
            .collect()
    };
    let outlined = selector(&["graphql", "nginx", "makefile", "shellscript"]);
    let mut defined = selector(&["makefile", "shellscript"]);
    let followed: Vec<&str> = REF_LANGUAGES.iter().map(|(id, _)| *id).collect();
    defined.extend(selector(&followed));
    let synced = selector(&["nginx", "makefile"]);
    serde_json::json!([
        {
            "id": "poly:navigate:documentSymbol",
            "method": "textDocument/documentSymbol",
            "registerOptions": {"documentSelector": outlined},
        },
        {
            "id": "poly:navigate:references",
            "method": "textDocument/references",
            "registerOptions": {"documentSelector": outlined},
        },
        {
            "id": "poly:navigate:definition",
            "method": "textDocument/definition",
            "registerOptions": {"documentSelector": defined},
        },
        {
            "id": "poly:navigate:didOpen",
            "method": "textDocument/didOpen",
            "registerOptions": {"documentSelector": synced},
        },
        {
            "id": "poly:navigate:didChange",
            "method": "textDocument/didChange",
            "registerOptions": {"documentSelector": synced, "syncKind": 1},
        },
        {
            "id": "poly:navigate:didSave",
            "method": "textDocument/didSave",
            "registerOptions": {"documentSelector": synced, "includeText": false},
        },
        {
            "id": "poly:navigate:didClose",
            "method": "textDocument/didClose",
            "registerOptions": {"documentSelector": synced},
        },
    ])
}

/// Does the editor give `path` this language id?
///
/// For GraphQL and nginx, the rules poly-lsp's manifest declares,
/// which is where the editor gets them; `the_file_rules_are_the_manifests`
/// holds the two together. A file outside them is invisible here even if it is
/// nginx, because it is not nginx to the editor either and would never ask.
///
/// Makefile and shell are the editor's own languages, so their rules are VS
/// Code's built-in `make` and `shellscript` manifests, which no test here can
/// read. Shell's is the part of that list that is the Bourne family, by
/// extension: a rc file or a `#!` script with no extension is still answered
/// when it is the open one, it is only not searched for a library's function.
pub fn is_file_of(language: &str, path: &Path) -> bool {
    let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    match language {
        "makefile" => {
            matches!(extension, "mak" | "mk")
                || matches!(
                    name,
                    "Makefile" | "makefile" | "GNUmakefile" | "OCamlMakefile"
                )
        }
        "shellscript" => matches!(extension, "sh" | "bash" | "zsh" | "ksh" | "bats"),
        "graphql" => matches!(extension, "graphql" | "gql" | "graphqls"),
        // `**/nginx/*.conf` and `**/nginx/**/*.conf`: any folder named nginx
        // above it.
        "nginx" => {
            extension == "nginx"
                || path.file_name().is_some_and(|name| name == "nginx.conf")
                || (extension == "conf"
                    && path
                        .parent()
                        .is_some_and(|dir| dir.components().any(|c| c.as_os_str() == "nginx")))
        }
        _ => false,
    }
}

/// The LSP number for each kind, from the 1-based wire table.
fn kind_number(kind: Kind) -> u32 {
    match kind {
        Kind::Module => 2,
        Kind::Class => 5,
        Kind::Field => 8,
        Kind::Enum => 10,
        Kind::Interface => 11,
        Kind::Function => 12,
        Kind::Variable => 13,
        Kind::Constant => 14,
        Kind::EnumMember => 22,
        Kind::Struct => 23,
    }
}

/// Byte offsets to the editor's positions, which count UTF-16 units.
struct Lines<'a> {
    text: &'a str,
    starts: Vec<usize>,
}

impl<'a> Lines<'a> {
    fn new(text: &'a str) -> Self {
        let starts = std::iter::once(0)
            .chain(text.match_indices('\n').map(|(i, _)| i + 1))
            .collect();
        Lines { text, starts }
    }

    fn position(&self, offset: usize) -> Position {
        let line = self.starts.partition_point(|&start| start <= offset) - 1;
        let start = self.starts[line];
        let character = self.text[start..offset].encode_utf16().count();
        Position::new(line as u32, character as u32)
    }

    fn range(&self, span: &std::ops::Range<usize>) -> Range {
        Range::new(self.position(span.start), self.position(span.end))
    }

    fn offset(&self, at: Position) -> usize {
        let Some(&start) = self.starts.get(at.line as usize) else {
            return self.text.len();
        };
        let mut units = 0;
        for (i, ch) in self.text[start..].char_indices() {
            if units >= at.character as usize || ch == '\n' {
                return start + i;
            }
            units += ch.len_utf16();
        }
        self.text.len()
    }
}

/// `textDocument/documentSymbol`, hierarchical.
pub fn document_symbols(language: &str, text: &str) -> serde_json::Value {
    let lines = Lines::new(text);
    serde_json::Value::Array(
        symbols::symbols(language, text)
            .iter()
            .map(|symbol| symbol_json(symbol, &lines))
            .collect(),
    )
}

fn symbol_json(symbol: &Symbol, lines: &Lines) -> serde_json::Value {
    serde_json::json!({
        "name": symbol.name,
        "kind": kind_number(symbol.kind),
        "range": lines.range(&symbol.range),
        "selectionRange": lines.range(&symbol.selection),
        "children": symbol.children.iter().map(|child| symbol_json(child, lines)).collect::<Vec<_>>(),
    })
}

/// The name under the cursor: its namespace and spelling, if it is one.
pub fn mention_at(language: &str, text: &str, at: Position) -> Option<(&'static str, String)> {
    let offset = Lines::new(text).offset(at);
    symbols::mentions(language, text)
        .into_iter()
        .find(|mention| mention.at.start <= offset && offset <= mention.at.end)
        .map(|mention| (mention.space, mention.name))
}

/// Go to Definition on a `$ref`: the key its pointer names, in this document
/// or in the file its path names. `null` anywhere else, and for a reference
/// that leads nowhere or somewhere poly does not follow.
///
/// `read` is another file's text: the buffer when the editor has it open, so a
/// component added a moment ago and not yet saved is found.
///
/// A link when the editor takes links, for its origin: the editor underlines
/// the word under the pointer, and to it `#/components/schemas/Pet` is three
/// words. The target is the whole entry and the selection its key, which is
/// where the cursor lands.
pub fn ref_definition(
    language: &str,
    (uri, text): (&Url, &str),
    at: Position,
    read: &dyn Fn(&Path) -> Option<String>,
    links: bool,
) -> serde_json::Value {
    let Ok(path) = uri.to_file_path() else {
        return serde_json::Value::Null;
    };
    // Each file read once: the offsets `follow` answers in are offsets into the
    // text it parsed, and a file saved between two reads would turn them into
    // positions in a different text.
    let seen: RefCell<HashMap<PathBuf, Option<String>>> = RefCell::default();
    let read_once = |path: &Path| {
        seen.borrow_mut()
            .entry(path.to_path_buf())
            .or_insert_with(|| read(path))
            .clone()
    };
    let lines = Lines::new(text);
    let Some((
        origin,
        Target::Found {
            path: file,
            key,
            value,
        },
    )) = json_ref::follow(language, &path, text, lines.offset(at), &read_once)
    else {
        return serde_json::Value::Null;
    };
    // The document itself is answered with the URI the editor asked in: its
    // spelling of a drive letter is not the one a path turns back into.
    let (target, there) = if std::path::absolute(&path).is_ok_and(|own| own == file) {
        (uri.clone(), text.to_string())
    } else {
        match (Url::from_file_path(&file), read_once(&file)) {
            (Ok(target), Some(there)) => (target, there),
            _ => return serde_json::Value::Null,
        }
    };
    let there = Lines::new(&there);
    let name = key.unwrap_or(value.start..value.start);
    let entry = name.start.min(value.start)..value.end.max(name.end);
    if links {
        serde_json::json!([LocationLink {
            origin_selection_range: Some(lines.range(&origin)),
            target_uri: target,
            target_range: there.range(&entry),
            target_selection_range: there.range(&name),
        }])
    } else {
        serde_json::json!([Location::new(target, there.range(&name))])
    }
}

/// The workspace folder `path` belongs to: the innermost one holding it, or
/// its own directory when it is in none.
pub fn root_of(init_params: &serde_json::Value, path: &Path) -> PathBuf {
    init_params
        .get("workspaceFolders")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|folder| folder.get("uri")?.as_str())
        .filter_map(|uri| Url::parse(uri).ok()?.to_file_path().ok())
        .filter(|folder| path.starts_with(folder))
        .max_by_key(|folder| folder.components().count())
        .unwrap_or_else(|| path.parent().unwrap_or(path).to_path_buf())
}

/// A file's mentions, and the modification time they were read at.
type Read = (Option<SystemTime>, Vec<(Mention, Range)>);

/// Mentions read from files on disk, each kept until its file changes.
#[derive(Default)]
pub struct Index {
    files: HashMap<PathBuf, Read>,
    walks: HashMap<(PathBuf, String), (Instant, Vec<PathBuf>)>,
}

impl Index {
    /// Every place `space`/`name` is written in `language` under `root`.
    ///
    /// `open` are the documents of this language the editor has open; their
    /// buffers stand in for their files, so a name typed a moment ago is found
    /// and one deleted a moment ago is not.
    ///
    /// Shell is counted as `definition` resolves it, the other way round: a
    /// use belongs to its own file's declaration when the file has one, and to
    /// every declaration in the folder when it has none -- the script that
    /// sources a library. Measured 2026-11-17, one folder of scripts defined
    /// `step` in 23 files and `run` in 5; counted by name alone, each `step`
    /// would have shown the calls of all 23. The other languages keep the plain
    /// name: their names are global to whatever reads them.
    pub fn references(
        &mut self,
        language: &str,
        root: &Path,
        open: &[(Url, &str)],
        (from, wanted): (&Url, (&str, &str)),
        include_declaration: bool,
    ) -> Vec<Location> {
        let files = self.by_file(language, root, open, |mention| {
            mention.space == wanted.0 && mention.name == wanted.1
        });
        let declares = |here: &[(bool, Range)]| here.iter().any(|(declares, _)| *declares);
        let own = language == "shellscript"
            && files
                .iter()
                .any(|(uri, here)| uri == from && declares(here));
        files
            .into_iter()
            .filter(|(uri, here)| !own || uri == from || !declares(here))
            .flat_map(|(uri, here)| {
                here.into_iter()
                    .filter(|(declares, _)| include_declaration || !declares)
                    .map(move |(_, range)| Location::new(uri.clone(), range))
            })
            .collect()
    }

    /// Where the name at `at` in `text` -- the document `uri` -- is declared.
    ///
    /// The document's own declaration first, and of several the nearest one
    /// above the cursor: for shell that is the `local x` of the function the
    /// cursor is in rather than of another one, which is as much scope as a
    /// name match can get. One below is taken when none is above -- a function
    /// called before the line that defines it, a variable a recipe reads that
    /// is assigned further down. Only a name the document never declares is
    /// looked for in the rest of the folder, and there every declaration is an
    /// answer: a sourced library, an included `.mk`.
    pub fn definition(
        &mut self,
        language: &str,
        root: &Path,
        open: &[(Url, &str)],
        (uri, text): (&Url, &str),
        at: Position,
    ) -> Vec<Location> {
        let lines = Lines::new(text);
        let offset = lines.offset(at);
        let mentions = symbols::mentions(language, text);
        let Some(wanted) = mentions
            .iter()
            .find(|mention| mention.at.start <= offset && offset <= mention.at.end)
        else {
            return Vec::new();
        };
        let declared = || {
            mentions.iter().filter(|mention| {
                mention.declares && mention.space == wanted.space && mention.name == wanted.name
            })
        };
        let nearest = declared()
            .rfind(|mention| mention.at.start <= wanted.at.start)
            .or_else(|| declared().next());
        if let Some(declaration) = nearest {
            return vec![Location::new(uri.clone(), lines.range(&declaration.at))];
        }
        self.find(language, root, open, |mention| {
            mention.declares && mention.space == wanted.space && mention.name == wanted.name
        })
    }

    fn find(
        &mut self,
        language: &str,
        root: &Path,
        open: &[(Url, &str)],
        matches: impl Fn(&Mention) -> bool,
    ) -> Vec<Location> {
        self.by_file(language, root, open, matches)
            .into_iter()
            .flat_map(|(uri, here)| {
                here.into_iter()
                    .map(move |(_, range)| Location::new(uri.clone(), range))
            })
            .collect()
    }

    /// The mentions `matches` keeps, grouped by the file they are in, each
    /// with whether it declares. Files with none are left out.
    fn by_file(
        &mut self,
        language: &str,
        root: &Path,
        open: &[(Url, &str)],
        matches: impl Fn(&Mention) -> bool,
    ) -> Vec<(Url, Vec<(bool, Range)>)> {
        let mut found = Vec::new();
        let mut covered = HashSet::new();
        for (uri, text) in open {
            if let Ok(path) = uri.to_file_path() {
                covered.insert(path);
            }
            let lines = Lines::new(text);
            let here: Vec<(bool, Range)> = symbols::mentions(language, text)
                .iter()
                .filter(|mention| matches(mention))
                .map(|mention| (mention.declares, lines.range(&mention.at)))
                .collect();
            if !here.is_empty() {
                found.push((uri.clone(), here));
            }
        }
        for path in self.files_under(root, language) {
            if covered.contains(&path) {
                continue;
            }
            let Ok(uri) = Url::from_file_path(&path) else {
                continue;
            };
            let here: Vec<(bool, Range)> = self
                .read(language, &path)
                .iter()
                .filter(|(mention, _)| matches(mention))
                .map(|(mention, range)| (mention.declares, *range))
                .collect();
            if !here.is_empty() {
                found.push((uri, here));
            }
        }
        found
    }

    fn files_under(&mut self, root: &Path, language: &str) -> Vec<PathBuf> {
        let key = (root.to_path_buf(), language.to_string());
        if let Some((at, files)) = self.walks.get(&key) {
            if at.elapsed() < WALK_REUSE {
                return files.clone();
            }
        }
        // The walk `poly fmt` and `poly check` take: .gitignore'd and hidden
        // trees are not the project's, here or there.
        let files: Vec<PathBuf> =
            poly_core::walk_files(&[root.to_path_buf()], &[], None, poly_core::Walk::default())
                .unwrap_or_default()
                .into_iter()
                .filter(|path| is_file_of(language, path))
                .collect();
        self.walks.insert(key, (Instant::now(), files.clone()));
        files
    }

    fn read(&mut self, language: &str, path: &Path) -> &[(Mention, Range)] {
        let modified = std::fs::metadata(path).and_then(|m| m.modified()).ok();
        let stale = self
            .files
            .get(path)
            .is_none_or(|(at, _)| modified.is_none() || *at != modified);
        if stale {
            let mentions = std::fs::read_to_string(path)
                .map(|text| {
                    let lines = Lines::new(&text);
                    symbols::mentions(language, &text)
                        .into_iter()
                        .map(|mention| {
                            let range = lines.range(&mention.at);
                            (mention, range)
                        })
                        .collect()
                })
                .unwrap_or_default();
            self.files.insert(path.to_path_buf(), (modified, mentions));
        }
        &self.files[path].1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The editor and this file must agree on which files are nginx and which
    /// GraphQL: a file only one of them counts is a reference the lens misses,
    /// or one it reports in a file the editor calls plain text.
    #[test]
    fn the_file_rules_are_the_manifests() {
        let manifest =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../extensions/lsp/package.json");
        let package: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(manifest).unwrap()).unwrap();
        let declared = |id: &str, field: &str| -> Vec<String> {
            package["contributes"]["languages"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|l| l["id"] == id)
                .flat_map(|l| l[field].as_array().cloned().unwrap_or_default())
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        };
        assert_eq!(
            declared("graphql", "extensions"),
            [".graphql", ".gql", ".graphqls"]
        );
        assert!(declared("graphql", "filenames").is_empty());
        assert!(declared("graphql", "filenamePatterns").is_empty());
        assert_eq!(declared("nginx", "extensions"), [".nginx"]);
        assert_eq!(declared("nginx", "filenames"), ["nginx.conf"]);
        assert_eq!(
            declared("nginx", "filenamePatterns"),
            ["**/nginx/*.conf", "**/nginx/**/*.conf"]
        );
        assert!(is_file_of("graphql", Path::new("/w/schema.graphqls")));
        assert!(is_file_of("nginx", Path::new("/w/site.nginx")));
        assert!(is_file_of("nginx", Path::new("/w/nginx.conf")));
        assert!(is_file_of("nginx", Path::new("/w/nginx/conf.d/api.conf")));
        assert!(!is_file_of("nginx", Path::new("/w/conf.d/api.conf")));
        assert!(!is_file_of("graphql", Path::new("/w/schema.json")));
    }

    /// Positions count UTF-16 units, so a character outside the BMP before a
    /// name moves it two columns, not one -- and the cursor maps back.
    #[test]
    fn offsets_and_positions_agree_in_utf16() {
        let text = "a\n\u{1F600} User\n";
        let lines = Lines::new(text);
        let user = text.find("User").unwrap();
        assert_eq!(lines.position(user), Position::new(1, 3));
        assert_eq!(lines.offset(Position::new(1, 3)), user);
        assert_eq!(lines.offset(Position::new(1, 99)), text.len() - 1);
        assert_eq!(lines.offset(Position::new(9, 0)), text.len());
    }

    /// A name is found in every file of the language under the folder, and an
    /// open buffer stands in for its file: the unsaved use counts, the saved
    /// one it replaced does not.
    #[test]
    fn references_span_the_folder_and_prefer_open_buffers() {
        let dir = tempfile::tempdir().unwrap();
        // Not canonicalized: on Windows that is a `\\?\C:\` path, which no
        // URL turns back into, so the open buffer and its file on disk would
        // count as two files. The editor never sends one.
        let root = dir.path().to_path_buf();
        std::fs::write(root.join("user.graphql"), "type User { id: ID! }\n").unwrap();
        std::fs::write(root.join("post.graphql"), "type Post { author: User }\n").unwrap();
        std::fs::write(
            root.join("query.gql"),
            "query Q { me { ...on User { id } } }\n",
        )
        .unwrap();
        std::fs::write(root.join("notes.txt"), "User User User\n").unwrap();
        let post = Url::from_file_path(root.join("post.graphql")).unwrap();
        let unsaved = "type Post { author: User, editor: User }\n";

        let mut index = Index::default();
        let mut found = index.references(
            "graphql",
            &root,
            &[(post.clone(), unsaved)],
            (&post, ("type", "User")),
            true,
        );
        found.sort_by_key(|l| (l.uri.to_string(), l.range.start));
        let at: Vec<(String, u32, u32)> = found
            .iter()
            .map(|l| {
                let file = l
                    .uri
                    .path_segments()
                    .unwrap()
                    .next_back()
                    .unwrap()
                    .to_string();
                (file, l.range.start.line, l.range.start.character)
            })
            .collect();
        assert_eq!(
            at,
            vec![
                ("post.graphql".into(), 0, 20),
                ("post.graphql".into(), 0, 34),
                ("query.gql".into(), 0, 21),
                ("user.graphql".into(), 0, 5),
            ]
        );
        let uses = index.references(
            "graphql",
            &root,
            &[(post.clone(), unsaved)],
            (&post, ("type", "User")),
            false,
        );
        assert_eq!(
            uses.len(),
            3,
            "the declaration is left out when asked to be"
        );
    }

    /// A shell function counts the calls Go to Definition would bring to it:
    /// those in its own file, and those in a file that declares no function of
    /// that name -- the script sourcing the library. Another script's own
    /// `main` keeps its calls, which a match by name alone would have added to
    /// every `main` in the folder.
    #[test]
    fn a_shell_function_counts_the_calls_that_resolve_to_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let file = |name: &str, text: &str| {
            std::fs::write(root.join(name), text).unwrap();
            Url::from_file_path(root.join(name)).unwrap()
        };
        let lib = file("lib.sh", "log() { echo \"$1\"; }\nmain() { log hi; }\n");
        let run = file("run.sh", ". ./lib.sh\nmain() { log a; log b; }\nmain\n");
        let other = file("other.sh", ". ./lib.sh\nlog c\nmain\nmain\n");
        let mut index = Index::default();
        let mut count = |from: &Url, name: &str| -> Vec<String> {
            let mut found: Vec<String> = index
                .references("shellscript", &root, &[], (from, ("function", name)), false)
                .iter()
                .map(|l| {
                    let file = l.uri.path_segments().unwrap().next_back().unwrap();
                    format!("{file}:{}", l.range.start.line)
                })
                .collect();
            found.sort();
            found
        };
        // Declared once, in the library: every call in the folder is its own.
        assert_eq!(
            count(&lib, "log"),
            ["lib.sh:1", "other.sh:1", "run.sh:1", "run.sh:1"]
        );
        // run.sh's own main has run.sh's call. other.sh's two calls declare
        // nothing, so they resolve to every main and count for both.
        assert_eq!(
            count(&run, "main"),
            ["other.sh:2", "other.sh:3", "run.sh:2"]
        );
        assert_eq!(count(&lib, "main"), ["other.sh:2", "other.sh:3"]);
        // Asked from a call in a file that declares none: every declaration's
        // uses, as Go to Definition from there lists every declaration.
        assert_eq!(
            count(&other, "main"),
            ["other.sh:2", "other.sh:3", "run.sh:2"]
        );
        // GraphQL is not scoped: names there are global.
        let schema = file("a.graphql", "type User { id: ID }\n");
        file(
            "b.graphql",
            "type User { id: ID }\ntype Post { by: User }\n",
        );
        assert_eq!(
            index
                .references("graphql", &root, &[], (&schema, ("type", "User")), false)
                .len(),
            1
        );
    }

    #[test]
    fn the_cursor_finds_the_name_it_is_on() {
        let text = "upstream api {}\nserver { location / { proxy_pass http://api; } }\n";
        assert_eq!(
            mention_at("nginx", text, Position::new(1, 41)),
            Some(("upstream", "api".into()))
        );
        assert_eq!(mention_at("nginx", text, Position::new(1, 2)), None);
    }

    /// Each question is registered for exactly the languages poly answers it
    /// for: a language named where poly has no answer gets an empty one, which
    /// the reference lens draws as `no refs` and Go to Definition as "no
    /// definition found" over whatever the user's own server would have said.
    #[test]
    fn each_registration_names_only_the_languages_answered() {
        let registrations = registrations();
        let languages = |method: &str| -> HashSet<String> {
            registrations
                .as_array()
                .unwrap()
                .iter()
                .filter(|r| r["method"] == method)
                .flat_map(|r| r["registerOptions"]["documentSelector"].as_array().unwrap())
                .map(|selector| selector["language"].as_str().unwrap().to_string())
                .collect()
        };
        let set = |names: &[&str]| -> HashSet<String> {
            names.iter().map(|name| name.to_string()).collect()
        };
        for method in ["textDocument/documentSymbol", "textDocument/references"] {
            assert_eq!(
                languages(method),
                set(&["graphql", "nginx", "makefile", "shellscript"])
            );
        }
        assert_eq!(
            languages("textDocument/definition"),
            set(&["makefile", "shellscript", "json", "jsonc", "yaml"])
        );
        // Shell is in the client's selector already; the two that are not
        // need their text sent.
        for method in [
            "textDocument/didOpen",
            "textDocument/didChange",
            "textDocument/didSave",
            "textDocument/didClose",
        ] {
            assert_eq!(languages(method), set(&["nginx", "makefile"]));
        }
        for registration in registrations.as_array().unwrap() {
            for selector in registration["registerOptions"]["documentSelector"]
                .as_array()
                .unwrap()
            {
                let language = selector["language"].as_str().unwrap();
                // A `$ref`'s three ids are named for definitions and for
                // nothing else: an outline or a reference provider there is
                // the `no refs` over every key this registration is shaped to
                // avoid.
                if let Some(read_as) = ref_language(language) {
                    assert_eq!(registration["method"], "textDocument/definition");
                    assert!(json_ref::applies(read_as), "{language}");
                    continue;
                }
                assert!(LANGUAGES.contains(&language), "{language}");
                assert!(symbols::applies(language), "{language}");
            }
        }
    }

    /// A `$ref` lands on the key it names: in the document, at positions that
    /// count UTF-16 units, and in the file beside it -- whose open buffer
    /// stands in for what is on disk. An editor that takes links gets the
    /// whole string as the origin; one that does not gets a plain location.
    #[test]
    fn a_ref_is_followed_to_the_key_it_names() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let spec = "\
openapi: 3.0.3
info: {title: \u{1F600}, x-pet: {$ref: '#/components/schemas/Pet'}}
components:
  schemas:
    Pet: {type: object}
    Owner:
      $ref: owner.yaml#/Owner
";
        let uri = Url::from_file_path(root.join("openapi.yaml")).unwrap();
        std::fs::write(root.join("owner.yaml"), "Owner:\n  type: string\n").unwrap();
        let disk = |path: &Path| std::fs::read_to_string(path).ok();

        // Inside the string, after a character that is two UTF-16 units.
        let found = ref_definition("yaml", (&uri, spec), Position::new(1, 40), &disk, true);
        assert_eq!(
            found,
            serde_json::json!([{
                "originSelectionRange": {
                    "start": {"line": 1, "character": 33},
                    "end": {"line": 1, "character": 57},
                },
                "targetUri": uri,
                "targetRange": {
                    "start": {"line": 4, "character": 4},
                    "end": {"line": 4, "character": 23},
                },
                "targetSelectionRange": {
                    "start": {"line": 4, "character": 4},
                    "end": {"line": 4, "character": 7},
                },
            }])
        );
        // Without link support: where the cursor would have landed.
        let plain = ref_definition("yaml", (&uri, spec), Position::new(1, 40), &disk, false);
        assert_eq!(
            plain,
            serde_json::json!([{
                "uri": uri,
                "range": {
                    "start": {"line": 4, "character": 4},
                    "end": {"line": 4, "character": 7},
                },
            }])
        );

        let owner = Url::from_file_path(root.join("owner.yaml")).unwrap();
        let lands = |read: &dyn Fn(&Path) -> Option<String>| {
            let found = ref_definition("yaml", (&uri, spec), Position::new(6, 15), read, true);
            (
                found[0]["targetUri"].clone(),
                found[0]["targetSelectionRange"]["start"]["line"].clone(),
            )
        };
        assert_eq!(
            lands(&disk),
            (serde_json::json!(owner), serde_json::json!(0))
        );
        // The same file open with two lines added above the key and not saved.
        let unsaved = |path: &Path| {
            path.ends_with("owner.yaml")
                .then(|| "# moved\n\nOwner:\n  type: string\n".to_string())
        };
        assert_eq!(
            lands(&unsaved),
            (serde_json::json!(owner), serde_json::json!(2))
        );

        // Not on a reference, and on one that leads nowhere: nobody answered.
        let off = ref_definition("yaml", (&uri, spec), Position::new(0, 3), &disk, true);
        assert!(off.is_null());
        let dangling = "a:\n  $ref: '#/nowhere'\n";
        let nowhere = ref_definition("yaml", (&uri, dangling), Position::new(1, 12), &disk, true);
        assert!(nowhere.is_null());
    }

    /// VS Code's own rules for its built-in `make` and `shellscript`, as far as
    /// a folder walk uses them.
    #[test]
    fn makefiles_and_scripts_are_the_editors() {
        for path in [
            "/w/Makefile",
            "/w/sub/GNUmakefile",
            "/w/rules.mk",
            "/w/x.mak",
        ] {
            assert!(is_file_of("makefile", Path::new(path)), "{path}");
        }
        assert!(!is_file_of("makefile", Path::new("/w/Makefile.am")));
        for path in ["/w/lib.sh", "/w/run.bash", "/w/t.bats", "/w/p.zsh"] {
            assert!(is_file_of("shellscript", Path::new(path)), "{path}");
        }
        assert!(!is_file_of("shellscript", Path::new("/w/conf.fish")));
    }

    /// Go to Definition lands on the document's own declaration nearest above
    /// the cursor -- the `local` of the function it is in, not another's --
    /// and on one below only when there is none above. A name the document
    /// never declares is found in the folder: the `.mk` an include brings in.
    #[test]
    fn a_definition_is_the_nearest_declaration_then_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let script =
            "a() { local x=1; echo $x; }\nb() { local x=2; echo $x; later; }\nlater() { :; }\n";
        let uri = Url::from_file_path(root.join("run.sh")).unwrap();
        let mut index = Index::default();
        let mut at = |language: &str, (uri, text): (&Url, &str), line: u32, character: u32| {
            index
                .definition(
                    language,
                    &root,
                    &[(uri.clone(), text)],
                    (uri, text),
                    Position::new(line, character),
                )
                .iter()
                .map(|l| {
                    let file = l
                        .uri
                        .path_segments()
                        .unwrap()
                        .next_back()
                        .unwrap()
                        .to_string();
                    (file, l.range.start.line, l.range.start.character)
                })
                .collect::<Vec<_>>()
        };
        // `$x` in b() is b's own `local x`.
        assert_eq!(
            at("shellscript", (&uri, script), 1, 23),
            vec![("run.sh".into(), 1, 12)]
        );
        // `later` is called a line before it is defined.
        assert_eq!(
            at("shellscript", (&uri, script), 1, 27),
            vec![("run.sh".into(), 2, 0)]
        );
        // Not on a name.
        assert!(at("shellscript", (&uri, script), 0, 3).is_empty());

        std::fs::write(root.join("common.mk"), "CC ?= cc\n").unwrap();
        let makefile = "include common.mk\nall:\n\t$(CC) -o x\n";
        let make_uri = Url::from_file_path(root.join("Makefile")).unwrap();
        assert_eq!(
            at("makefile", (&make_uri, makefile), 2, 4),
            vec![("common.mk".into(), 0, 0)]
        );
    }
}
