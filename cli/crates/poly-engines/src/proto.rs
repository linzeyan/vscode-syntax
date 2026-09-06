//! poly's own lint rules for protobuf, over protox-parse's descriptor.
//!
//! The third engine that is not a substitution, and the one with the most to
//! say about why. `buf lint` is Go and cannot be linked in, so these rules are
//! written here and their codes are poly's own -- `proto-field-lower-snake-case`,
//! not `buf/FIELD_LOWER_SNAKE_CASE`. What makes this different from the
//! Dockerfile and workflow engines is that buf *was* running until now, so the
//! boundary of what poly reproduces is a promise poly has to keep rather than a
//! blank sheet. `RULES` says what is here; `poly.example.toml` names what is
//! not, and why each group of it was left out.
//!
//! Everything here is single-file. protox-parse reads one `.proto` with no
//! import resolution, which is exactly the scope of these fourteen rules; the
//! eleven buf rules that need the rest of the module (`PACKAGE_SAME_*`,
//! `RPC_REQUEST_RESPONSE_UNIQUE`, `DIRECTORY_SAME_PACKAGE`, …) and the three
//! that need resolved imports (`IMPORT_USED`, `PACKAGE_NO_IMPORT_CYCLE`,
//! `PROTOVALIDATE`) are not reproduced and are named in `poly.example.toml`.
//!
//! Unlike those two engines, this one reads the project's own configuration:
//! `buf.yaml`'s `lint` section selects among the rules below. That is the same
//! move poly already makes for ruff, typos and selene, and for the same reason
//! -- a project that enabled exactly one buf rule must not start getting
//! fourteen because poly changed how it runs them. See `Policy`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use poly_core::diag::{Issue, Severity};
use prost_types::{
    field_descriptor_proto::Label, source_code_info::Location, DescriptorProto,
    EnumDescriptorProto, FileDescriptorProto, ServiceDescriptorProto,
};
use serde::Deserialize;

/// Every protobuf rule poly has, with the prose `lint::rule_doc` serves for it.
///
/// One table rather than a doc comment beside each emitter, for the reason
/// `DOCKER_RULES` is one table: poly's own rules have no documentation site, so
/// an undocumented code reaches a reader as a few words in a terminal with
/// nothing behind them. `every_proto_rule_is_documented` holds this list and the
/// codes the linter emits to the same set, in both directions.
///
/// # What the severities mean here
///
/// The Dockerfile tiers are about a build; protobuf has no build, so the same
/// three questions have to be asked of a schema instead:
///
/// * `Error` -- protoc rejects the file, so nothing downstream of it exists.
///   **Nothing is in this tier.** The one candidate was reporting a parse
///   failure as a syntax error, and it fires on valid input this parser cannot
///   read: `edition = "2023"` files, and a `descriptor.proto` new enough to use
///   extension declarations. `proto-unreadable` says the weaker, true thing
///   instead.
/// * `Warning` -- it compiles, and the schema is wrong in a way a consumer pays
///   for: a name that changes the generated accessor and the JSON field name in
///   every language at once, a `required` field that can never be removed, a
///   public import that re-exports somebody else's file, an enum whose JSON
///   round trip is lossy, a missing `package` that puts every symbol in the
///   global namespace. **Every rule below.**
/// * `Info` -- it compiles, it behaves, and changing it changes nothing anyone
///   can observe. **Nothing is in this tier either**, and that is the point:
///   the rules that would land here are buf's `ENUM_VALUE_PREFIX`,
///   `PACKAGE_VERSION_SUFFIX` and the rest of its suffix conventions, which are
///   declined rather than demoted.
pub const RULES: &[(&str, Severity, &str)] = &[
    (
        "proto-enum-allow-alias",
        Severity::Warning,
        "`option allow_alias = true` lets two names share one number. On the \
         wire there is only the number, so a decoder has to pick one name to \
         hand back and the other is unreachable -- a value written as \
         `STATUS_CANCELLED` comes out of the JSON encoder as `STATUS_ABORTED`, \
         and a round trip through JSON silently rewrites the document. The \
         alias is usually there to rename a value without breaking anyone; a \
         `reserved` on the old name and a deprecation say the same thing \
         without making the encoding ambiguous.",
    ),
    (
        "proto-enum-first-value-nonzero",
        Severity::Warning,
        "The first value of an enum is its default: a field of that type that \
         was never set decodes as whatever value comes first, and there is no \
         way to tell that apart from someone setting it deliberately. When the \
         first value is not `0` the enum also cannot move to proto3 or to \
         editions without renumbering, because both require a zero value -- so \
         a decision taken once in a proto2 file becomes a wire break years \
         later. Put an explicit zero value first and let it mean \"nobody \
         said\".",
    ),
    (
        "proto-enum-pascal-case",
        Severity::Warning,
        "An enum's name is a type name in every language protoc generates, and \
         each generator applies its own transformation to whatever is here. \
         `badEnum` becomes `BadEnum` in Go and C#, stays `badEnum` in Java, and \
         reaches Python as written -- so the name a caller has to type differs \
         by language for no reason anybody chose. PascalCase is the one \
         spelling every generator leaves alone.",
    ),
    (
        "proto-enum-value-upper-snake-case",
        Severity::Warning,
        "Enum value names share a namespace with their siblings in C++ and are \
         emitted as constants everywhere else, and the generators assume \
         UPPER_SNAKE_CASE when they split the name up -- Go strips the enum's \
         prefix, C# re-cases it. A `lowerValue` survives that unevenly and \
         arrives as a different identifier in each language. This is also the \
         spelling the JSON encoding uses verbatim, so it is what appears on the \
         wire.",
    ),
    (
        "proto-field-lower-snake-case",
        Severity::Warning,
        "A field's name is the one thing about it that reaches every consumer \
         unaltered: the JSON encoding uses it verbatim as `lowerCamelCase` \
         derived from the snake_case spelling, and every generator derives its \
         accessor from it. `BadField` gives a JSON name of `BadField` rather \
         than `badField`, so a document written by one language's encoder and \
         read by another's stops matching. lower_snake_case is the spelling all \
         of that machinery is written for.",
    ),
    (
        "proto-field-required",
        Severity::Warning,
        "A proto2 `required` field can never be removed, and never made \
         optional, for as long as any peer still runs the old schema: a message \
         missing it fails to parse outright rather than arriving with the field \
         unset. That turns a routine field removal into a coordinated shutdown, \
         which is why proto3 dropped the keyword and editions kept it only as \
         `LEGACY_REQUIRED`. `optional` with a check in the application says the \
         same thing and can be undone.",
    ),
    (
        "proto-import-public",
        Severity::Warning,
        "`import public` re-exports everything the imported file declares, so a \
         file importing yours also gets that one, transitively and invisibly. \
         Nothing in the importing file says where those types came from, and \
         removing the public import later breaks files that never mentioned it. \
         It exists for one job -- keeping a moved file's old path working -- and \
         is a dependency nobody can see anywhere else.",
    ),
    (
        "proto-message-pascal-case",
        Severity::Warning,
        "A message's name is a type name in every language protoc generates, and \
         each generator re-cases it differently: `myMessage` reaches Go and C# \
         as `MyMessage` and Java as `myMessage`, so the type a caller has to \
         name depends on which language they are in. PascalCase is the spelling \
         every generator passes through unchanged.",
    ),
    (
        "proto-oneof-lower-snake-case",
        Severity::Warning,
        "A oneof's name becomes a case-selector type or accessor in the \
         generated code -- Go's `isFoo_Kind`, Java's `getKindCase()` -- built by \
         re-casing whatever is written here. A name that is not \
         lower_snake_case produces a different identifier in each language, and \
         in Java a leading underscore is not a legal one at all. The synthetic \
         oneof protoc creates for a proto3 `optional` field is not this and is \
         never reported.",
    ),
    (
        "proto-package-lower-snake-case",
        Severity::Warning,
        "The package becomes a namespace in C++, a module path in Python, a Go \
         package and part of the Java package, and the mapping to each assumes \
         lower_snake_case components. An upper-case letter reaches C++ verbatim \
         and Go re-cased, so one schema is addressed by two different names \
         depending on the language reading it.",
    ),
    (
        "proto-package-missing",
        Severity::Warning,
        "A file with no `package` puts every message, enum and service it \
         declares in the global namespace. Two such files that happen to name a \
         message the same thing cannot be compiled together at all, and nothing \
         in either says so until somebody imports both -- which is usually \
         somebody else, in a repository neither author is looking at. The \
         package is also what the generated Go, Java and C# names are derived \
         from, so without it those are derived from the filename instead.",
    ),
    (
        "proto-rpc-pascal-case",
        Severity::Warning,
        "An RPC's name is half of its wire path: gRPC addresses a method as \
         `/package.Service/Method`, spelled exactly as written here. Every \
         generator then re-cases it for the client stub, so `doThing` is \
         `DoThing` in Go, `doThing` in Java and `do_thing` in Python while the \
         path on the wire stays `doThing`. PascalCase is the spelling that \
         makes the path and the Go stub agree, and it is what every gRPC \
         implementation's tooling expects to see.",
    ),
    (
        "proto-service-pascal-case",
        Severity::Warning,
        "A service's name is the other half of the gRPC path \
         (`/package.Service/Method`) and a type name in every generated client, \
         re-cased by each generator on the way. PascalCase is the spelling that \
         reaches the wire and the generated code as the same word.",
    ),
    (
        "proto-syntax-missing",
        Severity::Warning,
        "A `.proto` with no `syntax` line is proto2, silently. That is a \
         different language from the one most files are written in: fields need \
         an explicit `optional` or `repeated`, unset scalars come back as their \
         declared default rather than as absent, unknown fields survive a round \
         trip, and the JSON mapping differs. A file that meant proto3 and forgot \
         to say so still compiles, and the difference shows up as behaviour \
         nobody can trace back to a missing line. Write `syntax = \"proto3\";` \
         or `syntax = \"proto2\";` and mean it.",
    ),
    (
        "proto-unreadable",
        Severity::Warning,
        "poly could not read this file, so none of poly's protobuf rules ran on \
         it -- this is a statement about poly, not about the file, which may be \
         perfectly valid. The usual cause is `edition = \"2023\"`: poly's \
         embedded parser handles proto2 and proto3 and does not implement \
         editions yet. It is reported rather than skipped because a file poly \
         was asked to check and did not check is exactly what makes a green \
         pipeline mean less than it looks like it means. `poly fmt` is \
         unaffected -- that is buf, which reads everything.",
    ),
];

/// poly's code, the buf rule id it answers to in a `buf.yaml`, and whether that
/// rule is in buf's `MINIMAL` tier.
///
/// The buf id is here for one job: `use` and `except` in a project's `buf.yaml`
/// are written in buf's vocabulary, and poly has to select among its own rules
/// with it. Nothing poly prints ever uses these names -- see the note on
/// `RULES` about not putting poly's behaviour behind somebody else's code.
const CATALOGUE: &[(&str, &str, bool)] = &[
    ("proto-enum-allow-alias", "ENUM_NO_ALLOW_ALIAS", false),
    (
        "proto-enum-first-value-nonzero",
        "ENUM_FIRST_VALUE_ZERO",
        false,
    ),
    ("proto-enum-pascal-case", "ENUM_PASCAL_CASE", false),
    (
        "proto-enum-value-upper-snake-case",
        "ENUM_VALUE_UPPER_SNAKE_CASE",
        false,
    ),
    (
        "proto-field-lower-snake-case",
        "FIELD_LOWER_SNAKE_CASE",
        false,
    ),
    ("proto-field-required", "FIELD_NOT_REQUIRED", false),
    ("proto-import-public", "IMPORT_NO_PUBLIC", false),
    ("proto-message-pascal-case", "MESSAGE_PASCAL_CASE", false),
    (
        "proto-oneof-lower-snake-case",
        "ONEOF_LOWER_SNAKE_CASE",
        false,
    ),
    (
        "proto-package-lower-snake-case",
        "PACKAGE_LOWER_SNAKE_CASE",
        false,
    ),
    ("proto-package-missing", "PACKAGE_DEFINED", true),
    ("proto-rpc-pascal-case", "RPC_PASCAL_CASE", false),
    ("proto-service-pascal-case", "SERVICE_PASCAL_CASE", false),
    ("proto-syntax-missing", "SYNTAX_SPECIFIED", false),
];

/// buf's lint category names, so a `use: [COMMENTS]` is understood as a
/// category poly has no rules in rather than reported as a rule poly is missing.
const CATEGORIES: &[&str] = &[
    "MINIMAL",
    "BASIC",
    "DEFAULT",
    "STANDARD",
    "COMMENTS",
    "UNARY_RPC",
];

/// The rules a `buf.yaml` can name, for the note poly prints when it names one
/// poly does not have. `proto-unreadable` is not here: it is poly's own, not a
/// buf rule, and no `buf.yaml` can switch it off.
const SELECTABLE: usize = CATALOGUE.len();

/// Is this file linted by the rules in this module?
///
/// Split out so the batch walk can skip reading files nothing will report on,
/// and so `lint::engine` and `lint::lint` cannot drift apart about it.
pub fn supported(lang: &str) -> bool {
    lang == "protobuf"
}

/// Lint one `.proto`.
///
/// `path` is read as well as `text`: the file name is how the `buf.yaml`
/// governing this file is found, and how `lint.ignore` decides whether the file
/// is in scope. The daemon lints an unsaved buffer, so the text is the buffer's
/// and only the path comes from disk -- the same split every other engine here
/// makes.
pub fn lint(path: &Path, text: &str) -> Vec<Issue> {
    let policy = policy_for(path);
    // Nothing this project asked for: no parse, no walk.
    if policy.enabled.is_empty() && policy.ignores(path, "proto-unreadable") {
        return Vec::new();
    }
    let parsed = match protox_parse::parse("poly.proto", text) {
        Ok(parsed) => parsed,
        Err(_) => return unreadable(text, &policy, path),
    };
    let Some(info) = &parsed.source_code_info else {
        return Vec::new();
    };
    let mut linter = Linter {
        spans: Spans::new(text, &info.location),
        policy: &policy,
        path,
        found: Vec::new(),
    };
    linter.file(&parsed);
    linter.found
}

/// The one thing poly says about a `.proto` it could not parse.
///
/// Not a syntax error: protox-parse refuses input protoc accepts (any
/// `edition = ` file, and a `descriptor.proto` using extension declarations), so
/// claiming the file is wrong would be a false positive on valid protobuf. The
/// claim made instead is the one poly can stand behind -- it did not check this
/// file -- because silence there is a pipeline going green over a file nothing
/// read.
fn unreadable(text: &str, policy: &Policy, path: &Path) -> Vec<Issue> {
    if policy.ignores(path, "proto-unreadable") {
        return Vec::new();
    }
    // `edition = "2023"` is the expected reason and worth naming, so the reader
    // is not left wondering which line poly choked on.
    let editions = text
        .lines()
        .take_while(|line| !line.trim_start().starts_with("syntax"))
        .any(|line| line.trim_start().starts_with("edition"));
    let message = if editions {
        "poly's protobuf parser does not read `edition` files yet, so none of \
         poly's protobuf rules ran on this file"
    } else {
        "poly's protobuf parser could not read this file, so none of poly's \
         protobuf rules ran on it"
    };
    vec![Issue {
        line: 0,
        col: 0,
        end_line: 0,
        end_col: text.lines().next().map_or(0, |l| l.chars().count() as u32),
        severity: crate::lint::rule_severity("proto-unreadable"),
        code: "proto-unreadable".to_string(),
        message: message.to_string(),
        source: "poly",
        fix: None,
        url: None,
    }]
}

// ── walking the descriptor ─────────────────────────────────────────────────

struct Linter<'a> {
    spans: Spans<'a>,
    policy: &'a Policy,
    path: &'a Path,
    found: Vec<Issue>,
}

impl Linter<'_> {
    fn on(&self, code: &str) -> bool {
        self.policy.enabled.contains(code) && !self.policy.ignores(self.path, code)
    }

    /// A `// buf:lint:ignore <RULE>` above the declaration this finding is
    /// about.
    ///
    /// buf's own line-level suppression, honoured for the reason poly reads
    /// `buf.yaml` at all: it is the project saying "not this one", and a
    /// suppression that stops working the day poly replaces the tool it was
    /// written for silently un-silences exactly what somebody looked at and
    /// decided about. Nine of the fourteen findings poly had that buf did not,
    /// across the corpus, were these.
    ///
    /// Two paths are checked because a finding points at a name (`[5, 0, 1]`)
    /// while the comment attaches to the declaration (`[5, 0]`) -- which is
    /// where buf reads it from too.
    fn comment_ignored(&self, path: &[i32], code: &str) -> bool {
        if !self.policy.comment_ignores {
            return false;
        }
        let Some(rule) = CATALOGUE
            .iter()
            .find(|(poly, _, _)| *poly == code)
            .map(|(_, buf, _)| *buf)
        else {
            return false;
        };
        let declaration = &path[..path.len().saturating_sub(1)];
        [path, declaration].iter().any(|at| {
            self.spans.comments(at).is_some_and(|comments| {
                comments.lines().any(|line| {
                    line.trim()
                        .strip_prefix("buf:lint:ignore")
                        .is_some_and(|rest| rest.split_whitespace().next() == Some(rule))
                })
            })
        })
    }

    fn report(&mut self, path: &[i32], code: &'static str, message: String) {
        if self.comment_ignored(path, code) {
            return;
        }
        let (line, col, end_line, end_col) = self.spans.at(path);
        self.found.push(Issue {
            line,
            col,
            end_line,
            end_col,
            severity: crate::lint::rule_severity(code),
            code: code.to_string(),
            message,
            // poly's own rules, under poly's own name. See `RULES`.
            source: "poly",
            fix: None,
            // There is no page to link: the prose is in `RULES` and reaches the
            // editor through `rule_doc`.
            url: None,
        });
    }

    fn file(&mut self, fd: &FileDescriptorProto) {
        // The *statement*, not `fd.syntax`. protoc omits the field for proto2
        // because proto2 is the default, and protox-parse follows it -- so a
        // file that says `syntax = "proto2";` in as many words arrives with
        // `syntax: None`, and reporting on the field called three of envoy's
        // files unsyntaxed when they are not. The location survives either way,
        // and it is present exactly when the line was written.
        if self.on("proto-syntax-missing") && !self.spans.has(&[12]) {
            self.report(
                &[],
                "proto-syntax-missing",
                "no `syntax` line, so this file is proto2 by default".to_string(),
            );
        }
        match &fd.package {
            None => {
                if self.on("proto-package-missing") {
                    self.report(
                        &[],
                        "proto-package-missing",
                        "no `package`, so everything declared here is in the global namespace"
                            .to_string(),
                    );
                }
            }
            Some(package) => {
                if self.on("proto-package-lower-snake-case")
                    && !package.split('.').all(is_lower_snake)
                {
                    self.report(
                        &[2],
                        "proto-package-lower-snake-case",
                        format!("package `{package}` is not lower_snake.case"),
                    );
                }
            }
        }
        if self.on("proto-import-public") {
            for index in &fd.public_dependency {
                let Some(name) = fd.dependency.get(*index as usize) else {
                    continue;
                };
                self.report(
                    &[3, *index],
                    "proto-import-public",
                    format!(
                        "`import public \"{name}\"` re-exports it to everyone importing this file"
                    ),
                );
            }
        }
        for (i, message) in fd.message_type.iter().enumerate() {
            self.message(&[4, i as i32], message);
        }
        for (i, enumeration) in fd.enum_type.iter().enumerate() {
            self.enumeration(&[5, i as i32], enumeration);
        }
        for (i, service) in fd.service.iter().enumerate() {
            self.service(&[6, i as i32], service);
        }
        // File-level extensions are fields too, and buf names them under the
        // same rule.
        self.fields(&[7], &fd.extension);
    }

    fn message(&mut self, at: &[i32], message: &DescriptorProto) {
        if let Some(name) = &message.name {
            if self.on("proto-message-pascal-case") && !is_pascal(name) {
                self.report(
                    &child(at, &[1]),
                    "proto-message-pascal-case",
                    format!("message name `{name}` is not PascalCase"),
                );
            }
        }
        // protoc turns every proto3 `optional` field into a synthetic oneof
        // named `_field`, which is a name the author never wrote and which no
        // spelling rule can apply to. Collected before the oneofs are walked
        // because the marker is on the field, not on the oneof.
        let synthetic: HashSet<i32> = message
            .field
            .iter()
            .filter(|f| f.proto3_optional == Some(true))
            .filter_map(|f| f.oneof_index)
            .collect();
        for (i, oneof) in message.oneof_decl.iter().enumerate() {
            if synthetic.contains(&(i as i32)) {
                continue;
            }
            if let Some(name) = &oneof.name {
                if self.on("proto-oneof-lower-snake-case") && !is_lower_snake(name) {
                    self.report(
                        &child(at, &[8, i as i32, 1]),
                        "proto-oneof-lower-snake-case",
                        format!("oneof name `{name}` is not lower_snake_case"),
                    );
                }
            }
        }
        self.fields(&child(at, &[2]), &message.field);
        self.fields(&child(at, &[6]), &message.extension);
        for (i, nested) in message.nested_type.iter().enumerate() {
            // Map fields compile to a synthetic nested message named
            // `FooEntry`, which nobody wrote and whose field names are fixed by
            // the language (`key`, `value`).
            if nested.options.as_ref().and_then(|o| o.map_entry) == Some(true) {
                continue;
            }
            self.message(&child(at, &[3, i as i32]), nested);
        }
        for (i, nested) in message.enum_type.iter().enumerate() {
            self.enumeration(&child(at, &[4, i as i32]), nested);
        }
    }

    /// `at` is the path of the repeated field holding these: a message's
    /// `field` or `extension`, or the file's own `extension`. buf reports on all
    /// three under one rule and so does this -- an extension declares a field,
    /// and its name reaches the generated code the same way.
    fn fields(&mut self, at: &[i32], fields: &[prost_types::FieldDescriptorProto]) {
        for (i, field) in fields.iter().enumerate() {
            let Some(name) = &field.name else { continue };
            if self.on("proto-field-lower-snake-case") && !is_lower_snake(name) {
                self.report(
                    &child(at, &[i as i32, 1]),
                    "proto-field-lower-snake-case",
                    format!("field name `{name}` is not lower_snake_case"),
                );
            }
            if self.on("proto-field-required") && field.label == Some(Label::Required as i32) {
                self.report(
                    &child(at, &[i as i32, 4]),
                    "proto-field-required",
                    format!("field `{name}` is `required`, which can never be removed"),
                );
            }
        }
    }

    fn enumeration(&mut self, at: &[i32], enumeration: &EnumDescriptorProto) {
        if let Some(name) = &enumeration.name {
            if self.on("proto-enum-pascal-case") && !is_pascal(name) {
                self.report(
                    &child(at, &[1]),
                    "proto-enum-pascal-case",
                    format!("enum name `{name}` is not PascalCase"),
                );
            }
        }
        // `uninterpreted_option` rather than the typed `allow_alias` field:
        // protox-parse parses options, it does not interpret them -- resolving
        // an option name to a descriptor field is the compiler's job and needs
        // the imports this engine deliberately does not have. So every option
        // arrives as a name and a literal, including the ones the descriptor has
        // a field for. Reading the typed field instead missed all thirty of the
        // corpus's `allow_alias` enums.
        let allow_alias = enumeration
            .options
            .iter()
            .flat_map(|o| &o.uninterpreted_option)
            .any(|o| {
                o.name.len() == 1
                    && o.name[0].name_part == "allow_alias"
                    && !o.name[0].is_extension
                    && o.identifier_value.as_deref() == Some("true")
            });
        if self.on("proto-enum-allow-alias") && allow_alias {
            self.report(
                &child(at, &[3]),
                "proto-enum-allow-alias",
                "`allow_alias` makes two names share one number, so the JSON round trip is lossy"
                    .to_string(),
            );
        }
        if self.on("proto-enum-first-value-nonzero") {
            if let Some(first) = enumeration.value.first() {
                if first.number != Some(0) {
                    let name = first.name.as_deref().unwrap_or("");
                    self.report(
                        &child(at, &[2, 0, 1]),
                        "proto-enum-first-value-nonzero",
                        format!(
                            "first enum value `{name}` is not 0, so it is the default nobody chose"
                        ),
                    );
                }
            }
        }
        for (i, value) in enumeration.value.iter().enumerate() {
            let Some(name) = &value.name else { continue };
            if self.on("proto-enum-value-upper-snake-case") && !is_upper_snake(name) {
                self.report(
                    &child(at, &[2, i as i32, 1]),
                    "proto-enum-value-upper-snake-case",
                    format!("enum value name `{name}` is not UPPER_SNAKE_CASE"),
                );
            }
        }
    }

    fn service(&mut self, at: &[i32], service: &ServiceDescriptorProto) {
        if let Some(name) = &service.name {
            if self.on("proto-service-pascal-case") && !is_pascal(name) {
                self.report(
                    &child(at, &[1]),
                    "proto-service-pascal-case",
                    format!("service name `{name}` is not PascalCase"),
                );
            }
        }
        for (i, method) in service.method.iter().enumerate() {
            let Some(name) = &method.name else { continue };
            if self.on("proto-rpc-pascal-case") && !is_pascal(name) {
                self.report(
                    &child(at, &[2, i as i32, 1]),
                    "proto-rpc-pascal-case",
                    format!("rpc name `{name}` is not PascalCase"),
                );
            }
        }
    }
}

fn child(at: &[i32], tail: &[i32]) -> Vec<i32> {
    let mut path = at.to_vec();
    path.extend_from_slice(tail);
    path
}

// ── spellings ──────────────────────────────────────────────────────────────
//
// A protobuf identifier is `[A-Za-z_][A-Za-z0-9_]*`, so the only ways to be
// wrong are the case of a letter and the placement of an underscore. Each of
// these was checked against buf 1.72 rather than derived from its
// documentation: `HTTPServer`, `Foo2Bar`, `FooBAR` and `Ab1` are PascalCase to
// buf and `A_B` is not; `with2digits` and `a1b` are lower_snake_case and
// `_leading`, `trailing_` and `double__under` are not.

fn is_lower_snake(name: &str) -> bool {
    is_snake(name, |c| c.is_ascii_lowercase())
}

fn is_upper_snake(name: &str) -> bool {
    is_snake(name, |c| c.is_ascii_uppercase())
}

fn is_snake(name: &str, letter: fn(char) -> bool) -> bool {
    !name.is_empty()
        && name.split('_').enumerate().all(|(i, part)| {
            // No leading, trailing or doubled underscore: every part between
            // them has to hold something, including the first and the last.
            !part.is_empty()
                && part.chars().all(|c| letter(c) || c.is_ascii_digit())
                // A part may not start with a digit only where a name may not:
                // at the very beginning.
                && (i > 0 || !part.starts_with(|c: char| c.is_ascii_digit()))
        })
}

fn is_pascal(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('_')
        && name.starts_with(|c: char| c.is_ascii_uppercase())
        && name.chars().all(|c| c.is_ascii_alphanumeric())
}

// ── source positions ───────────────────────────────────────────────────────

/// `SourceCodeInfo`, indexed the way a rule asks for it.
///
/// Two conversions happen here and both matter. A span is `[line, start_col,
/// end_col]` or `[start_line, start_col, end_line, end_col]`, and the columns
/// are UTF-8 *byte* offsets -- protoc's convention, which protox-parse follows
/// exactly. `Issue` carries character columns, because that is what an LSP
/// position is and what `report.rs` prints. A `.proto` is nearly always ASCII,
/// so the difference only shows up on the line after a string literal holding
/// non-ASCII -- which is exactly the sort of thing that is never noticed until
/// somebody's squiggle is in the wrong place.
struct Spans<'a> {
    lines: Vec<&'a str>,
    by_path: HashMap<Vec<i32>, &'a Location>,
}

impl<'a> Spans<'a> {
    fn new(text: &'a str, locations: &'a [Location]) -> Spans<'a> {
        let mut by_path = HashMap::with_capacity(locations.len());
        for location in locations {
            // First wins: protox emits one location per element, and a repeated
            // path would be an option's sub-path (`[..., 999, 0]`), which no
            // rule here asks for.
            by_path.entry(location.path.clone()).or_insert(location);
        }
        Spans {
            lines: text.lines().collect(),
            by_path,
        }
    }

    /// Was anything written at this path at all? The question `proto-syntax-
    /// missing` asks, because the descriptor field it would otherwise read is
    /// absent for both "proto2 by default" and "proto2, said so".
    fn has(&self, path: &[i32]) -> bool {
        self.by_path.contains_key(path)
    }

    /// The comment block above this declaration, if it has one.
    fn comments(&self, path: &[i32]) -> Option<&str> {
        self.by_path.get(path)?.leading_comments.as_deref()
    }

    /// 0-based line and character column, start and end.
    ///
    /// A path with no location falls back to the start of the file rather than
    /// dropping the finding: a rule that fired knows something is wrong, and
    /// the worst case is a squiggle on line 1 rather than silence.
    fn at(&self, path: &[i32]) -> (u32, u32, u32, u32) {
        let Some(location) = self.by_path.get(path) else {
            return (0, 0, 0, 0);
        };
        let span = &location.span;
        let (line, start_col, end_line, end_col) = match span.len() {
            3 => (span[0], span[1], span[0], span[2]),
            4 => (span[0], span[1], span[2], span[3]),
            _ => return (0, 0, 0, 0),
        };
        (
            line.max(0) as u32,
            self.column(line, start_col),
            end_line.max(0) as u32,
            self.column(end_line, end_col),
        )
    }

    fn column(&self, line: i32, byte: i32) -> u32 {
        let (Ok(line), Ok(byte)) = (usize::try_from(line), usize::try_from(byte)) else {
            return 0;
        };
        let Some(text) = self.lines.get(line) else {
            return byte as u32;
        };
        // `get` rather than slicing: a byte offset that is not a char boundary
        // would panic, and a wrong column is a better outcome than a crash in
        // the daemon.
        text.get(..byte.min(text.len()))
            .map_or(byte as u32, |before| before.chars().count() as u32)
    }
}

// ── buf.yaml ───────────────────────────────────────────────────────────────

/// Which of poly's rules this file's project asked for.
///
/// buf's own `lint` configuration decides, because it is the configuration this
/// project already wrote and poly reading it is the difference between
/// replacing `buf lint` and overruling it. 47 of the 54 `buf.yaml` files in the
/// corpus this engine was measured against configure `lint`, and one of them
/// (envoy's) enables exactly one rule -- so ignoring the file would have poly
/// reporting precisely what those projects switched off.
///
/// Six keys are read, and they are the ones that decide what is reported:
/// `use`, `except`, `ignore`, `ignore_only`, the pair that governs
/// `// buf:lint:ignore` comments, and a v2 module's `excludes`, which takes
/// files out of the module entirely. buf's per-rule options
/// (`enum_zero_value_suffix`, `service_suffix`, `rpc_allow_*`) configure rules
/// poly does not implement and are ignored.
struct Policy {
    enabled: HashSet<&'static str>,
    /// Where `ignore` and `excludes` paths are anchored: the buf.yaml's own
    /// directory, which is the module root in v1 and the workspace root in v2.
    root: PathBuf,
    ignore: Vec<PathBuf>,
    ignore_only: HashMap<&'static str, Vec<PathBuf>>,
    /// Whether a `// buf:lint:ignore` comment silences a finding. The two buf
    /// versions spell the switch as opposites and default it differently: v1
    /// has `allow_comment_ignores`, off unless asked for, and v2 has
    /// `disallow_comment_ignores`, on unless refused.
    comment_ignores: bool,
}

impl Policy {
    /// Everything on, which is what a tree with no buf.yaml gets.
    ///
    /// This is the case `buf lint` could not serve at all: it resolves a module
    /// by walking up for a buf.yaml and reports nothing without one, which is
    /// 8,443 of the 9,664 `.proto` files in the corpus.
    fn everything() -> Policy {
        Policy {
            enabled: CATALOGUE.iter().map(|(code, _, _)| *code).collect(),
            root: PathBuf::new(),
            ignore: Vec::new(),
            ignore_only: HashMap::new(),
            // v2's default, because v2 is what buf writes today.
            comment_ignores: true,
        }
    }

    fn ignores(&self, path: &Path, code: &str) -> bool {
        if self.ignore.is_empty() && self.ignore_only.is_empty() {
            return false;
        }
        let absolute = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
        let Ok(relative) = absolute.strip_prefix(&self.root) else {
            return false;
        };
        let under = |entry: &PathBuf| relative.starts_with(entry);
        self.ignore.iter().any(under)
            || self
                .ignore_only
                .get(code)
                .is_some_and(|entries| entries.iter().any(under))
    }
}

#[derive(Deserialize)]
struct BufYaml {
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    modules: Vec<BufModule>,
    #[serde(default)]
    lint: Option<LintSection>,
}

#[derive(Deserialize)]
struct BufModule {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    excludes: Vec<String>,
    #[serde(default)]
    lint: Option<LintSection>,
}

#[derive(Deserialize, Default)]
struct LintSection {
    #[serde(rename = "use", default)]
    used: Vec<String>,
    #[serde(default)]
    except: Vec<String>,
    #[serde(default)]
    ignore: Vec<String>,
    #[serde(default)]
    ignore_only: HashMap<String, Vec<String>>,
    #[serde(default)]
    allow_comment_ignores: Option<bool>,
    #[serde(default)]
    disallow_comment_ignores: Option<bool>,
}

/// The policy governing `path`, built once per `buf.yaml`.
///
/// Keyed by the config file for the reason `lua_linter`'s cache is: a monorepo
/// can have several, and `poly check` at its root has to lint each module under
/// its own. A buf.yaml poly cannot read is cached too, so a broken one says so
/// once rather than once per `.proto` beneath it.
fn policy_for(path: &Path) -> Arc<Policy> {
    type Cache = HashMap<Option<PathBuf>, Arc<Policy>>;
    static CACHE: Mutex<Option<Cache>> = Mutex::new(None);
    let key = poly_core::nearest_ancestor_file(path, &["buf.yaml"]);
    let mut guard = CACHE.lock().expect("proto policy cache lock");
    let cache = guard.get_or_insert_with(HashMap::new);
    if let Some(hit) = cache.get(&key) {
        return Arc::clone(hit);
    }
    let built = Arc::new(build_policy(key.as_deref(), path));
    cache.insert(key, Arc::clone(&built));
    built
}

fn build_policy(config: Option<&Path>, for_path: &Path) -> Policy {
    let Some(config) = config else {
        return Policy::everything();
    };
    let root = config.parent().unwrap_or(Path::new("")).to_path_buf();
    let root = std::path::absolute(&root).unwrap_or(root);
    let text = match std::fs::read_to_string(config) {
        Ok(text) => text,
        Err(err) => {
            // Unreadable is not "no configuration": the project has one and
            // poly cannot see it, so saying so beats silently linting with a
            // selection nobody chose.
            eprintln!(
                "[poly] proto: {} could not be read ({err}); linting with poly's whole rule set",
                config.display()
            );
            return Policy::everything();
        }
    };
    let parsed: BufYaml = match serde_yaml::from_str(&text) {
        Ok(parsed) => parsed,
        Err(err) => {
            eprintln!(
                "[poly] proto: {} is not a buf.yaml poly can read ({err}); \
                 linting with poly's whole rule set",
                config.display()
            );
            return Policy::everything();
        }
    };

    // A v2 workspace can configure lint per module. The module a file belongs
    // to is the one whose `path` contains it, longest first so a nested module
    // wins over the workspace root.
    let mut modules: Vec<&BufModule> = parsed.modules.iter().collect();
    modules.sort_by_key(|m| std::cmp::Reverse(m.path.as_deref().unwrap_or("").len()));
    let absolute = std::path::absolute(for_path).unwrap_or_else(|_| for_path.to_path_buf());
    let module = modules.into_iter().find(|m| {
        let dir = root.join(m.path.as_deref().unwrap_or("."));
        absolute.starts_with(dir)
    });

    let section = module
        .and_then(|m| m.lint.as_ref())
        .or(parsed.lint.as_ref());
    let default = LintSection::default();
    let section = section.unwrap_or(&default);

    let mut enabled: HashSet<&'static str> = HashSet::new();
    let mut missing: Vec<String> = Vec::new();
    // buf's default is DEFAULT in v1 and STANDARD in v2, and both contain every
    // rule poly has, so an absent `use` is the same answer either way.
    if section.used.is_empty() {
        enabled.extend(CATALOGUE.iter().map(|(code, _, _)| *code));
    } else {
        for name in &section.used {
            select(name, &mut enabled, &mut missing);
        }
    }
    let mut removed: HashSet<&'static str> = HashSet::new();
    for name in &section.except {
        // A rule poly does not have, removed: nothing to say, because the
        // project loses nothing it would otherwise have seen.
        select(name, &mut removed, &mut Vec::new());
    }
    enabled.retain(|code| !removed.contains(code));

    // Said once per buf.yaml, because this cache fills once per buf.yaml. The
    // case that matters is a project that named individual rules: expanding a
    // category is buf's default rather than a choice, and repeating the gap for
    // every project on STANDARD would be a line on almost every run. Naming a
    // rule is the project pointing at it, and poly reporting nothing for it has
    // to be visible somewhere.
    if !missing.is_empty() {
        eprintln!(
            "[poly] proto: {} asks for {} lint rule(s) poly does not implement ({}); \
             poly has {} of buf's rules and lints these files with {} of them",
            config.display(),
            missing.len(),
            missing.join(", "),
            SELECTABLE,
            enabled.len(),
        );
    }

    let mut ignore: Vec<PathBuf> = section.ignore.iter().map(PathBuf::from).collect();
    // A v2 `excludes` takes files out of the module altogether, so buf never
    // linted them either. Same effect here, from the same statement.
    for m in &parsed.modules {
        let prefix = m.path.as_deref().unwrap_or(".");
        for exclude in &m.excludes {
            let joined = Path::new(prefix).join(exclude);
            // `./x` and `x` have to compare equal against a relative path.
            ignore.push(joined.strip_prefix("./").unwrap_or(&joined).to_path_buf());
        }
    }
    let ignore_only = section
        .ignore_only
        .iter()
        .filter_map(|(rule, paths)| {
            let code = CATALOGUE
                .iter()
                .find(|(_, buf, _)| *buf == rule)
                .map(|(code, _, _)| *code)?;
            Some((code, paths.iter().map(PathBuf::from).collect()))
        })
        .collect();

    // v1 asks for comment ignores and v2 refuses them, so the same behaviour is
    // written two opposite ways. Either key is honoured whichever version says
    // it, because a project that spelled its intent out is not helped by poly
    // insisting on the spelling its `version` implies.
    let comment_ignores = match (
        section.allow_comment_ignores,
        section.disallow_comment_ignores,
    ) {
        (_, Some(disallowed)) => !disallowed,
        (Some(allowed), None) => allowed,
        (None, None) => parsed.version.as_deref() != Some("v1"),
    };

    Policy {
        enabled,
        root,
        ignore,
        ignore_only,
        comment_ignores,
    }
}

/// Add whatever `name` selects to `into`, and record it in `missing` when it is
/// a rule poly does not implement.
fn select(name: &str, into: &mut HashSet<&'static str>, missing: &mut Vec<String>) {
    match name {
        // buf's MINIMAL, of which poly implements one rule.
        "MINIMAL" => into.extend(
            CATALOGUE
                .iter()
                .filter(|(_, _, minimal)| *minimal)
                .map(|(code, _, _)| *code),
        ),
        // BASIC contains every rule poly has, and DEFAULT (v1) and STANDARD
        // (v2) are supersets of BASIC, so all three select the same fourteen.
        "BASIC" | "DEFAULT" | "STANDARD" => {
            into.extend(CATALOGUE.iter().map(|(code, _, _)| *code));
        }
        _ => {
            match CATALOGUE.iter().find(|(_, buf, _)| *buf == name) {
                Some((code, _, _)) => {
                    into.insert(code);
                }
                // A category poly has no rules in is not a gap to report:
                // `use: [COMMENTS]` asks for rules about comments, and poly
                // never claimed any.
                None if CATEGORIES.contains(&name) => {}
                None => missing.push(name.to_string()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One `.proto` in a directory of its own, so each case gets its own
    /// `buf.yaml` key and the policy cache cannot carry an answer between tests.
    fn project(config: Option<&str>, body: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        if let Some(config) = config {
            std::fs::write(dir.path().join("buf.yaml"), config).unwrap();
        }
        let file = dir.path().join("a.proto");
        std::fs::write(&file, body).unwrap();
        (dir, file)
    }

    fn codes(config: Option<&str>, body: &str) -> Vec<String> {
        let (dir, file) = project(config, body);
        let mut found: Vec<String> = lint(&file, body)
            .into_iter()
            .map(|issue| {
                // Both emitters here build their `Issue` by hand -- there is no
                // constructor to route them through, the way Dockerfiles and
                // workflows have one -- so this is the only thing holding a
                // finding's level to the level its row states.
                assert_eq!(
                    issue.severity,
                    crate::lint::rule_severity(&issue.code),
                    "{} is reported at a level `RULES` does not state",
                    issue.code
                );
                issue.code
            })
            .collect();
        found.sort();
        drop(dir);
        found
    }

    /// Every rule the linter can emit has prose, and every entry in the table
    /// is a rule the linter can emit. Both directions, because either half
    /// alone lets a code reach a reader with nothing behind it.
    #[test]
    fn every_proto_rule_is_documented() {
        let documented: HashSet<&str> = RULES.iter().map(|(code, _, _)| *code).collect();
        let emitted: HashSet<&str> = CATALOGUE
            .iter()
            .map(|(code, _, _)| *code)
            .chain(["proto-unreadable"])
            .collect();
        assert_eq!(documented, emitted);
        assert_eq!(RULES.len(), documented.len(), "a code is listed twice");
        for (code, severity, doc) in RULES {
            assert!(doc.len() > 120, "{code} has no real explanation");
            assert_eq!(crate::lint::rule_severity(code), *severity, "{code}");
            // Reached through the one namespace every poly rule shares.
            assert_eq!(crate::lint::rule_doc("poly", code), Some(*doc), "{code}");
        }
        assert!(crate::lint::rule_doc("poly", "proto-no-such-rule").is_none());
        // Still nobody else's rules: poly documents what it wrote, and buf's
        // codes are not what poly prints.
        assert!(crate::lint::rule_doc("buf", "FIELD_LOWER_SNAKE_CASE").is_none());
    }

    /// The seam `lint::engine` and `lint::lint` share. The first decides
    /// whether the file is read at all and the second what is done with it, so
    /// a language in one and not the other is a file poly opens and ignores --
    /// or worse, one it never opens and silently calls clean.
    #[test]
    fn protobuf_is_wired_into_both_halves_of_the_lint_seam() {
        let body = "syntax = \"proto3\";\npackage a.b;\nmessage bad {\n  string X = 1;\n}\n";
        let (dir, file) = project(None, body);
        assert!(crate::lint::engine("protobuf", &file).is_some());
        assert_eq!(crate::lint::lint("protobuf", &file, body).unwrap().len(), 2);
        // ...and nothing else answers for `.proto`.
        assert!(crate::lint::engine("yaml", &file).is_none());
        drop(dir);
    }

    /// Positions, against the exact numbers buf 1.72 reports for the same file.
    ///
    /// `Issue` is 0-based and `report.rs` prints 1-based, so the assertions here
    /// are one less than what a terminal shows. Both halves are pinned: a rule
    /// that fires on the wrong line is worse than one that does not fire.
    #[test]
    fn positions_match_bufs_to_the_column() {
        let body = concat!(
            "syntax = \"proto3\";\n",
            "\n",
            "package acme.thing;\n",
            "\n",
            "import public \"other.proto\";\n",
            "\n",
            "message myMessage {\n",
            "  string BadField = 1;\n",
            "\n",
            "  oneof BadOneof {\n",
            "    string a = 3;\n",
            "  }\n",
            "}\n",
            "\n",
            "enum badEnum {\n",
            "  option allow_alias = true;\n",
            "  ZERO_FIRST = 0;\n",
            "  lowerValue = 1;\n",
            "  ALIASED = 1;\n",
            "}\n",
            "\n",
            "service thingservice {\n",
            "  rpc doThing(myMessage) returns (myMessage);\n",
            "}\n",
        );
        let (dir, file) = project(None, body);
        let found: HashMap<String, (u32, u32, u32, u32)> = lint(&file, body)
            .into_iter()
            .map(|i| (i.code, (i.line, i.col, i.end_line, i.end_col)))
            .collect();
        drop(dir);
        // buf: 5:1-5:29 for the whole import statement, not the `public` word.
        assert_eq!(found["proto-import-public"], (4, 0, 4, 28));
        // buf: 7:9-7:18.
        assert_eq!(found["proto-message-pascal-case"], (6, 8, 6, 17));
        // buf: 8:10-8:18.
        assert_eq!(found["proto-field-lower-snake-case"], (7, 9, 7, 17));
        // buf: 10:9-10:17.
        assert_eq!(found["proto-oneof-lower-snake-case"], (9, 8, 9, 16));
        // buf: 15:6-15:13.
        assert_eq!(found["proto-enum-pascal-case"], (14, 5, 14, 12));
        // buf: 16:3-16:29, the whole option statement.
        assert_eq!(found["proto-enum-allow-alias"], (15, 2, 15, 28));
        // buf: 18:3-18:13.
        assert_eq!(found["proto-enum-value-upper-snake-case"], (17, 2, 17, 12));
        // buf: 22:9-22:21.
        assert_eq!(found["proto-service-pascal-case"], (21, 8, 21, 20));
        // buf: 23:7-23:14.
        assert_eq!(found["proto-rpc-pascal-case"], (22, 6, 22, 13));
    }

    /// protox-parse reports columns as UTF-8 byte offsets, protoc's convention;
    /// `Issue` carries character columns, because that is what an LSP position
    /// is. A `.proto` is nearly always ASCII, so the difference only shows up
    /// after a non-ASCII string literal on the same line -- which is exactly
    /// where nobody would notice a squiggle landing eight columns to the right.
    #[test]
    fn columns_are_characters_not_bytes() {
        let body = "syntax = \"proto3\";\npackage a.b;\nmessage T { string x = 1 [(a.b) = \"中文中文\"]; string BadName = 2; }\n";
        let (dir, file) = project(None, body);
        let found = lint(&file, body);
        drop(dir);
        assert_eq!(found.len(), 1, "{found:#?}");
        // 50 characters in; 58 bytes in, which is what the descriptor says --
        // the four CJK characters before it are three bytes each.
        assert_eq!((found[0].line, found[0].col), (2, 50));
        assert_eq!(found[0].end_col, 57);
    }

    /// buf's own line-level suppression, honoured for the same reason its
    /// `buf.yaml` is: a project that looked at a finding and decided about it
    /// must not have that decision undone by poly changing how the rule runs.
    /// Both shapes come from grpc-gateway's `path_enum.proto`.
    #[test]
    fn buf_lint_ignore_comments_are_honoured() {
        let body = concat!(
            "syntax = \"proto3\";\n",
            "package a.b;\n",
            "// Ignoring lint warnings as this enum exists to validate them.\n",
            "// buf:lint:ignore ENUM_PASCAL_CASE\n",
            "enum snake_case_for_import {\n",
            "  // buf:lint:ignore ENUM_VALUE_UPPER_SNAKE_CASE\n",
            "  value_x = 0;\n",
            "  value_y = 1;\n",
            "}\n",
        );
        // The enum and the first value are silenced by name; the second value,
        // which nobody wrote a comment for, still reports.
        assert_eq!(codes(None, body), ["proto-enum-value-upper-snake-case"]);

        // A comment naming a different rule silences nothing.
        let wrong = body.replace("ENUM_PASCAL_CASE", "FIELD_LOWER_SNAKE_CASE");
        assert_eq!(
            codes(None, &wrong),
            [
                "proto-enum-pascal-case",
                "proto-enum-value-upper-snake-case"
            ]
        );

        // v2 can refuse them, which envoy and temporalio both do...
        let v2 = "version: v2\nlint:\n  use: [STANDARD]\n  disallow_comment_ignores: true\n";
        assert_eq!(codes(Some(v2), body).len(), 3);
        // ...and v1 has to ask for them, because there they are off by default.
        let v1_silent = "version: v1\nlint:\n  use: [DEFAULT]\n";
        assert_eq!(codes(Some(v1_silent), body).len(), 3);
        let v1_asked = "version: v1\nlint:\n  use:\n    - DEFAULT\n  allow_comment_ignores: true\n";
        assert_eq!(codes(Some(v1_asked), body).len(), 1);
    }

    /// A file that says `syntax = "proto2";` in as many words is not a file
    /// with no syntax -- protoc omits the descriptor field for proto2 because
    /// it is the default, so reading the field called three of envoy's files
    /// unsyntaxed when they say so on line 1.
    #[test]
    fn an_explicit_proto2_is_not_a_missing_syntax() {
        let said = "syntax = \"proto2\";\npackage a.b;\nmessage M { optional string x = 1; }\n";
        assert!(codes(None, said).is_empty(), "{:?}", codes(None, said));
        let silent = "package a.b;\nmessage M { optional string x = 1; }\n";
        assert_eq!(codes(None, silent), ["proto-syntax-missing"]);
    }

    /// protox-parse parses options without interpreting them, so `allow_alias`
    /// arrives as an uninterpreted name and literal rather than in the
    /// descriptor field that exists for it. Reading the field found none of the
    /// corpus's thirty.
    #[test]
    fn allow_alias_is_read_from_the_uninterpreted_option() {
        for body in [
            "syntax = \"proto3\";\npackage a.b;\nenum E {\n  option allow_alias = true;\n  E_A = 0;\n  E_B = 0;\n}\n",
            // Nested in a message, which is where twenty-nine of the thirty are.
            "syntax = \"proto3\";\npackage a.b;\nmessage M {\n  enum E {\n    option allow_alias = true;\n    E_A = 0;\n    E_B = 0;\n  }\n}\n",
        ] {
            assert_eq!(codes(None, body), ["proto-enum-allow-alias"], "{body}");
        }
        // `= false` is the option written out, not the mistake.
        let off = "syntax = \"proto3\";\npackage a.b;\nenum E {\n  option allow_alias = false;\n  E_A = 0;\n}\n";
        assert!(codes(None, off).is_empty());
    }

    /// protoc invents two things nobody wrote, and both have names no spelling
    /// rule can apply to: the `_field` oneof behind a proto3 `optional`, and
    /// the `FooEntry` message behind a `map`. buf skips both and so must this.
    #[test]
    fn synthetic_declarations_are_not_reported() {
        let body = concat!(
            "syntax = \"proto3\";\n",
            "package a.b;\n",
            "message T {\n",
            "  optional string present = 1;\n",
            "  map<string, int32> lookup = 2;\n",
            "}\n",
        );
        assert!(codes(None, body).is_empty(), "{:?}", codes(None, body));
    }

    /// The spellings, against buf 1.72's answers for the same names. Each of
    /// these was run through buf rather than read off its documentation.
    #[test]
    fn spellings_agree_with_buf() {
        for ok in [
            "HTTPServer",
            "MyHTTPServer",
            "Foo2Bar",
            "FooBAR",
            "X",
            "Ab1",
        ] {
            assert!(is_pascal(ok), "{ok}");
        }
        for bad in ["A_B", "myMessage", "_Foo", "snake_case_enum", ""] {
            assert!(!is_pascal(bad), "{bad}");
        }
        for ok in ["ok_name", "with2digits", "a1b", "x"] {
            assert!(is_lower_snake(ok), "{ok}");
        }
        for bad in [
            "_leading",
            "trailing_",
            "double__under",
            "BadField",
            "1a",
            "",
        ] {
            assert!(!is_lower_snake(bad), "{bad}");
        }
        for ok in ["VALUES_A1B", "VALUES_UNSPECIFIED", "A"] {
            assert!(is_upper_snake(ok), "{ok}");
        }
        for bad in [
            "VALUES__DOUBLE",
            "VALUES_TRAILING_",
            "_VALUES_LEADING",
            "lowerValue",
        ] {
            assert!(!is_upper_snake(bad), "{bad}");
        }
    }

    /// A missing `syntax` and a missing `package` are facts about the whole
    /// file, so they land on line 1 -- there is no line to point at, and buf
    /// puts them there too.
    #[test]
    fn file_level_rules_land_on_line_one() {
        let found = codes(None, "message T {\n  optional string x = 1;\n}\n");
        assert_eq!(found, ["proto-package-missing", "proto-syntax-missing"]);
    }

    /// A proto2 `required` field, pointed at the keyword rather than at the
    /// field number buf underlines. Deliberate: the keyword is the defect, and
    /// poly's positions are its own once its codes are.
    #[test]
    fn a_required_field_is_reported_at_the_keyword() {
        let body = "syntax = \"proto2\";\npackage a.b;\nmessage M {\n  required string x = 1;\n}\n";
        let (dir, file) = project(None, body);
        let found = lint(&file, body);
        drop(dir);
        assert_eq!(found.len(), 1, "{found:#?}");
        assert_eq!(found[0].code, "proto-field-required");
        assert_eq!((found[0].line, found[0].col, found[0].end_col), (3, 2, 10));
    }

    /// The first enum value is the default, and it can only be non-zero in
    /// proto2 -- protoc rejects it outright in proto3, so this rule has nowhere
    /// else to fire.
    #[test]
    fn a_non_zero_first_enum_value_is_reported() {
        let body = "syntax = \"proto2\";\npackage a.b;\nenum E {\n  E_ONE = 1;\n  E_ZERO = 0;\n}\n";
        assert_eq!(codes(None, body), ["proto-enum-first-value-nonzero"]);
        let ok = "syntax = \"proto2\";\npackage a.b;\nenum E {\n  E_ZERO = 0;\n  E_ONE = 1;\n}\n";
        assert!(codes(None, ok).is_empty());
    }

    // ── buf.yaml ───────────────────────────────────────────────────────────

    /// Two mistakes in one file, so a selection can be seen to keep one and
    /// drop the other rather than merely to reduce the count.
    const TWO: &str = "syntax = \"proto3\";\npackage a.b;\nmessage bad {\n  string X = 1;\n}\n";

    #[test]
    fn no_buf_yaml_means_every_rule() {
        assert_eq!(
            codes(None, TWO),
            ["proto-field-lower-snake-case", "proto-message-pascal-case"]
        );
    }

    /// The shapes that actually occur: `use` with a category, `except` with a
    /// rule, and v1's `DEFAULT` where v2 says `STANDARD`. All three were read
    /// off the 54 buf.yaml files in the corpus rather than invented.
    #[test]
    fn use_and_except_select_among_polys_rules() {
        // A category poly is entirely inside.
        assert_eq!(
            codes(Some("version: v2\nlint:\n  use: [STANDARD]\n"), TWO).len(),
            2
        );
        // v1's spelling of the same category.
        assert_eq!(
            codes(Some("version: v1\nlint:\n  use: [DEFAULT]\n"), TWO).len(),
            2
        );
        assert_eq!(
            codes(Some("version: v2\nlint:\n  use: [BASIC]\n"), TWO).len(),
            2
        );
        // MINIMAL holds exactly one rule poly has, and it is not either of
        // these two.
        assert!(codes(Some("version: v2\nlint:\n  use: [MINIMAL]\n"), TWO).is_empty());
        // One rule by name, in buf's vocabulary rather than poly's.
        assert_eq!(
            codes(
                Some("version: v2\nlint:\n  use: [FIELD_LOWER_SNAKE_CASE]\n"),
                TWO
            ),
            ["proto-field-lower-snake-case"]
        );
        // istio's shape: a category minus a rule.
        assert_eq!(
            codes(
                Some("version: v1\nlint:\n  use:\n    - BASIC\n  except:\n    - FIELD_LOWER_SNAKE_CASE\n    - PACKAGE_DIRECTORY_MATCH\n"),
                TWO
            ),
            ["proto-message-pascal-case"]
        );
        // envoy's shape, and the reason this whole mechanism exists: a project
        // that enabled one rule poly does not have gets nothing, not fourteen.
        assert!(codes(Some("version: v2\nlint:\n  use: [IMPORT_USED]\n"), TWO).is_empty());
        // A category poly has no rules in is not a rule poly is missing.
        assert!(codes(Some("version: v2\nlint:\n  use: [COMMENTS]\n"), TWO).is_empty());
    }

    /// `ignore` is a path, `ignore_only` is a path per rule, and both are
    /// relative to the buf.yaml's own directory. A project that silenced a rule
    /// for a file must not get it back because poly changed how it runs.
    #[test]
    fn ignore_and_ignore_only_are_honoured() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("vendor/deep")).unwrap();
        std::fs::write(
            dir.path().join("buf.yaml"),
            "version: v2\nlint:\n  use: [STANDARD]\n  ignore:\n    - vendor\n  ignore_only:\n    MESSAGE_PASCAL_CASE:\n      - kept.proto\n",
        )
        .unwrap();
        for name in ["vendor/deep/a.proto", "kept.proto", "other.proto"] {
            std::fs::write(dir.path().join(name), TWO).unwrap();
        }
        let at = |name: &str| {
            let mut found: Vec<String> = lint(&dir.path().join(name), TWO)
                .into_iter()
                .map(|i| i.code)
                .collect();
            found.sort();
            found
        };
        // A directory silences everything under it, however deep.
        assert!(at("vendor/deep/a.proto").is_empty());
        // One rule for one file, and the file's other finding survives -- the
        // whole difference between `ignore_only` and `ignore`.
        assert_eq!(at("kept.proto"), ["proto-field-lower-snake-case"]);
        assert_eq!(at("other.proto").len(), 2);
    }

    /// A v2 `excludes` takes files out of the module, so buf never linted them
    /// either. temporalio's shape: a vendored tree kept in the repository and
    /// excluded by name.
    #[test]
    fn a_module_exclude_takes_files_out_of_scope() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("google/api")).unwrap();
        std::fs::write(
            dir.path().join("buf.yaml"),
            "version: v2\nmodules:\n  - path: .\n    excludes:\n      - google\n",
        )
        .unwrap();
        std::fs::write(dir.path().join("google/api/a.proto"), TWO).unwrap();
        std::fs::write(dir.path().join("mine.proto"), TWO).unwrap();
        assert!(lint(&dir.path().join("google/api/a.proto"), TWO).is_empty());
        assert_eq!(lint(&dir.path().join("mine.proto"), TWO).len(), 2);
    }

    /// A buf.yaml poly cannot read must not silently become "no configuration":
    /// that would lint with poly's whole set on a project that had narrowed it.
    /// It says so and lints, because refusing to check the file is worse.
    #[test]
    fn an_unreadable_buf_yaml_falls_back_loudly() {
        assert_eq!(codes(Some("lint: [this is not a mapping]\n"), TWO).len(), 2);
    }

    // ── files poly cannot read ─────────────────────────────────────────────

    /// An `edition` file is valid protobuf that this parser does not implement.
    /// Reporting it as a syntax error would be a false positive; saying nothing
    /// would be a file poly was asked to check, did not check, and called clean.
    #[test]
    fn an_edition_file_is_reported_as_unread_not_as_wrong() {
        let body = "edition = \"2023\";\npackage a.b;\nmessage bad {\n  string X = 1;\n}\n";
        let (dir, file) = project(None, body);
        let found = lint(&file, body);
        drop(dir);
        assert_eq!(found.len(), 1, "{found:#?}");
        assert_eq!(found[0].code, "proto-unreadable");
        assert_eq!(found[0].severity, Severity::Warning);
        assert!(found[0].message.contains("edition"), "{:?}", found[0]);
        // The claim is about poly, not about the file: nothing here says the
        // file is wrong, and none of the fourteen rules fired on it either.
        assert!(!found[0].message.contains("syntax error"), "{:?}", found[0]);
        assert_eq!((found[0].line, found[0].col), (0, 0));
    }

    /// The other half: a file that really is broken gets the same weaker claim,
    /// because this parser also refuses input protoc accepts -- a
    /// descriptor.proto new enough to use extension declarations, for one -- and
    /// poly cannot tell the two apart from here.
    #[test]
    fn an_unparsable_file_says_only_that_poly_could_not_read_it() {
        let body = "syntax = \"proto3\";\nmessage {{{\n";
        let (dir, file) = project(None, body);
        let found = lint(&file, body);
        drop(dir);
        assert_eq!(found.len(), 1, "{found:#?}");
        assert_eq!(found[0].code, "proto-unreadable");
        assert!(!found[0].message.contains("edition"), "{:?}", found[0]);
    }

    /// ...and it is silenceable like anything else, by path.
    #[test]
    fn an_unreadable_file_can_be_ignored_by_path() {
        let body = "edition = \"2023\";\npackage a.b;\n";
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("buf.yaml"),
            "version: v2\nlint:\n  ignore:\n    - a.proto\n",
        )
        .unwrap();
        let file = dir.path().join("a.proto");
        std::fs::write(&file, body).unwrap();
        assert!(lint(&file, body).is_empty());
    }
}
