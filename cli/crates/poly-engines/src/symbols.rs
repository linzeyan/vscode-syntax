//! poly's own outline, references and definitions, for the languages no
//! language server most people have answers them for.
//!
//! Everywhere else poly counts answers somebody else produced: the reference
//! lens asks the editor, and the editor asks whichever language server the
//! user installed for the language. GraphQL and nginx are the exception, taken on
//! purpose on 2026-10-05: graphql-language-service-server never implemented
//! `textDocument/references` and answers nothing at all without a
//! graphql-config, and no nginx server answers references. Makefiles and shell
//! scripts joined on 2026-10-21, asked for by name: the editor's own support for
//! both is a grammar and nothing else, so Go to Definition on `$(CC)` or on a
//! shell function said "no definition found".
//!
//! What is here is the cheap half of a language server and deliberately no
//! more: names and where they are written. No types, no scopes, no resolution
//! -- a mention is a namespace and a spelling, and two mentions are the same
//! thing when both agree. That is exact for GraphQL, whose type, fragment and
//! directive names are global by the spec, and as close as nginx gets: its
//! variables, upstreams and zones are global to the configuration too. make's
//! targets and variables are global to the make run. Shell is the one that has
//! scopes -- `local` -- and the definition lookup in poly-cli makes up for it
//! with position rather than with a resolver. Shell's outline and references
//! followed on 2026-11-17: its functions, counted the way Go to Definition
//! resolves them, so two scripts that each define `main` do not count each
//! other's calls.

use std::ops::Range;

/// What a declaration is, as far as an outline cares.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Module,
    Class,
    Interface,
    Struct,
    Enum,
    EnumMember,
    Field,
    Function,
    Variable,
    Constant,
}

/// One entry of a file's outline.
#[derive(Debug, PartialEq)]
pub struct Symbol {
    pub name: String,
    pub kind: Kind,
    /// The whole declaration, body included.
    pub range: Range<usize>,
    /// The name inside it, which is where a reference query is asked.
    pub selection: Range<usize>,
    pub children: Vec<Symbol>,
}

/// One place a name is written.
#[derive(Clone, Debug, PartialEq)]
pub struct Mention {
    /// What kind of name it is. A GraphQL fragment may share its spelling with
    /// a type, and an nginx upstream with a log format, without being it.
    pub space: &'static str,
    pub name: String,
    pub at: Range<usize>,
    /// The declaration rather than a use: what `includeDeclaration: false`
    /// leaves out.
    pub declares: bool,
}

/// Does poly read the names of `lang` itself?
///
/// Which questions it then answers about them is poly-cli's registration, not
/// this.
pub fn applies(lang: &str) -> bool {
    matches!(lang, "graphql" | "nginx" | "makefile" | "shellscript")
}

pub fn symbols(lang: &str, text: &str) -> Vec<Symbol> {
    match lang {
        "graphql" => graphql::symbols(text),
        "nginx" => nginx::scan(text).0,
        "makefile" => make::scan(text).0,
        "shellscript" => shell::symbols(text),
        _ => Vec::new(),
    }
}

pub fn mentions(lang: &str, text: &str) -> Vec<Mention> {
    match lang {
        "graphql" => graphql::mentions(text),
        "nginx" => nginx::scan(text).1,
        "makefile" => make::scan(text).1,
        "shellscript" => shell::mentions(text),
        _ => Vec::new(),
    }
}

mod graphql {
    use super::{Kind, Mention, Range, Symbol};
    use apollo_parser::cst::CstNode;
    use apollo_parser::{SyntaxKind, SyntaxNode};

    fn span(node: &SyntaxNode) -> Range<usize> {
        let range = node.text_range();
        range.start().into()..range.end().into()
    }

    /// The NAME under `node`, by its own characters: a NAME node also carries
    /// the whitespace and comments after it.
    fn name_of(node: &SyntaxNode) -> Option<(String, Range<usize>)> {
        let name = node
            .children()
            .find(|child| child.kind() == SyntaxKind::NAME)?;
        let token = name.first_token()?;
        let range = token.text_range();
        Some((
            token.text().to_string(),
            range.start().into()..range.end().into(),
        ))
    }

    /// A fragment's name sits one level further down, under FRAGMENT_NAME.
    fn fragment_name_of(node: &SyntaxNode) -> Option<(String, Range<usize>)> {
        name_of(
            &node
                .children()
                .find(|c| c.kind() == SyntaxKind::FRAGMENT_NAME)?,
        )
    }

    /// What an outline calls each definition, or `None` for one it leaves out.
    ///
    /// An extension is listed like the definition it extends: a schema split
    /// across modules is mostly `extend type Query`, and an outline without
    /// them would be missing most of such a file. An operation is a Module
    /// because that is a kind the reference lens does not count -- nothing in
    /// a .graphql file refers to a query by name, so a count over one would be
    /// a permanent `no refs`.
    fn kind_of(kind: SyntaxKind) -> Option<Kind> {
        use SyntaxKind as S;
        Some(match kind {
            S::OBJECT_TYPE_DEFINITION | S::OBJECT_TYPE_EXTENSION => Kind::Class,
            S::INTERFACE_TYPE_DEFINITION | S::INTERFACE_TYPE_EXTENSION => Kind::Interface,
            S::INPUT_OBJECT_TYPE_DEFINITION | S::INPUT_OBJECT_TYPE_EXTENSION => Kind::Struct,
            S::ENUM_TYPE_DEFINITION
            | S::ENUM_TYPE_EXTENSION
            | S::UNION_TYPE_DEFINITION
            | S::UNION_TYPE_EXTENSION => Kind::Enum,
            S::SCALAR_TYPE_DEFINITION | S::SCALAR_TYPE_EXTENSION => Kind::Constant,
            S::DIRECTIVE_DEFINITION | S::FRAGMENT_DEFINITION => Kind::Function,
            S::OPERATION_DEFINITION => Kind::Module,
            _ => return None,
        })
    }

    /// Fields, input fields and enum values: listed, never counted.
    fn members(definition: &SyntaxNode) -> Vec<Symbol> {
        let mut found = Vec::new();
        for node in definition.descendants() {
            let (kind, named) = match node.kind() {
                SyntaxKind::FIELD_DEFINITION => (Kind::Field, name_of(&node)),
                // Input fields only: the arguments of a field are input values
                // too, and they belong to the field, not to the type.
                SyntaxKind::INPUT_VALUE_DEFINITION
                    if node.parent().map(|p| p.kind())
                        == Some(SyntaxKind::INPUT_FIELDS_DEFINITION) =>
                {
                    (Kind::Field, name_of(&node))
                }
                SyntaxKind::ENUM_VALUE_DEFINITION => (
                    Kind::EnumMember,
                    node.children()
                        .find(|c| c.kind() == SyntaxKind::ENUM_VALUE)
                        .and_then(|value| name_of(&value)),
                ),
                _ => continue,
            };
            if let Some((name, selection)) = named {
                found.push(Symbol {
                    name,
                    kind,
                    range: span(&node),
                    selection,
                    children: Vec::new(),
                });
            }
        }
        found
    }

    pub(super) fn symbols(text: &str) -> Vec<Symbol> {
        let document = apollo_parser::Parser::new(text).parse().document();
        let mut found = Vec::new();
        for definition in document.syntax().children() {
            let Some(kind) = kind_of(definition.kind()) else {
                continue;
            };
            let named = if definition.kind() == SyntaxKind::FRAGMENT_DEFINITION {
                fragment_name_of(&definition)
            } else {
                name_of(&definition)
            };
            // An anonymous `{ me { id } }` has nothing to list it under.
            let Some((name, selection)) = named else {
                continue;
            };
            found.push(Symbol {
                name,
                kind,
                range: span(&definition),
                selection,
                children: members(&definition),
            });
        }
        found
    }

    pub(super) fn mentions(text: &str) -> Vec<Mention> {
        use SyntaxKind as S;
        let document = apollo_parser::Parser::new(text).parse().document();
        let mut found = Vec::new();
        for node in document.syntax().descendants() {
            let (space, declares, named) = match node.kind() {
                // Every place a type is named -- a field's type, `implements`,
                // a union's members, `on`, a variable's type -- is a NAMED_TYPE,
                // and a field that happens to share a type's spelling is not.
                S::NAMED_TYPE => ("type", false, name_of(&node)),
                S::OBJECT_TYPE_DEFINITION
                | S::INTERFACE_TYPE_DEFINITION
                | S::INPUT_OBJECT_TYPE_DEFINITION
                | S::ENUM_TYPE_DEFINITION
                | S::UNION_TYPE_DEFINITION
                | S::SCALAR_TYPE_DEFINITION => ("type", true, name_of(&node)),
                S::OBJECT_TYPE_EXTENSION
                | S::INTERFACE_TYPE_EXTENSION
                | S::INPUT_OBJECT_TYPE_EXTENSION
                | S::ENUM_TYPE_EXTENSION
                | S::UNION_TYPE_EXTENSION
                | S::SCALAR_TYPE_EXTENSION => ("type", false, name_of(&node)),
                S::FRAGMENT_DEFINITION => ("fragment", true, fragment_name_of(&node)),
                S::FRAGMENT_SPREAD => ("fragment", false, fragment_name_of(&node)),
                S::DIRECTIVE_DEFINITION => ("directive", true, name_of(&node)),
                S::DIRECTIVE => ("directive", false, name_of(&node)),
                _ => continue,
            };
            if let Some((name, at)) = named {
                found.push(Mention {
                    space,
                    name,
                    at,
                    declares,
                });
            }
        }
        found
    }
}

mod nginx {
    use super::{Kind, Mention, Range, Symbol};

    enum Token {
        Word(Range<usize>),
        /// `;`, `{` or `}`, and where it is.
        End(u8, usize),
    }

    /// nginx's own lexer, as far as names need it: words, quoted strings,
    /// `#` comments, and the three characters that end a statement. A `#` only
    /// starts a comment at the start of a word, and `${var}` is one word, both
    /// as `ngx_conf_read_token` has it.
    fn tokens(text: &str) -> Vec<Token> {
        let bytes = text.as_bytes();
        let mut found = Vec::new();
        let mut i = 0;
        while i < bytes.len() {
            match bytes[i] {
                b' ' | b'\t' | b'\r' | b'\n' => i += 1,
                b'#' => {
                    while i < bytes.len() && bytes[i] != b'\n' {
                        i += 1;
                    }
                }
                end @ (b';' | b'{' | b'}') => {
                    found.push(Token::End(end, i));
                    i += 1;
                }
                quote @ (b'"' | b'\'') => {
                    let start = i;
                    i += 1;
                    while i < bytes.len() && bytes[i] != quote {
                        i += if bytes[i] == b'\\' { 2 } else { 1 };
                    }
                    i = (i + 1).min(bytes.len());
                    found.push(Token::Word(start..i));
                }
                _ => {
                    let start = i;
                    while i < bytes.len()
                        && !matches!(bytes[i], b' ' | b'\t' | b'\r' | b'\n' | b';' | b'{' | b'}')
                    {
                        if bytes[i] == b'$' && bytes.get(i + 1) == Some(&b'{') {
                            while i < bytes.len() && bytes[i] != b'}' {
                                i += 1;
                            }
                        } else if bytes[i] == b'\\' {
                            i += 1;
                        }
                        i += 1;
                    }
                    found.push(Token::Word(start..i.min(bytes.len())));
                }
            }
        }
        found
    }

    /// Every `$name` and `${name}` inside one word, quoted or not.
    fn variables(text: &str, word: &Range<usize>, found: &mut Vec<(String, Range<usize>)>) {
        let bytes = text.as_bytes();
        let ident = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
        let mut i = word.start;
        while i < word.end {
            if bytes[i] != b'$' {
                i += 1;
                continue;
            }
            let start = i;
            let (from, braced) = if bytes.get(i + 1) == Some(&b'{') {
                (i + 2, true)
            } else {
                (i + 1, false)
            };
            let mut end = from;
            while end < word.end && ident(bytes[end]) {
                end += 1;
            }
            if end > from {
                let close = usize::from(braced && bytes.get(end) == Some(&b'}'));
                found.push((text[from..end].to_string(), start..end + close));
            }
            i = end.max(i + 1);
        }
    }

    /// The upstream a `*_pass` names: `http://api/v1` -> `api`. A variable, a
    /// socket or an address simply names no upstream anyone declared.
    fn pass_target(text: &str, word: &Range<usize>) -> Option<Range<usize>> {
        let raw = &text[word.clone()];
        let host_at = raw.find("://").map_or(0, |i| i + 3);
        let host = &raw[host_at..];
        let len = host.find(['/', ':', '?']).unwrap_or(host.len());
        (len > 0 && !host[..len].contains('$'))
            .then(|| word.start + host_at..word.start + host_at + len)
    }

    /// `zone=perip:10m` -> `perip`, for the parameter that names a zone.
    fn parameter(text: &str, word: &Range<usize>, key: &str) -> Option<Range<usize>> {
        let value = text[word.clone()].strip_prefix(key)?;
        let len = value.find(':').unwrap_or(value.len());
        let start = word.start + key.len();
        (len > 0).then_some(start..start + len)
    }

    /// The zone families: the directive that declares one, the parameter that
    /// names it there, and the directive that uses it.
    const ZONES: &[(&str, &str, &str)] = &[
        ("limit_req_zone", "zone=", "limit_req"),
        ("limit_conn_zone", "zone=", "limit_conn"),
        ("proxy_cache_path", "keys_zone=", "proxy_cache"),
        ("fastcgi_cache_path", "keys_zone=", "fastcgi_cache"),
        ("uwsgi_cache_path", "keys_zone=", "uwsgi_cache"),
        ("scgi_cache_path", "keys_zone=", "scgi_cache"),
    ];

    const PASSES: &[&str] = &[
        "proxy_pass",
        "grpc_pass",
        "fastcgi_pass",
        "uwsgi_pass",
        "scgi_pass",
        "memcached_pass",
    ];

    /// Which argument a directive declares a variable in.
    fn declared_variable(directive: &str, args: usize) -> Option<usize> {
        match directive {
            "set" | "auth_request_set" | "js_set" | "perl_set" => Some(0),
            "map" | "split_clients" => Some(1),
            // `geo $var {` or `geo $address $var {`: the last one.
            "geo" => args.checked_sub(1),
            _ => None,
        }
    }

    /// The outline and every mention, from one pass over the statements.
    ///
    /// The outline is flat on purpose: http > server > location is three levels
    /// before the first named location, and the reference lens counts no deeper
    /// than two. What is listed is what can be named from elsewhere.
    pub(super) fn scan(text: &str) -> (Vec<Symbol>, Vec<Mention>) {
        let mut symbols: Vec<Symbol> = Vec::new();
        let mut mentions = Vec::new();
        // For each open block, the symbol it declared, so `}` can close its range.
        let mut open: Vec<Option<usize>> = Vec::new();
        let mut words: Vec<Range<usize>> = Vec::new();
        for token in tokens(text) {
            let (end, at) = match token {
                Token::Word(word) => {
                    words.push(word);
                    continue;
                }
                Token::End(end, at) => (end, at),
            };
            if end == b'}' {
                if let Some(Some(index)) = open.pop() {
                    symbols[index].range.end = at + 1;
                }
                words.clear();
                continue;
            }
            let Some(first) = words.first().cloned() else {
                if end == b'{' {
                    open.push(None);
                }
                continue;
            };
            let directive = &text[first.clone()];
            let args = &words[1..];
            let mut declared: Option<(Kind, &'static str, Range<usize>, String)> = None;
            let mut mention = |space: &'static str, at: Range<usize>, declares: bool| {
                mentions.push(Mention {
                    space,
                    name: text[at.clone()].to_string(),
                    at,
                    declares,
                });
            };

            if directive == "upstream" {
                if let Some(name) = args.first() {
                    mention("upstream", name.clone(), true);
                    declared = Some((
                        Kind::Struct,
                        "upstream",
                        name.clone(),
                        text[name.clone()].to_string(),
                    ));
                }
            } else if PASSES.contains(&directive) {
                if let Some(target) = args.first().and_then(|word| pass_target(text, word)) {
                    mention("upstream", target, false);
                }
            } else if directive == "log_format" {
                if let Some(name) = args.first() {
                    mention("log_format", name.clone(), true);
                    declared = Some((
                        Kind::Constant,
                        "log_format",
                        name.clone(),
                        text[name.clone()].to_string(),
                    ));
                }
            } else if directive == "access_log" {
                if let Some(format) = args
                    .get(1)
                    .filter(|word| !text[(*word).clone()].contains('='))
                {
                    mention("log_format", format.clone(), false);
                }
            }
            for &(declarer, key, space) in ZONES {
                if directive == declarer {
                    if let Some(name) = args.iter().find_map(|word| parameter(text, word, key)) {
                        mention(space, name.clone(), true);
                        declared =
                            Some((Kind::Constant, space, name.clone(), text[name].to_string()));
                    }
                } else if directive == space {
                    // `limit_req zone=perip`, and `limit_conn perip 10` or
                    // `proxy_cache one`, which name it bare.
                    let named = if space == "limit_req" {
                        args.iter().find_map(|word| parameter(text, word, "zone="))
                    } else {
                        args.first()
                            .filter(|word| {
                                let word = &text[(*word).clone()];
                                word != "off" && !word.contains('$')
                            })
                            .cloned()
                    };
                    if let Some(name) = named {
                        mention(space, name, false);
                    }
                }
            }
            // A named location is declared by `location @x` and used as a whole
            // word anywhere else: `try_files $uri @x`, `error_page 404 = @x`.
            for (index, word) in args.iter().enumerate() {
                if !text[word.clone()].starts_with('@') {
                    continue;
                }
                let declares = directive == "location" && index == 0;
                mention("location", word.clone(), declares);
                if declares {
                    declared = Some((
                        Kind::Function,
                        "location",
                        word.clone(),
                        text[word.clone()].to_string(),
                    ));
                }
            }
            let declaring = declared_variable(directive, args.len());
            for (index, word) in args.iter().enumerate() {
                let mut found = Vec::new();
                variables(text, word, &mut found);
                for (name, at) in found {
                    let declares = declaring == Some(index);
                    if declares {
                        declared =
                            Some((Kind::Variable, "variable", at.clone(), format!("${name}")));
                    }
                    mentions.push(Mention {
                        space: "variable",
                        name,
                        at,
                        declares,
                    });
                }
            }

            let symbol = declared.map(|(kind, _, selection, name)| {
                symbols.push(Symbol {
                    name,
                    kind,
                    range: first.start..at + 1,
                    selection,
                    children: Vec::new(),
                });
                symbols.len() - 1
            });
            if end == b'{' {
                open.push(symbol);
            }
            words.clear();
        }
        (symbols, mentions)
    }
}

/// The tree-sitter half Makefiles and shell share.
mod tree {
    use tree_sitter::{Language, Node, Tree};

    pub(super) fn parse(language: Language, text: &str) -> Option<Tree> {
        let mut parser = tree_sitter::Parser::new();
        parser.set_language(&language).ok()?;
        parser.parse(text, None)
    }

    /// Every node, in document order. A cursor rather than recursion: a
    /// generated script can nest deeper than a thread's stack.
    pub(super) fn each(tree: &Tree, mut visit: impl FnMut(Node)) {
        let mut cursor = tree.walk();
        loop {
            visit(cursor.node());
            if cursor.goto_first_child() {
                continue;
            }
            loop {
                if cursor.goto_next_sibling() {
                    break;
                }
                if !cursor.goto_parent() {
                    return;
                }
            }
        }
    }

    /// The one named child, when it is a plain `word`: `$(CC)` names CC, while
    /// `$($(X)_FLAGS)` names something only make knows once it runs.
    pub(super) fn only_word(node: Node) -> Option<Node> {
        let child = node.named_child(0)?;
        (node.named_child_count() == 1 && child.kind() == "word").then_some(child)
    }

    pub(super) fn has_child(node: Node, kind: &str) -> bool {
        let mut cursor = node.walk();
        let found = node.children(&mut cursor).any(|child| child.kind() == kind);
        found
    }

    /// A node's span without the newline tree-sitter counts as part of a
    /// statement, so an outline entry ends on its own last line.
    pub(super) fn span(node: Node, text: &str) -> std::ops::Range<usize> {
        let range = node.byte_range();
        range.start..range.start + text[range.clone()].trim_end().len()
    }
}

mod make {
    use super::{tree, Kind, Mention, Range, Symbol};
    use std::collections::HashSet;
    use tree_sitter::Node;

    /// `.PHONY`, `.DEFAULT`, `.ONESHELL`: an instruction to make, not a target
    /// anyone builds.
    fn special(name: &str) -> bool {
        name.strip_prefix('.').is_some_and(|rest| {
            !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_uppercase() || b == b'_')
        })
    }

    /// The variable a function takes by name rather than by `$()`:
    /// `$(call greet,x)`, `$(value greet)`, `$(origin CC)`, `$(flavor CC)`.
    fn named_argument(node: Node, text: &str) -> Option<Range<usize>> {
        let function = node.child_by_field_name("function")?;
        if !matches!(function.kind(), "call" | "value" | "origin" | "flavor") {
            return None;
        }
        let mut cursor = node.walk();
        let arguments = node
            .children(&mut cursor)
            .find(|child| child.kind() == "arguments")?;
        let raw = &text[arguments.byte_range()];
        let start = arguments.start_byte() + (raw.len() - raw.trim_start().len());
        let rest = &text[start..arguments.end_byte()];
        let len = rest.find([',', ' ', '\t', '\n']).unwrap_or(rest.len());
        (len > 0 && !rest[..len].contains('$')).then_some(start..start + len)
    }

    /// The outline and every mention.
    ///
    /// Two namespaces, as make has them: a target and a variable may share a
    /// spelling (`test: ; $(test)`) without being each other. A declaration is
    /// a rule's target or an assignment; `+=` is not one, because it appends to
    /// a variable somebody else declared -- often the environment or an
    /// included file -- and counting it would put a second lens on every
    /// `CFLAGS += -Wall`. Patterns (`%.o`) and special targets are left out:
    /// nothing names them.
    ///
    /// The outline lists the first declaration of each name. A target with two
    /// rules, or a variable assigned in both branches of an `ifeq`, is one
    /// name, and two entries would be two lenses showing the same count.
    pub(super) fn scan(text: &str) -> (Vec<Symbol>, Vec<Mention>) {
        let mut symbols = Vec::new();
        let mut mentions = Vec::new();
        let Some(tree) = tree::parse(tree_sitter_make::LANGUAGE.into(), text) else {
            return (symbols, mentions);
        };
        let mut listed = HashSet::new();
        let mut push = |space: &'static str, at: Range<usize>, declared: Option<(Kind, Node)>| {
            let name = text[at.clone()].to_string();
            if let Some((kind, node)) = declared {
                if listed.insert((space, name.clone())) {
                    symbols.push(Symbol {
                        name: name.clone(),
                        kind,
                        range: tree::span(node, text),
                        selection: at.clone(),
                        children: Vec::new(),
                    });
                }
            }
            mentions.push(Mention {
                space,
                name,
                at,
                declares: declared.is_some(),
            });
        };
        tree::each(&tree, |node| match node.kind() {
            "rule" => {
                let mut cursor = node.walk();
                for part in node.children(&mut cursor) {
                    let declares = match part.kind() {
                        "targets" => true,
                        "prerequisites" => false,
                        _ => continue,
                    };
                    // Direct words only: `build/$(NAME).o` is a concatenation,
                    // a file name make computes rather than one anyone types.
                    let mut words = part.walk();
                    for word in part.children(&mut words).filter(|w| w.kind() == "word") {
                        let name = &text[word.byte_range()];
                        if name.contains('%') || special(name) {
                            continue;
                        }
                        push(
                            "target",
                            word.byte_range(),
                            declares.then_some((Kind::Function, node)),
                        );
                    }
                }
            }
            "variable_assignment" => {
                if let Some(name) = node.child_by_field_name("name") {
                    let appends = node
                        .child_by_field_name("operator")
                        .is_some_and(|operator| operator.kind() == "+=");
                    push(
                        "variable",
                        name.byte_range(),
                        (!appends).then_some((Kind::Variable, node)),
                    );
                }
            }
            "define_directive" => {
                if let Some(name) = node.child_by_field_name("name") {
                    push("variable", name.byte_range(), Some((Kind::Function, node)));
                }
            }
            "variable_reference" => {
                if let Some(word) = tree::only_word(node) {
                    push("variable", word.byte_range(), None);
                }
            }
            "substitution_reference" => {
                if let Some(word) = node
                    .child_by_field_name("text")
                    .filter(|w| w.kind() == "word")
                {
                    push("variable", word.byte_range(), None);
                }
            }
            "ifdef_directive" | "ifndef_directive" => {
                if let Some(word) = node
                    .child_by_field_name("variable")
                    .filter(|w| w.kind() == "word")
                {
                    push("variable", word.byte_range(), None);
                }
            }
            "function_call" => {
                if let Some(at) = named_argument(node, text) {
                    push("variable", at, None);
                }
            }
            _ => {}
        });
        (symbols, mentions)
    }
}

mod shell {
    use super::{tree, Kind, Mention, Symbol};
    use std::collections::HashSet;
    use tree_sitter::Node;

    /// The script's functions, each listed once.
    ///
    /// Functions only. A variable is a name poly cannot scope: every function's
    /// `local x` would be an entry of its own, and a lens over `NAME=world`
    /// would count the `$NAME` of a function that declares its own. A function
    /// defined twice -- in both branches of an `if` -- is listed at its first
    /// definition, as make lists a target with two rules: two entries would be
    /// two lenses showing the same count.
    pub(super) fn symbols(text: &str) -> Vec<Symbol> {
        let mut found = Vec::new();
        let Some(tree) = tree::parse(tree_sitter_bash::LANGUAGE.into(), text) else {
            return found;
        };
        let mut listed = HashSet::new();
        tree::each(&tree, |node| {
            if node.kind() != "function_definition" {
                return;
            }
            let Some(name) = node.child_by_field_name("name") else {
                return;
            };
            let spelled = text[name.byte_range()].to_string();
            if listed.insert(spelled.clone()) {
                found.push(Symbol {
                    name: spelled,
                    kind: Kind::Function,
                    range: tree::span(node, text),
                    selection: name.byte_range(),
                    children: Vec::new(),
                });
            }
        });
        found
    }

    fn identifier(word: &str) -> bool {
        let mut bytes = word.bytes();
        bytes
            .next()
            .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
            && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
    }

    /// Is this `$name`'s `name` where the variable is given a value?
    ///
    /// `x=1`, `local x`, `export X`, `for x in`. `x+=1` is not: it appends to
    /// an `x` that is already somewhere, which is where Go to Definition
    /// should land.
    fn declares(node: Node) -> bool {
        let Some(parent) = node.parent() else {
            return false;
        };
        match parent.kind() {
            "variable_assignment" => {
                parent.child_by_field_name("name") == Some(node) && !tree::has_child(parent, "+=")
            }
            "declaration_command" => true,
            "for_statement" | "select_statement" => {
                parent.child_by_field_name("variable") == Some(node)
            }
            _ => false,
        }
    }

    /// The variables a builtin assigns by name, as plain words:
    /// `read -r line rest`, `mapfile -t lines`, `getopts "ab:" opt`,
    /// `printf -v out`.
    fn assigned<'t>(command: &str, arguments: &[Node<'t>], text: &str) -> Vec<Node<'t>> {
        let word = |node: &Node| node.kind() == "word" && identifier(&text[node.byte_range()]);
        match command {
            "read" | "mapfile" | "readarray" => arguments.iter().copied().filter(word).collect(),
            "getopts" => arguments.get(1).copied().filter(word).into_iter().collect(),
            "printf" => arguments
                .windows(2)
                .filter(|pair| &text[pair[0].byte_range()] == "-v")
                .map(|pair| pair[1])
                .filter(word)
                .collect(),
            _ => Vec::new(),
        }
    }

    /// Functions and variables, each where it is written.
    ///
    /// Every command is a mention of the function it might be: `ls` and `echo`
    /// are mentions of functions nobody declared, which costs nothing, and
    /// telling them apart from the script's own functions is exactly the
    /// resolution this file does not do.
    pub(super) fn mentions(text: &str) -> Vec<Mention> {
        let mut found = Vec::new();
        let Some(tree) = tree::parse(tree_sitter_bash::LANGUAGE.into(), text) else {
            return found;
        };
        let mut push = |space: &'static str, node: Node, declares: bool| {
            found.push(Mention {
                space,
                name: text[node.byte_range()].to_string(),
                at: node.byte_range(),
                declares,
            });
        };
        tree::each(&tree, |node| match node.kind() {
            "function_definition" => {
                if let Some(name) = node.child_by_field_name("name") {
                    push("function", name, true);
                }
            }
            "command_name" => {
                if let Some(word) = tree::only_word(node) {
                    push("function", word, false);
                }
            }
            "variable_name" => push("variable", node, declares(node)),
            "command" => {
                let Some(name) = node.child_by_field_name("name") else {
                    return;
                };
                let mut cursor = node.walk();
                let arguments: Vec<Node> = node
                    .children_by_field_name("argument", &mut cursor)
                    .collect();
                for variable in assigned(&text[name.byte_range()], &arguments, text) {
                    push("variable", variable, true);
                }
            }
            _ => {}
        });
        found
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each mention's own text, so a test reads as what a person sees.
    fn named<'a>(
        text: &'a str,
        found: &[Mention],
        space: &str,
        name: &str,
    ) -> Vec<(&'a str, bool)> {
        found
            .iter()
            .filter(|m| m.space == space && m.name == name)
            .map(|m| (&text[m.at.clone()], m.declares))
            .collect()
    }

    const SCHEMA: &str = r#"
"A person."
type User implements Node @auth {
  id: ID!
  User: String
  posts(first: Int): [Post!]!
}
interface Node { id: ID! }
type Post { author: User }
union Result = User | Post
input UserFilter { name: String }
enum Role { ADMIN USER }
scalar DateTime
directive @auth on OBJECT
extend type Query { me: User }
fragment Basic on User { id ...More }
fragment More on User { id }
query Me { me { ...Basic } }
{ anonymous }
"#;

    /// The names of a schema and where it uses them: every place a type is
    /// named counts, and a field that happens to be spelt like a type does not.
    #[test]
    fn graphql_types_fragments_and_directives_are_found_where_they_are_written() {
        let found = mentions("graphql", SCHEMA);
        assert_eq!(
            named(SCHEMA, &found, "type", "User"),
            // The declaration, `me: User` in Query, `author: User`, the union
            // member and the two fragments' `on User`. Not the field `User:`.
            vec![
                ("User", true),
                ("User", false),
                ("User", false),
                ("User", false),
                ("User", false),
                ("User", false)
            ]
        );
        assert_eq!(
            named(SCHEMA, &found, "type", "Node"),
            vec![("Node", false), ("Node", true)]
        );
        assert_eq!(
            named(SCHEMA, &found, "fragment", "More"),
            vec![("More", false), ("More", true)]
        );
        assert_eq!(
            named(SCHEMA, &found, "directive", "auth"),
            vec![("auth", false), ("auth", true)]
        );
        // The extension names Query without declaring it.
        assert_eq!(
            named(SCHEMA, &found, "type", "Query"),
            vec![("Query", false)]
        );
    }

    #[test]
    fn a_graphql_outline_lists_definitions_with_their_members() {
        let outline = symbols("graphql", SCHEMA);
        let top: Vec<(&str, Kind)> = outline.iter().map(|s| (s.name.as_str(), s.kind)).collect();
        assert_eq!(
            top,
            vec![
                ("User", Kind::Class),
                ("Node", Kind::Interface),
                ("Post", Kind::Class),
                ("Result", Kind::Enum),
                ("UserFilter", Kind::Struct),
                ("Role", Kind::Enum),
                ("DateTime", Kind::Constant),
                ("auth", Kind::Function),
                ("Query", Kind::Class),
                ("Basic", Kind::Function),
                ("More", Kind::Function),
                ("Me", Kind::Module),
            ]
        );
        let user = &outline[0];
        let members: Vec<&str> = user.children.iter().map(|s| s.name.as_str()).collect();
        // `first` is the argument of `posts`, not a field of User.
        assert_eq!(members, vec!["id", "User", "posts"]);
        assert_eq!(&SCHEMA[user.selection.clone()], "User");
        assert!(user.range.start <= user.selection.start && user.selection.end <= user.range.end);
        let role: Vec<&str> = outline[5]
            .children
            .iter()
            .map(|s| s.name.as_str())
            .collect();
        assert_eq!(role, vec!["ADMIN", "USER"]);
    }

    const NGINX: &str = r#"
upstream api { server 127.0.0.1:8080; }
log_format main '$remote_addr "$request"';
limit_req_zone $binary_remote_addr zone=perip:10m rate=1r/s;
proxy_cache_path /tmp/c keys_zone=one:10m;
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
server {
    set $target "api";
    access_log /var/log/x.log main;
    # proxy_pass http://api;
    location / {
        proxy_pass http://api/v1;
        proxy_cache one;
        limit_req zone=perip burst=5;
        proxy_set_header Connection ${connection_upgrade};
        try_files $uri @fallback;
    }
    location @fallback { return 404; }
}
"#;

    /// Each family declared once and used where nginx reads it from -- and
    /// nothing from the commented-out line.
    #[test]
    fn nginx_names_are_found_where_they_are_declared_and_used() {
        let found = mentions("nginx", NGINX);
        assert_eq!(
            named(NGINX, &found, "upstream", "api"),
            vec![("api", true), ("api", false)]
        );
        assert_eq!(
            named(NGINX, &found, "log_format", "main"),
            vec![("main", true), ("main", false)]
        );
        assert_eq!(
            named(NGINX, &found, "limit_req", "perip"),
            vec![("perip", true), ("perip", false)]
        );
        assert_eq!(
            named(NGINX, &found, "proxy_cache", "one"),
            vec![("one", true), ("one", false)]
        );
        assert_eq!(
            named(NGINX, &found, "variable", "connection_upgrade"),
            vec![
                ("$connection_upgrade", true),
                ("${connection_upgrade}", false)
            ]
        );
        assert_eq!(
            named(NGINX, &found, "location", "@fallback"),
            vec![("@fallback", false), ("@fallback", true)]
        );
        // Inside a quoted string, as nginx expands it.
        assert_eq!(
            named(NGINX, &found, "variable", "request"),
            vec![("$request", false)]
        );
    }

    #[test]
    fn an_nginx_outline_is_what_can_be_named_from_elsewhere() {
        let outline = symbols("nginx", NGINX);
        let listed: Vec<(&str, Kind)> = outline.iter().map(|s| (s.name.as_str(), s.kind)).collect();
        assert_eq!(
            listed,
            vec![
                ("api", Kind::Struct),
                ("main", Kind::Constant),
                ("perip", Kind::Constant),
                ("one", Kind::Constant),
                ("$connection_upgrade", Kind::Variable),
                ("$target", Kind::Variable),
                ("@fallback", Kind::Function),
            ]
        );
        // A block's range runs to its closing brace.
        let api = &outline[0];
        assert_eq!(
            &NGINX[api.range.clone()],
            "upstream api { server 127.0.0.1:8080; }"
        );
        for symbol in &outline {
            assert!(
                symbol.range.start <= symbol.selection.start
                    && symbol.selection.end <= symbol.range.end
            );
        }
    }

    const MAKEFILE: &str = "CC ?= gcc
OBJS := a.o b.o
CFLAGS += -Wall
define greet
echo $(1)
endef
.PHONY: all clean
all: build $(OBJS)
\t$(CC) $(CFLAGS) -o $@ $^
\t$(call greet,hi)
build: ; echo ${CC} $$HOME
%.o: %.c
\t$(CC) -c $<
clean:
\trm -f $(OBJS:.o=.d)
ifdef CC
CC = clang
endif
";

    /// Targets and variables are two namespaces, each declared where make
    /// gives it a value and used wherever make reads it -- `.PHONY`'s list
    /// included, `$$HOME` (the shell's) and the `%.o` pattern not.
    #[test]
    fn make_targets_and_variables_are_found_where_they_are_written() {
        let found = mentions("makefile", MAKEFILE);
        assert_eq!(
            named(MAKEFILE, &found, "target", "all"),
            vec![("all", false), ("all", true)]
        );
        assert_eq!(
            named(MAKEFILE, &found, "target", "build"),
            vec![("build", false), ("build", true)]
        );
        assert_eq!(
            named(MAKEFILE, &found, "variable", "CC"),
            vec![
                ("CC", true),
                ("CC", false),
                ("CC", false),
                ("CC", false),
                ("CC", false),
                ("CC", true)
            ]
        );
        // Appending is a use: the declaration is somebody else's.
        assert_eq!(
            named(MAKEFILE, &found, "variable", "CFLAGS"),
            vec![("CFLAGS", false), ("CFLAGS", false)]
        );
        // `$(call greet,...)` names the macro bare.
        assert_eq!(
            named(MAKEFILE, &found, "variable", "greet"),
            vec![("greet", true), ("greet", false)]
        );
        // `$(OBJS:.o=.d)` is a reference too.
        assert_eq!(
            named(MAKEFILE, &found, "variable", "OBJS"),
            vec![("OBJS", true), ("OBJS", false), ("OBJS", false)]
        );
        assert!(found
            .iter()
            .all(|m| !m.name.contains('%') && m.name != ".PHONY" && m.name != "HOME"));
    }

    #[test]
    fn a_make_outline_lists_each_name_once() {
        let outline = symbols("makefile", MAKEFILE);
        let listed: Vec<(&str, Kind)> = outline.iter().map(|s| (s.name.as_str(), s.kind)).collect();
        assert_eq!(
            listed,
            vec![
                ("CC", Kind::Variable),
                ("OBJS", Kind::Variable),
                ("greet", Kind::Function),
                ("all", Kind::Function),
                ("build", Kind::Function),
                ("clean", Kind::Function),
            ]
        );
        // A rule's range is its recipe too, and stops before the next line.
        let all = &outline[3];
        assert_eq!(
            &MAKEFILE[all.range.clone()],
            "all: build $(OBJS)\n\t$(CC) $(CFLAGS) -o $@ $^\n\t$(call greet,hi)"
        );
        for symbol in &outline {
            assert!(
                symbol.range.start <= symbol.selection.start
                    && symbol.selection.end <= symbol.range.end
            );
        }
    }

    const SCRIPT: &str = r#"NAME=world
greet() { local who=$1; echo "hi $who ${NAME}"; }
function main {
  read -r line
  for f in *.txt; do greet "$f"; done
  NAME+=!
  while getopts "a:" opt; do echo "$opt"; done
  cat <<EOF
$line
EOF
  echo '$NAME'
}
main "$@"
"#;

    /// Functions are declared by their definition and used as a command;
    /// variables are declared wherever the shell assigns one by name --
    /// `local`, `for`, `read`, `getopts` -- and a single-quoted `$NAME` is
    /// text, not a use.
    #[test]
    fn shell_functions_and_variables_are_found_where_they_are_written() {
        let found = mentions("shellscript", SCRIPT);
        assert_eq!(
            named(SCRIPT, &found, "function", "greet"),
            vec![("greet", true), ("greet", false)]
        );
        assert_eq!(
            named(SCRIPT, &found, "function", "main"),
            vec![("main", true), ("main", false)]
        );
        assert_eq!(
            named(SCRIPT, &found, "variable", "NAME"),
            vec![("NAME", true), ("NAME", false), ("NAME", false)]
        );
        for variable in ["who", "line", "f", "opt"] {
            assert_eq!(
                named(SCRIPT, &found, "variable", variable),
                vec![(variable, true), (variable, false)],
                "{variable}"
            );
        }
    }

    /// The outline is the functions, by their name, under both ways of writing
    /// one -- `function main {` begins with a keyword, and the lens asks at the
    /// name. Variables are left out: nothing here can tell one `local x` from
    /// another function's.
    #[test]
    fn a_shell_outline_lists_each_function_once() {
        let script = format!("{SCRIPT}if true; then greet() {{ :; }}; fi\n");
        let outline = symbols("shellscript", &script);
        let listed: Vec<(&str, Kind)> = outline.iter().map(|s| (s.name.as_str(), s.kind)).collect();
        assert_eq!(
            listed,
            vec![("greet", Kind::Function), ("main", Kind::Function)]
        );
        assert_eq!(&script[outline[1].selection.clone()], "main");
        assert!(script[outline[1].range.clone()].starts_with("function main {"));
        assert!(script[outline[1].range.clone()].ends_with('}'));
    }

    #[test]
    fn other_languages_have_nothing_here() {
        assert!(!applies("yaml"));
        assert!(symbols("yaml", "a: 1").is_empty());
        assert!(mentions("lua", "local a = 1").is_empty());
    }
}
