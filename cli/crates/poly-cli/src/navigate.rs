//! Outline, references and definitions for the languages poly answers itself.
//!
//! The editor half of `poly_engines::symbols`, which says why these languages
//! and why nothing more. This is the plumbing: which documents and
//! which files on disk, and byte offsets turned into the editor's positions.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use lsp_types::{Location, Position, Range, Url};
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

/// The registrations that make the editor ask poly, sent once per session.
///
/// Dynamic and scoped by language, never a static capability: a static
/// `referencesProvider` covers every language in the client's selector, and an
/// empty answer is still an answer -- the reference lens would then draw
/// `no refs` over YAML and CSS, which it leaves alone precisely because nothing
/// answers for them.
///
/// Definitions are Makefile and shell only, the two that were asked for. Shell
/// gets nothing else: it has no outline here, so a reference lens would have no
/// declarations to stand on.
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
    let outlined = selector(&["graphql", "nginx", "makefile"]);
    let defined = selector(&["makefile", "shellscript"]);
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
    pub fn references(
        &mut self,
        language: &str,
        root: &Path,
        open: &[(Url, &str)],
        wanted: (&str, &str),
        include_declaration: bool,
    ) -> Vec<Location> {
        self.find(language, root, open, |mention| {
            mention.space == wanted.0
                && mention.name == wanted.1
                && (include_declaration || !mention.declares)
        })
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
        let mut found = Vec::new();
        let mut covered = HashSet::new();
        for (uri, text) in open {
            if let Ok(path) = uri.to_file_path() {
                covered.insert(path);
            }
            let lines = Lines::new(text);
            for mention in symbols::mentions(language, text) {
                if matches(&mention) {
                    found.push(Location::new(uri.clone(), lines.range(&mention.at)));
                }
            }
        }
        for path in self.files_under(root, language) {
            if covered.contains(&path) {
                continue;
            }
            let Ok(uri) = Url::from_file_path(&path) else {
                continue;
            };
            for (mention, range) in self.read(language, &path) {
                if matches(mention) {
                    found.push(Location::new(uri.clone(), *range));
                }
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
            ("type", "User"),
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
            &[(post, unsaved)],
            ("type", "User"),
            false,
        );
        assert_eq!(
            uses.len(),
            3,
            "the declaration is left out when asked to be"
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
            assert_eq!(languages(method), set(&["graphql", "nginx", "makefile"]));
        }
        assert_eq!(
            languages("textDocument/definition"),
            set(&["makefile", "shellscript"])
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
                assert!(LANGUAGES.contains(&language), "{language}");
                assert!(symbols::applies(language), "{language}");
            }
        }
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
