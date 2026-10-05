//! poly's own outline and references, for the two languages no language server
//! answers them for.
//!
//! Everywhere else poly counts answers somebody else produced: the reference
//! lens asks the editor, and the editor asks gopls or lua-language-server
//! through `poly lsp`'s proxy. GraphQL and nginx are the exception, taken on
//! purpose on 2026-10-05: graphql-language-service-server never implemented
//! `textDocument/references` and answers nothing at all without a
//! graphql-config, and no nginx server answers references.
//!
//! What is here is the cheap half of a language server and deliberately no
//! more: names and where they are written. No types, no scopes, no resolution
//! -- a mention is a namespace and a spelling, and two mentions are the same
//! thing when both agree. That is exact for GraphQL, whose type, fragment and
//! directive names are global by the spec, and as close as nginx gets: its
//! variables, upstreams and zones are global to the configuration too.

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

/// Does poly answer outline and references for `lang` itself?
pub fn applies(lang: &str) -> bool {
    matches!(lang, "graphql" | "nginx")
}

pub fn symbols(lang: &str, text: &str) -> Vec<Symbol> {
    match lang {
        "graphql" => graphql::symbols(text),
        "nginx" => nginx::scan(text).0,
        _ => Vec::new(),
    }
}

pub fn mentions(lang: &str, text: &str) -> Vec<Mention> {
    match lang {
        "graphql" => graphql::mentions(text),
        "nginx" => nginx::scan(text).1,
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

    #[test]
    fn other_languages_have_nothing_here() {
        assert!(!applies("yaml"));
        assert!(symbols("yaml", "a: 1").is_empty());
        assert!(mentions("lua", "local a = 1").is_empty());
    }
}
