//! Embedded formatter engines, linked as native Rust crates (M0 "option 0",
//! validated against the WASM-host plan in docs/02-architecture.md §3.3).
//!
//! Returns `Ok(None)` when the input is already formatted.

pub mod lint;
mod proto;
pub mod schema;
pub mod shell;
pub mod unicode;
mod workflow;

use std::path::Path;
use std::sync::OnceLock;

use anyhow::{anyhow, Context, Result};
use poly_core::FormatOptions;

/// Language ids (poly-core detection) with an embedded formatter.
pub fn supported_language(lang: &str) -> bool {
    matches!(
        lang,
        "typescript"
            | "json"
            | "markdown"
            | "toml"
            | "css"
            | "scss"
            | "less"
            | "yaml"
            | "python"
            | "jupyter"
            | "sql"
            | "xml"
            | "html"
            | "vue"
            | "svelte"
            | "astro"
            | "jinja"
            | "handlebars"
            | "graphql"
            | "dockerfile"
            | "lua"
            | "php"
    )
}

/// Which of the three knobs this engine can act on: (line-width, indent-width,
/// use-tabs).
fn honored(lang: &str) -> (bool, bool, bool) {
    match lang {
        // xmlem pretty-prints at a fixed width and always indents with spaces.
        "xml" => (false, true, false),
        // sqruff owns its layout rules; point people at its own config rather
        // than half-applying ours on top of it.
        "sql" => (false, false, false),
        // Markdown reflow is width-only; the plugin has no indent knobs.
        "markdown" => (true, false, false),
        // YAML indentation must be spaces, so pretty_yaml exposes no useTabs.
        "yaml" => (true, true, false),
        "dockerfile" => (true, true, false),
        _ => (true, true, true),
    }
}

/// Drop the knobs `lang` cannot act on, quietly.
///
/// For inherited settings only -- the ones that came from a `.editorconfig`
/// rather than from `[format.<lang>]`. A repo-wide `indent_size = 2` is aimed
/// at every editor that ever opens the file, not at poly's XML engine, so
/// refusing to format XML over it would make adopting poly look like it broke
/// the repo. The same value written in poly.toml still stops the run, because
/// there it was aimed at poly and poly cannot do it.
pub fn drop_unhonored(lang: &str, opts: FormatOptions) -> FormatOptions {
    let (width, indent, tabs) = honored(lang);
    FormatOptions {
        line_width: opts.line_width.filter(|_| width),
        indent_width: opts.indent_width.filter(|_| indent),
        use_tabs: opts.use_tabs.filter(|_| tabs),
    }
}

/// Which of `[format.<lang>]`'s three knobs this engine can actually honor.
/// Silently dropping one would mean poly.toml and the output disagree, so
/// `format` rejects the file instead and names the key.
fn unsupported_option(lang: &str, opts: &FormatOptions) -> Option<&'static str> {
    let (width, indent, tabs) = honored(lang);
    match opts {
        FormatOptions {
            line_width: Some(_),
            ..
        } if !width => Some("line-width"),
        FormatOptions {
            indent_width: Some(_),
            ..
        } if !indent => Some("indent-width"),
        FormatOptions {
            use_tabs: Some(_), ..
        } if !tabs => Some("use-tabs"),
        _ => None,
    }
}

/// Format `text` as `lang` (a poly-core language id).
pub fn format(lang: &str, path: &Path, text: &str, opts: FormatOptions) -> Result<Option<String>> {
    if let Some(key) = unsupported_option(lang, &opts) {
        return Err(anyhow!(
            "[format.{lang}] {key}: the {lang} formatter has no such setting"
        ));
    }
    match lang {
        "typescript" => format_typescript(path, text, opts),
        "json" => format_json(path, text, opts),
        "markdown" => format_markdown(text, opts),
        "toml" => format_toml(path, text, opts),
        "css" | "scss" | "less" => format_css(text, lang, opts),
        "yaml" => format_yaml(text, opts),
        "python" => format_python(path, text, opts),
        "jupyter" => format_jupyter(path, text, opts),
        "sql" => format_sql(text),
        "xml" => format_xml(text, opts),
        "html" | "vue" | "svelte" | "astro" | "jinja" | "handlebars" => {
            format_markup(text, lang, opts)
        }
        "graphql" => format_graphql(text, opts),
        "php" => format_php(path, text, opts),
        "dockerfile" => format_dockerfile(path, text, opts),
        "lua" => format_lua(text, opts),
        other => Err(anyhow!("no embedded formatter for language {other:?}")),
    }
}

/// Convenience: detect via built-in rules, then format. Used by the LSP and
/// markdown code-block dispatch; the CLI goes through poly-core's
/// config-aware detection instead.
///
/// Nested dispatch (a fenced block, a `<script>` body) formats at the engine
/// defaults: the host engine owns the layout of what it embeds, and threading
/// the outer language's width into an inner language would apply Python's
/// setting to the JavaScript inside a markdown file.
pub fn format_file(path: &Path, text: &str) -> Result<Option<String>> {
    match poly_core::builtin_language(path) {
        Some(lang) if supported_language(lang) => {
            format(lang, path, text, FormatOptions::default())
        }
        Some(lang) => Err(anyhow!("no embedded formatter for language {lang:?}")),
        None => Err(anyhow!("unrecognized file type: {}", path.display())),
    }
}

fn format_typescript(path: &Path, text: &str, opts: FormatOptions) -> Result<Option<String>> {
    use dprint_plugin_typescript::configuration::{Configuration, ConfigurationBuilder};
    static CONFIG: OnceLock<Configuration> = OnceLock::new();
    // The default configuration is built once and shared; only a poly.toml that
    // actually asks for something pays to build its own.
    let overridden;
    let config = if opts.is_default() {
        CONFIG.get_or_init(|| ConfigurationBuilder::new().build())
    } else {
        let mut builder = ConfigurationBuilder::new();
        if let Some(width) = opts.line_width {
            builder.line_width(width.into());
        }
        if let Some(width) = opts.indent_width {
            builder.indent_width(width);
        }
        if let Some(tabs) = opts.use_tabs {
            builder.use_tabs(tabs);
        }
        overridden = builder.build();
        &overridden
    };
    dprint_plugin_typescript::format_text(dprint_plugin_typescript::FormatTextOptions {
        path,
        extension: None,
        text: text.to_string(),
        config,
        external_formatter: Some(&embedded_in_typescript),
    })
}

/// A tagged template whose tag names a language poly formats.
///
/// dprint-plugin-typescript formats TypeScript and asks its caller about
/// anything else, the same shape markup_fmt uses for `<script>` and
/// dprint-plugin-markdown for a fenced block. poly answers for the languages
/// it has, which is what makes ``css`...` `` in a styled-component come out
/// formatted rather than however it was typed.
///
/// Returning `None` leaves the template exactly as written, which is the right
/// answer for a language poly does not format and for a snippet that does not
/// parse -- a tagged template is often a fragment, and a fragment that fails to
/// parse is not a file anybody asked poly to fix.
///
/// Interpolations arrive as placeholders, not holes: the plugin substitutes a
/// uniquely numbered `dpr1nt_NN_d` (`@dpr1nt_NN_d` for css, so it reads as a
/// LESS variable) for each `${}` before calling this, and puts the expressions
/// back afterwards. So the text really is the language the tag claims -- but
/// the formatter must not reorder or drop what looks to it like an unknown
/// identifier, which is the other half of why css goes through LESS.
fn embedded_in_typescript(
    lang: &str,
    text: String,
    config: &dprint_plugin_typescript::configuration::Configuration,
) -> Result<Option<String>> {
    let opts = FormatOptions {
        indent_width: Some(config.indent_width),
        ..FormatOptions::default()
    };
    let formatted = match lang {
        "css" => embedded_css(&text, config),
        // markup_fmt's own `Language::Html`, with the inner callback poly uses
        // everywhere else, so a `<style>` inside an html`` template reaches
        // malva exactly as it would in a .html file.
        "html" => format_markup(&text, "html", opts),
        // sqruff takes no layout options from poly: `[format.sql]` rejects
        // all three, because sqruff owns its own layout rules (.sqruff).
        "sql" => format_sql(&text),
        _ => return Ok(None),
    };
    // Unformattable is not an error here: the tag says what the author meant
    // the fragment to be, and being wrong about that must not fail the whole
    // TypeScript file.
    Ok(formatted.ok().flatten())
}

/// The CSS inside a tagged template, which is a declaration list and not a file.
///
/// `css\`color: red\`` is not a stylesheet -- malva would reject it -- so it is
/// wrapped in a rule, formatted, and unwrapped again. This is
/// dprint-plugin-typescript's own approach, copied deliberately from its
/// `tests/spec_test.rs`: LESS rather than CSS because LESS accepts `@variable`
/// both as a value and as a standalone mixin, which is what a placeholder left
/// by a removed interpolation looks like.
///
/// The trailing `;` in the wrapper is what lets a declaration list that already
/// ends in one through without becoming a syntax error.
fn embedded_css(
    text: &str,
    config: &dprint_plugin_typescript::configuration::Configuration,
) -> Result<Option<String>> {
    let mut options = malva::config::FormatOptions::default();
    options.layout.indent_width = config.indent_width as usize;
    let wrapped = malva::format_text(&format!("a{{\n{text}\n;}}"), malva::Syntax::Less, &options)
        .map_err(|e| anyhow!("css {e}"))?;
    let mut out = Vec::new();
    for (i, line) in wrapped.lines().enumerate() {
        // The `a {` this added, and the `}` that closed it.
        if i == 0 || line.starts_with('}') {
            continue;
        }
        // And the indent that being inside a rule gave every line.
        let mut chars = line.chars();
        for _ in 0..config.indent_width {
            chars.next();
        }
        out.push(chars.as_str());
    }
    Ok(Some(out.join("\n")))
}

fn format_json(path: &Path, text: &str, opts: FormatOptions) -> Result<Option<String>> {
    use dprint_plugin_json::configuration::{Configuration, ConfigurationBuilder};
    static CONFIG: OnceLock<Configuration> = OnceLock::new();
    let overridden;
    let config = if opts.is_default() {
        CONFIG.get_or_init(|| ConfigurationBuilder::new().build())
    } else {
        let mut builder = ConfigurationBuilder::new();
        if let Some(width) = opts.line_width {
            builder.line_width(width.into());
        }
        if let Some(width) = opts.indent_width {
            builder.indent_width(width);
        }
        if let Some(tabs) = opts.use_tabs {
            builder.use_tabs(tabs);
        }
        overridden = builder.build();
        &overridden
    };
    dprint_plugin_json::format_text(path, text, config).map_err(Into::into)
}

/// Languages `minify` can act on.
///
/// The list is decided by one contract rather than by how much each language
/// stands to save: **remove what a machine reading the file does not need, and
/// rewrite nothing else.** A language is here when whitespace is
/// presentational, when something downstream reads the result by machine, and
/// when poly has a printer that can be asked for the compact form without also
/// being asked to improve the file.
///
/// What that rules out is as load-bearing as what it admits:
///
/// - Markdown, YAML and TOML are whitespace-significant. A YAML collapsed onto
///   one line is not the same document, and a "minified" TOML is a file nobody
///   has a use for.
/// - SCSS and LESS format here but do not minify: lightningcss parses neither,
///   and running their output through a CSS parser would either fail or, worse,
///   succeed on the subset that happens to look like CSS.
/// - Vue, Svelte, Astro, Jinja and Handlebars format as markup but do not
///   minify: an HTML minifier reads a single-file component's `<template>` as
///   HTML and its custom blocks as content to collapse.
pub fn minifiable_language(lang: &str) -> bool {
    matches!(lang, "json" | "css" | "html" | "xml" | "typescript")
}

/// Strip everything a machine reading this file does not need.
///
/// The inverse of formatting rather than a mode of it, which is why it is its
/// own entry point instead of a `FormatOptions` knob: `poly fmt`'s contract is
/// "make this file match the project's style", and a caller who wanted that
/// would not want one line of 40KB.
///
/// Every language here is minified by a **printer**, never by an optimiser.
/// Each of the five engines below could do more -- lightningcss merges rules
/// and rewrites colours, minify-html omits closing tags, swc has a whole
/// minifier that renames locals and folds constants -- and each of those turns
/// the file into a different program that behaves the same. That is a build
/// step, and poly is not a bundler. What comes back from `poly minify` is the
/// same document with whitespace and comments removed, which is the only shape
/// in which "undo" and "read the diff" still mean anything.
///
/// One documented exception, in CSS: the compact printer also spells values as
/// short as it can, so `blue` comes back `#00f`. See `strip_css` -- it is one
/// switch with the whitespace, and it changes how a value is written rather
/// than which declarations survive.
///
/// A file poly refuses to minify is exactly one it refuses to format, reported
/// at the same position in the same words -- see the arms for how each language
/// gets there, because three of them need the formatter run first and two
/// already parse with it.
pub fn minify(lang: &str, path: &Path, text: &str) -> Result<Option<String>> {
    if !minifiable_language(lang) {
        return Ok(None);
    }
    // Nothing below this line may fail on a file the formatter accepts, and
    // nothing above it may accept a file the formatter rejects.
    let validate = || format(lang, path, text, FormatOptions::default()).map(|_| ());
    let minified = match lang {
        // The transform cannot fail: `strip_json` scans text and never parses,
        // and minify-html is error-tolerant by design -- it has no error type
        // at all. Without the formatter in front, a broken file would come back
        // confidently mangled instead of refused.
        "json" => {
            validate()?;
            strip_json(text)
        }
        "html" => {
            validate()?;
            strip_html(text)?
        }
        // Two parsers for one language, so the formatter's runs first and is
        // the one whose words the user sees. lightningcss would also report the
        // error, in its own vocabulary, at its own offset.
        "css" => {
            validate()?;
            strip_css(text)?
        }
        // One parser, shared with the formatter: `format_xml` parses with
        // xmlem and `format_typescript` with deno_ast, which are the crates
        // these two arms parse with. Validating first would produce the same
        // message from the same crate, one parse later.
        "xml" => strip_xml(text)?,
        "typescript" => strip_typescript(path, text)?,
        other => unreachable!("{other:?} is minifiable but has no minifier"),
    };
    Ok((minified != text).then_some(minified))
}

/// Remove whitespace and comments that are not inside a string.
///
/// Comments are removed because poly reads `.jsonc` as json too, and a comment
/// is the one thing in such a file that is unambiguously for a human. Note
/// that this is the only respect in which the output can change dialect: a
/// trailing comma survives, because removing it would mean parsing structure
/// rather than scanning text, and the file it came from was not strict JSON in
/// the first place.
fn strip_json(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            // Copy a string verbatim: whitespace inside it is data, and an
            // escaped quote does not end it.
            '"' => {
                out.push(c);
                while let Some(s) = chars.next() {
                    out.push(s);
                    match s {
                        '\\' => {
                            if let Some(escaped) = chars.next() {
                                out.push(escaped);
                            }
                        }
                        '"' => break,
                        _ => {}
                    }
                }
            }
            '/' if chars.peek() == Some(&'/') => {
                for next in chars.by_ref() {
                    if next == '\n' {
                        break;
                    }
                }
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut prev = '\0';
                for next in chars.by_ref() {
                    if prev == '*' && next == '/' {
                        break;
                    }
                    prev = next;
                }
            }
            // JSON's whitespace is exactly these four, so nothing else can be
            // dropped without dropping data.
            ' ' | '\t' | '\n' | '\r' => {}
            other => out.push(other),
        }
    }
    out
}

/// Print the stylesheet compactly, without improving it.
///
/// The printer only, never `StyleSheet::minify`. That transform merges adjacent
/// rules, shortens colours, and drops declarations it believes a later one
/// shadows -- all of which render identically and none of which is the file the
/// user wrote. The "believes" is the objection: it is sound only as far as its
/// cascade model goes, and a stylesheet that quietly lost a declaration is not
/// something a diff will show you, because the diff is one line either way.
///
/// CSS is the one language here that does not come out purely stripped, and it
/// is worth being exact about why. `minify: true` is a single switch on the
/// printer: it drops the whitespace *and* writes every value in its shortest
/// equivalent spelling, so `blue` is printed `#00f`. That is the printer's
/// token-level output and not an optimiser pass -- it cannot be turned off
/// without also turning off the compaction, and it rewrites how a value is
/// spelled rather than which declarations the file contains. The test pins it,
/// so the exception is visible rather than discovered.
fn strip_css(text: &str) -> Result<String> {
    use lightningcss::stylesheet::{ParserOptions, PrinterOptions, StyleSheet};

    let sheet =
        StyleSheet::parse(text, ParserOptions::default()).map_err(|e| anyhow!("css {e}"))?;
    let printed = sheet
        .to_css(PrinterOptions {
            minify: true,
            ..PrinterOptions::default()
        })
        .map_err(|e| anyhow!("css {e}"))?;
    Ok(printed.code)
}

/// Collapse the markup to what a browser renders identically.
///
/// The configuration is the substance of this function, because minify-html's
/// defaults are a shipping minifier's: they omit closing tags, drop `<html>`
/// and `<head>`, unquote attribute values and strip `type=text` from `<input>`.
/// Each is a rewrite rather than a removal, and three of the four are filed
/// upstream under "will still be parsed correctly by almost all browsers" --
/// which is a bargain worth taking when the output is about to be gzipped and
/// served, and not one worth taking with the file still open in the editor.
///
/// What poly keeps is the hard part, and the reason this is a dependency rather
/// than a regex: whitespace in HTML is only *mostly* insignificant, and the
/// exceptions -- `<pre>`, `<textarea>`, and the space between two inline
/// elements that the renderer draws -- are a table of which element is which.
///
/// `minify_css` and `minify_js` stay off for the reason above and one more:
/// they would hand a `<style>` to a second CSS engine and a `<script>` to oxc,
/// a second JavaScript parser beside the swc one `poly check` already reads.
/// One answer per language is most of why these crates are linked at all.
fn strip_html(text: &str) -> Result<String> {
    let cfg = minify_html::Cfg {
        keep_closing_tags: true,
        keep_html_and_head_opening_tags: true,
        keep_input_type_text_attr: true,
        // A server-side include is an instruction, not commentary: dropping it
        // changes what the served page contains. Ordinary comments do go, for
        // the reason `strip_json` drops them.
        keep_ssi_comments: true,
        ..minify_html::Cfg::default()
    };
    // Bytes in, bytes out, and the crate preserves whatever encoding it was
    // handed -- so a failure here means the input was not UTF-8, which is worth
    // saying rather than papering over with replacement characters.
    String::from_utf8(minify_html::minify(text.as_bytes(), &cfg))
        .map_err(|e| anyhow!("html minify produced invalid UTF-8: {e}"))
}

/// Print the XML tree with none of the whitespace that was only indentation.
///
/// `Display` rather than `to_string_pretty`: xmlem's non-alternate config is
/// the compact one, so this is the printer `poly fmt` already uses with the
/// other config. The two commands cannot end up disagreeing about what the
/// document is, because only one of them ever read it.
fn strip_xml(text: &str) -> Result<String> {
    let doc: xmlem::Document = text.parse().map_err(|e| anyhow!("xml parse error: {e}"))?;
    Ok(doc.to_string())
}

/// Print the program compactly: no whitespace, no comments, every name intact.
///
/// swc_ecma_codegen rather than swc_ecma_minifier, and the distinction is the
/// whole design. The minifier renames locals, folds constants, drops
/// unreachable branches and rewrites control flow; the emitter with
/// `minify: true` prints the tree it was given with nothing between the tokens.
/// Only the second one is "the same file, smaller".
///
/// Reached through deno_ast rather than by naming swc directly so that the
/// emitter is guaranteed to be the one matching the parser -- the same parser
/// `poly check` lints this file with, so the two cannot disagree about what
/// JavaScript is.
fn strip_typescript(path: &Path, text: &str) -> Result<String> {
    use deno_ast::swc::codegen::{text_writer::JsWriter, Config, Emitter, Node};

    // Absolute, because a `file://` URL cannot be built from a relative path;
    // the specifier only names the file in diagnostics, so a path that will not
    // absolutize falls back to something parseable rather than failing.
    let specifier = std::path::absolute(path)
        .ok()
        .and_then(|abs| deno_ast::ModuleSpecifier::from_file_path(abs).ok())
        .unwrap_or_else(|| {
            deno_ast::ModuleSpecifier::parse("file:///buffer.ts").expect("a literal file URL")
        });
    let parsed = deno_ast::parse_program(deno_ast::ParseParams {
        specifier: specifier.clone(),
        text: text.into(),
        // From the path, because the extension is what decides whether `<div/>`
        // is JSX or a comparison -- and poly maps eight of them to this one
        // language.
        media_type: deno_ast::MediaType::from_path(path),
        capture_tokens: false,
        scope_analysis: false,
        maybe_syntax: None,
    })
    .map_err(|e| anyhow!("{e}"))?;
    // swc recovers from most syntax errors and keeps building a tree, so a file
    // can parse and still be broken. Emitting from a recovered tree is the one
    // failure this cannot afford: what comes out is compact, confident, and not
    // the program that went in.
    if let Some(first) = parsed.diagnostics().first() {
        return Err(anyhow!("{first}"));
    }

    // A second source map over the same text. deno_ast builds one internally
    // and does not hand it out, and the emitter needs one to resolve the spans
    // in the tree; both are built the same way from the same bytes, so the
    // positions agree.
    let source_map = deno_ast::SourceMap::single(specifier, text.to_string());
    let mut out = Vec::new();
    {
        let writer = JsWriter::new(source_map.inner().clone(), "\n", &mut out, None);
        let mut emitter = Emitter {
            // One switch, and deliberately only one. `with_omit_last_semi` is
            // the neighbouring knob and it stays off: a statement that loses
            // its semicolon is one ASI hazard away from meaning something else
            // when anything is appended to the file.
            cfg: Config::default().with_minify(true),
            // Dropped, for the reason `strip_json` drops them: a comment is the
            // one thing in the file that is unambiguously for a human.
            comments: None,
            cm: source_map.inner().clone(),
            wr: writer,
        };
        match parsed.program_ref() {
            deno_ast::ProgramRef::Module(module) => module.emit_with(&mut emitter)?,
            deno_ast::ProgramRef::Script(script) => script.emit_with(&mut emitter)?,
        }
    }
    String::from_utf8(out).map_err(|e| anyhow!("javascript minify produced invalid UTF-8: {e}"))
}

fn format_markdown(text: &str, opts: FormatOptions) -> Result<Option<String>> {
    use dprint_plugin_markdown::configuration::{Configuration, ConfigurationBuilder};
    static CONFIG: OnceLock<Configuration> = OnceLock::new();
    let overridden;
    let config = if opts.is_default() {
        CONFIG.get_or_init(|| ConfigurationBuilder::new().build())
    } else {
        let mut builder = ConfigurationBuilder::new();
        if let Some(width) = opts.line_width {
            builder.line_width(width.into());
        }
        overridden = builder.build();
        &overridden
    };
    // Fenced code blocks dispatch back into the other engines by info-string
    // tag; unknown tags pass through unchanged rather than erroring.
    dprint_plugin_markdown::format_text(text, config, |tag, code, _line_width| {
        let path = format!("block.{}", code_block_extension(tag));
        match format_file(Path::new(&path), code) {
            Ok(result) => Ok(result),
            Err(_) => Ok(None),
        }
    })
    .map_err(Into::into)
}

/// Map a fenced-code info string to an extension our detection understands.
fn code_block_extension(tag: &str) -> &str {
    match tag {
        "typescript" => "ts",
        "javascript" => "js",
        "python" => "py",
        "yaml" | "yml" => "yaml",
        "graphql" => "graphql",
        other => other, // ts/js/json/css/sql/html/... already are extensions
    }
}

fn format_toml(path: &Path, text: &str, opts: FormatOptions) -> Result<Option<String>> {
    use dprint_plugin_toml::configuration::{Configuration, ConfigurationBuilder};
    static CONFIG: OnceLock<Configuration> = OnceLock::new();
    let overridden;
    let config = if opts.is_default() {
        CONFIG.get_or_init(|| ConfigurationBuilder::new().build())
    } else {
        let mut builder = ConfigurationBuilder::new();
        if let Some(width) = opts.line_width {
            builder.line_width(width.into());
        }
        if let Some(width) = opts.indent_width {
            builder.indent_width(width);
        }
        if let Some(tabs) = opts.use_tabs {
            builder.use_tabs(tabs);
        }
        overridden = builder.build();
        &overridden
    };
    dprint_plugin_toml::format_text(path, text, config).map_err(Into::into)
}

fn format_css(text: &str, lang: &str, opts: FormatOptions) -> Result<Option<String>> {
    let syntax = match lang {
        "scss" => malva::Syntax::Scss,
        "less" => malva::Syntax::Less,
        _ => malva::Syntax::Css,
    };
    let mut options = malva::config::FormatOptions::default();
    if let Some(width) = opts.line_width {
        options.layout.print_width = width.into();
    }
    if let Some(width) = opts.indent_width {
        options.layout.indent_width = width.into();
    }
    if let Some(tabs) = opts.use_tabs {
        options.layout.use_tabs = tabs;
    }
    let result = malva::format_text(text, syntax, &options).map_err(|e| anyhow!("css {e}"))?;
    Ok((result != text).then_some(result))
}

fn format_yaml(text: &str, opts: FormatOptions) -> Result<Option<String>> {
    let mut options = pretty_yaml::config::FormatOptions::default();
    if let Some(width) = opts.line_width {
        options.layout.print_width = width.into();
    }
    if let Some(width) = opts.indent_width {
        options.layout.indent_width = width.into();
    }
    // Display is the parser's code frame -- "parse error at line 2, column 4"
    // plus the offending line and a caret, the same shape the dprint engines
    // produce. Debug printed the struct instead, which buried the position in
    // an escaped string and carried a copy of the whole input along with it.
    // The frame already opens with "parse error at line N, column M", so the
    // prefix is just the language.
    let result = pretty_yaml::format_text(text, &options).map_err(|e| anyhow!("yaml {e}"))?;
    Ok((result != text).then_some(result))
}

/// Byte offset to a 1-based line and column.
///
/// Columns count characters, not bytes, so a message about a line with
/// non-ASCII text before the error points where an editor puts its cursor.
fn line_col(text: &str, offset: usize) -> (usize, usize) {
    let mut offset = offset.min(text.len());
    // A parser can hand back an offset mid-character; walking back to the
    // boundary keeps the slice below from panicking.
    while offset > 0 && !text.is_char_boundary(offset) {
        offset -= 1;
    }
    let before = &text[..offset];
    let line_start = before.rfind('\n').map_or(before, |i| &before[i + 1..]);
    (
        before.matches('\n').count() + 1,
        line_start.chars().count() + 1,
    )
}

/// `[format.python]`, as ruff's formatter takes it.
///
/// Shared by `.py` and `.ipynb`: a notebook's cells are Python and have to be
/// laid out to the same settings, or the same code is formatted two ways
/// depending on which file it happens to live in.
fn python_options(
    path: &Path,
    opts: FormatOptions,
) -> Result<ruff_python_formatter::PyFormatOptions> {
    let mut options = ruff_python_formatter::PyFormatOptions::from_extension(path);
    if let Some(width) = opts.line_width {
        options = options.with_line_width(
            width
                .try_into()
                .map_err(|_| anyhow!("[format.python] line-width must be at least 1"))?,
        );
    }
    if let Some(width) = opts.indent_width {
        options = options.with_indent_width(
            width
                .try_into()
                .map_err(|_| anyhow!("[format.python] indent-width must be at least 1"))?,
        );
    }
    if let Some(tabs) = opts.use_tabs {
        options = options.with_indent_style(if tabs {
            ruff_formatter::IndentStyle::Tab
        } else {
            ruff_formatter::IndentStyle::Space
        });
    }
    Ok(options)
}

fn format_python(path: &Path, text: &str, opts: FormatOptions) -> Result<Option<String>> {
    let options = python_options(path, opts)?;
    let printed = ruff_python_formatter::format_module_source(text, options)
        .map_err(|e| python_error(text, &e))?;
    let result = printed.into_code();
    Ok((result != text).then_some(result))
}

/// Format a Jupyter notebook: each code cell as Python, the container left
/// alone but rewritten.
///
/// Cell by cell rather than over the concatenated source, because that is what
/// ruff does and the difference is visible: formatting the whole thing at once
/// would let a blank-line rule reach across a cell boundary, and cells are
/// edited and executed one at a time. The `SourceMap` is how the new text is
/// mapped back onto cells -- `Notebook::update` walks it to move each cell
/// offset by however much the text before it grew or shrank.
///
/// Nothing is written unless some cell actually changed, so an already
/// formatted notebook is not rewritten with different JSON whitespace.
fn format_jupyter(path: &Path, text: &str, opts: FormatOptions) -> Result<Option<String>> {
    use ruff_text_size::{TextLen, TextRange, TextSize};

    let mut notebook = ruff_notebook::Notebook::from_source_code(text)
        .map_err(|e| anyhow!("reading {}: {e}", path.display()))?;
    // An R or Julia notebook is a notebook poly has no formatter for. Silence
    // is the honest answer; running the Python formatter over it would be a
    // syntax error at best.
    if !notebook.is_python_notebook() {
        return Ok(None);
    }
    let options = python_options(path, opts)?;
    let source = notebook.source_code().to_string();

    let mut output: Option<String> = None;
    let mut source_map = ruff_diagnostics::SourceMap::default();
    let mut last: Option<TextSize> = None;
    for pair in notebook.cell_offsets().windows(2) {
        let (start, end) = (pair[0], pair[1]);
        let unformatted = &source[TextRange::new(start, end)];
        let printed = ruff_python_formatter::format_module_source(unformatted, options.clone())
            .map_err(|e| python_error(unformatted, &e))?;
        let formatted = printed.as_code();
        if formatted == unformatted {
            continue;
        }
        let output = output.get_or_insert_with(|| String::with_capacity(source.len()));
        // Everything since the last cell this loop rewrote, verbatim.
        output.push_str(&source[TextRange::new(last.unwrap_or_default(), start)]);
        source_map.push_marker(start, output.text_len());
        output.push_str(formatted);
        source_map.push_marker(end, output.text_len());
        last = Some(end);
    }
    let Some(mut output) = output else {
        return Ok(None);
    };
    output.push_str(&source[usize::from(last.unwrap_or_default())..]);
    notebook.update(&source_map, output);

    let mut result = Vec::new();
    notebook
        .write(&mut result)
        .map_err(|e| anyhow!("writing {}: {e}", path.display()))?;
    let result = String::from_utf8(result).map_err(|_| anyhow!("notebook output not UTF-8"))?;
    let result =
        with_sorted_keys(&result).with_context(|| format!("writing {}", path.display()))?;
    Ok((result != text).then_some(result))
}

/// Re-emit a notebook with every JSON object's keys in alphabetical order.
///
/// This is what `ruff_notebook`'s own writer means to do, and cannot here. It
/// sorts by round-tripping through `serde_json::Value`, which is a `BTreeMap`
/// only while `serde_json` is built *without* `preserve_order`. rumdl asks for
/// that feature and cargo unifies features across the whole tree, so inside
/// poly a `Value` is an `IndexMap` — and the order it faithfully preserves is
/// the insertion order of the `#[serde(flatten)] HashMap` that holds every
/// metadata key ruff does not name, which Rust randomises per process.
///
/// The symptom is not a wrong byte but an unstable one: five `poly fmt` runs
/// over one notebook wrote two different files, so `poly fmt --check` could
/// fail in CI on a notebook nobody had touched, and every save produced a diff
/// in `kernelspec`. Found by `tools/lsp-fmt-diff.py`, which asked the daemon
/// and the CLI about the same notebook and got different answers because they
/// are different processes.
fn with_sorted_keys(text: &str) -> Result<String> {
    use serde::Serialize;

    let mut value: serde_json::Value = serde_json::from_str(text)?;
    sort_keys(&mut value);

    let mut out = Vec::new();
    // The shape ruff_notebook writes, kept byte for byte: one space of indent
    // (black's choice, which nbformat follows) and the trailing newline only
    // if the notebook it just wrote had one.
    let mut serializer = serde_json::Serializer::with_formatter(
        &mut out,
        serde_json::ser::PrettyFormatter::with_indent(b" "),
    );
    value.serialize(&mut serializer)?;
    let mut out = String::from_utf8(out).map_err(|_| anyhow!("notebook output not UTF-8"))?;
    if text.ends_with('\n') {
        out.push('\n');
    }
    Ok(out)
}

fn sort_keys(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            let mut entries: Vec<_> = std::mem::take(map).into_iter().collect();
            entries.sort_by(|(a, _), (b, _)| a.cmp(b));
            for (_, nested) in &mut entries {
                sort_keys(nested);
            }
            *map = entries.into_iter().collect();
        }
        serde_json::Value::Array(items) => items.iter_mut().for_each(sort_keys),
        _ => {}
    }
}

/// ruff's own Display ends in "at byte range 6..7", which no editor and no
/// human can act on. The parse error carries the range, so translate it and
/// use the inner message, which is the same text minus that suffix.
fn python_error(text: &str, err: &ruff_python_formatter::FormatModuleError) -> anyhow::Error {
    match err {
        ruff_python_formatter::FormatModuleError::ParseError(parse) => {
            let (line, col) = line_col(text, usize::from(parse.location.start()));
            anyhow!(
                "python parse error at line {line}, column {col}: {}",
                parse.error
            )
        }
        // Formatting and printing failures are internal to ruff and carry no
        // source position at all; there is nothing to translate.
        other => anyhow!("python format error: {other}"),
    }
}

/// stylua honors all three knobs, so `honored` needs no arm for lua: the
/// column width guides wrapping, and `indent_type` plus `indent_width` are the
/// other two spelled its way. Tabs are stylua's own default, which is why
/// `use-tabs` is left unset rather than defaulted to false here -- a poly that
/// silently spaced every Lua file would disagree with every stylua.toml in
/// existence.
///
/// `OutputVerification::None` matches the CLI, where reparsing the output is
/// opt-in behind `--verify`. `Range` is None because poly formats whole
/// documents; the LSP's Format Selection diffs the result instead (see
/// `similar` in Cargo.toml).
fn format_lua(text: &str, opts: FormatOptions) -> Result<Option<String>> {
    let mut config = stylua_lib::Config::default();
    if let Some(width) = opts.line_width {
        config.column_width = width.into();
    }
    if let Some(width) = opts.indent_width {
        config.indent_width = width.into();
    }
    if let Some(tabs) = opts.use_tabs {
        config.indent_type = if tabs {
            stylua_lib::IndentType::Tabs
        } else {
            stylua_lib::IndentType::Spaces
        };
    }
    // stylua's Display already carries `(line:col to line:col)` for a parse
    // error, so unlike ruff there is nothing to translate -- only the language
    // to name, the way malva and pretty_yaml are prefixed.
    let result = stylua_lib::format_code(text, config, None, stylua_lib::OutputVerification::None)
        .map_err(|e| anyhow!("lua {e}"))?;
    Ok((result != text).then_some(result))
}

/// Shared warm sqruff instance (construction loads the rule set; lint_string
/// takes &self). Dialect defaults to ansi until per-language options land.
pub(crate) fn sql_linter() -> Result<&'static sqruff_lib::core::linter::core::Linter> {
    use sqruff_lib::core::linter::core::Linter;
    static LINTER: OnceLock<std::result::Result<Linter, String>> = OnceLock::new();
    LINTER
        .get_or_init(|| {
            Linter::new(
                sqruff_lib::core::config::FluffConfig::default(),
                None,
                None,
                false,
            )
        })
        .as_ref()
        .map_err(|e| anyhow!("sqruff init error: {e}"))
}

fn format_sql(text: &str) -> Result<Option<String>> {
    let linted = sql_linter()?
        .lint_string(text, None, true)
        .map_err(|e| anyhow!("sql format error: {e}"))?;
    let result = linted.fix_string();
    Ok((result != text).then_some(result))
}

fn format_xml(text: &str, opts: FormatOptions) -> Result<Option<String>> {
    // Display, not Debug: Debug printed the raw variant tree
    // ("Parse(IllFormed(MismatchedEndTag { .. }))") at the user. No position
    // either way — xmlem drops the reader offset when it wraps the quick_xml
    // error, so the message can only say what is wrong, not where.
    let doc: xmlem::Document = text.parse().map_err(|e| anyhow!("xml parse error: {e}"))?;
    let mut result = match opts.indent_width {
        Some(width) => doc.to_string_pretty_with_config(
            &xmlem::display::Config::default_pretty().indent(width.into()),
        ),
        None => doc.to_string_pretty(),
    };
    if !result.ends_with('\n') {
        result.push('\n');
    }
    Ok((result != text).then_some(result))
}

fn format_markup(text: &str, lang: &str, opts: FormatOptions) -> Result<Option<String>> {
    let language = match lang {
        "vue" => markup_fmt::Language::Vue,
        "svelte" => markup_fmt::Language::Svelte,
        "astro" => markup_fmt::Language::Astro,
        "jinja" => markup_fmt::Language::Jinja,
        // Handlebars is a superset of Mustache, and markup_fmt's Mustache
        // parser covers the superset: block helpers indent their bodies,
        // `{{else}}` dedents, block params (`as |item idx|`) and partials with
        // arguments survive. Falling through to Html instead would treat every
        // `{{#if}}` as prose and run the block onto one line -- which is what
        // this arm exists to stop, and what its test asserts.
        "handlebars" => markup_fmt::Language::Mustache,
        _ => markup_fmt::Language::Html,
    };
    let mut options = markup_fmt::config::FormatOptions::default();
    if let Some(width) = opts.line_width {
        options.layout.print_width = width.into();
    }
    if let Some(width) = opts.indent_width {
        options.layout.indent_width = width.into();
    }
    if let Some(tabs) = opts.use_tabs {
        options.layout.use_tabs = tabs;
    }
    // Embedded <script>/<style> blocks dispatch into our engines via the
    // hint extension; unformattable snippets pass through unchanged.
    let result = markup_fmt::format_text(text, language, &options, |code, hints| {
        let path = format!("block.{}", hints.ext);
        match format_file(Path::new(&path), code) {
            Ok(Some(formatted)) => Ok(formatted.into()),
            _ => Ok(code.into()),
        }
    })
    .map_err(|e| anyhow!("{lang} {e}"))?;
    Ok((result != text).then_some(result))
}

fn format_graphql(text: &str, opts: FormatOptions) -> Result<Option<String>> {
    let mut options = pretty_graphql::config::FormatOptions::default();
    if let Some(width) = opts.line_width {
        options.layout.print_width = width.into();
    }
    if let Some(width) = opts.indent_width {
        options.layout.indent_width = width.into();
    }
    if let Some(tabs) = opts.use_tabs {
        options.layout.use_tabs = tabs;
    }
    // The error is deliberately not the one pretty_graphql wrote: formatting it
    // panics on a syntax error at byte 0, and `graphql_format_error` says the
    // same thing from the same parser without that hole in it.
    let result = pretty_graphql::format_text(text, &options)
        .map_err(|_| anyhow!("graphql {}", crate::lint::graphql_format_error(text)))?;
    Ok((result != text).then_some(result))
}

/// PHP, through mago's formatter.
///
/// Its three settings are poly's three, and its defaults are already PSR-12's
/// (120 columns, four spaces), so there is nothing for poly to override -- the
/// house style a PHP repository already has is the one it gets.
///
/// The output was compared byte for byte against the released `mago 1.47.6`
/// binary over 20,200 files from eight pinned packages: identical everywhere,
/// including the three files neither of them can parse.
fn format_php(path: &Path, text: &str, opts: FormatOptions) -> Result<Option<String>> {
    let mut settings = mago_formatter::settings::FormatSettings::default();
    if let Some(width) = opts.line_width {
        settings.print_width = width.into();
    }
    if let Some(width) = opts.indent_width {
        settings.tab_width = width.into();
    }
    if let Some(tabs) = opts.use_tabs {
        settings.use_tabs = tabs;
    }
    let arena = mago_allocator::LocalArena::new();
    let file = crate::lint::php_file(path, text);
    let formatter = mago_formatter::Formatter::new(&arena, crate::lint::php_version(), settings);
    // mago's own error names neither the position nor the token; the parser it
    // just used does, and `php_format_error` is what `poly check` reports.
    let formatted = formatter
        .format_file(&file)
        .map_err(|_| anyhow!("php {}", crate::lint::php_format_error(text)))?;
    let result = String::from_utf8(formatted.to_vec())
        .map_err(|_| anyhow!("php formatter produced invalid UTF-8"))?;
    Ok((result != text).then_some(result))
}

fn format_dockerfile(path: &Path, text: &str, opts: FormatOptions) -> Result<Option<String>> {
    use dprint_plugin_dockerfile::configuration::{Configuration, ConfigurationBuilder};
    static CONFIG: OnceLock<Configuration> = OnceLock::new();
    let overridden;
    let config = if opts.is_default() {
        CONFIG.get_or_init(|| ConfigurationBuilder::new().build())
    } else {
        let mut builder = ConfigurationBuilder::new();
        if let Some(width) = opts.line_width {
            builder.line_width(width.into());
        }
        if let Some(width) = opts.indent_width {
            builder.indent_width(width);
        }
        overridden = builder.build();
        &overridden
    };
    dprint_plugin_dockerfile::format_text(path, text, config)
        .map_err(|e| anyhow!("dockerfile format error: {e:#}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A `css` tagged template is CSS, and poly formats it.
    ///
    /// The declaration list is the whole point: what sits between the
    /// backticks is a fragment, not a stylesheet, so it reaches malva wrapped
    /// in a rule and comes back unwrapped (`embedded_css`). An off-by-one in
    /// that unwrapping shows up here as a stray indent or a lost first
    /// property.
    #[test]
    fn a_css_tagged_template_is_formatted_as_css() {
        let formatted = format_file(
            Path::new("a.ts"),
            "const s = css`color:red;background:blue`;\n",
        )
        .expect("typescript must format")
        .expect("the template needs formatting, so there must be output");
        assert_eq!(
            formatted,
            "const s = css`\n  color: red;\n  background: blue;\n`;\n",
        );
    }

    /// An interpolated template is still formatted, and every expression comes
    /// back byte for byte.
    ///
    /// The plugin swaps each `${}` for a numbered placeholder before calling
    /// poly, so what malva sees is a stylesheet and not a fragment with holes.
    /// The risk is on the way back: an engine that reorders declarations or
    /// drops an unknown identifier would silently move an author's expression
    /// to another property. `styled.div` is here because the plugin resolves it
    /// to css by the tag's shape rather than by its name.
    #[test]
    fn an_interpolated_tagged_template_keeps_its_expressions() {
        let formatted = format_file(
            Path::new("a.ts"),
            "const s = styled.div`color:${fg};padding:${p}px`;\n",
        )
        .expect("typescript must format")
        .expect("the template needs formatting, so there must be output");
        assert_eq!(
            formatted,
            "const s = styled.div`\n  color: ${fg};\n  padding: ${p}px;\n`;\n",
        );
    }

    /// The same for `html`, which reaches markup_fmt.
    #[test]
    fn an_html_tagged_template_is_formatted_as_markup() {
        let formatted = format_file(
            Path::new("a.ts"),
            "const t = html`<div   ><p>hi</p></div>`;\n",
        )
        .expect("typescript must format")
        .expect("the template needs formatting, so there must be output");
        assert!(formatted.contains("<div>"), "{formatted:?}");
        assert!(formatted.contains("<p>hi</p>"), "{formatted:?}");
    }

    /// A tag poly has no language for, and a fragment that does not parse, both
    /// leave the template exactly as written.
    ///
    /// This is the half that keeps the feature from being a liability: a
    /// template is often not valid anything, and the author's bytes must
    /// survive being guessed at.
    #[test]
    fn an_unformattable_tagged_template_is_left_alone() {
        // A tag with no engine behind it.
        assert!(format_file(
            Path::new("a.ts"),
            "const q = graphqlish`{ not  touched }`;\n"
        )
        .expect("typescript must format")
        .is_none_or(|out| out.contains("{ not  touched }")));
        // And a `css` tag whose contents are not CSS at all.
        let broken = format_file(Path::new("a.ts"), "const s = css`@@@ not ; css {{{`;\n")
            .expect("a bad fragment must not fail the file");
        assert!(
            broken.is_none_or(|out| out.contains("@@@ not ; css {{{")),
            "the author's bytes must survive",
        );
    }

    /// A notebook must format to the same bytes every time it is formatted.
    ///
    /// Not a style preference: unsorted output here is *unstable* output. See
    /// `with_sorted_keys` for why ruff_notebook's own sort stops working
    /// inside poly. Before the fix, five `poly fmt` runs over one notebook
    /// wrote two different files, so `poly fmt --check` could fail in CI on a
    /// notebook nobody had touched.
    ///
    /// Asserting the keys are sorted rather than running it twice and hoping
    /// the orders differ: a `HashMap`'s order is random, so a two-run test
    /// passes about half the time on the broken code.
    #[test]
    fn a_notebook_formats_to_stable_bytes() {
        // Metadata keys deliberately out of alphabetical order, and one cell
        // that needs formatting so there is something to write back at all.
        let source = r#"{
 "cells": [
  {
   "cell_type": "code",
   "execution_count": null,
   "metadata": {},
   "outputs": [],
   "source": ["x = ( 1 )"]
  }
 ],
 "metadata": {
  "kernelspec": {
   "display_name": "Python 3",
   "language": "python",
   "name": "python3"
  },
  "language_info": {
   "version": "3.12.0",
   "name": "python",
   "pygments_lexer": "ipython3",
   "nbconvert_exporter": "python"
  }
 },
 "nbformat": 4,
 "nbformat_minor": 5
}
"#;
        let formatted = format_file(Path::new("n.ipynb"), source)
            .expect("notebook must format")
            .expect("the cell needs formatting, so there must be output");

        fn assert_sorted(value: &serde_json::Value, where_: &str) {
            match value {
                serde_json::Value::Object(map) => {
                    let keys: Vec<_> = map.keys().cloned().collect();
                    let mut want = keys.clone();
                    want.sort();
                    assert_eq!(keys, want, "keys out of order at {where_}");
                    for (key, nested) in map {
                        assert_sorted(nested, &format!("{where_}.{key}"));
                    }
                }
                serde_json::Value::Array(items) => {
                    for (i, item) in items.iter().enumerate() {
                        assert_sorted(item, &format!("{where_}[{i}]"));
                    }
                }
                _ => {}
            }
        }
        assert_sorted(&serde_json::from_str(&formatted).unwrap(), "");

        // And the other half of stable: formatting the result again is a no-op
        // rather than another rewrite.
        assert_eq!(
            format_file(Path::new("n.ipynb"), &formatted).unwrap(),
            None,
            "an already-formatted notebook must not be rewritten"
        );
    }

    #[test]
    fn formats_each_language() {
        let cases: &[(&str, &str)] = &[
            ("a.ts", "const  x = {a:1,\n\n\n b:2};"),
            ("a.json", "{\"b\":1,  \"a\":[1,2,\n3]}"),
            ("a.md", "# title\n\n\n\ntext   here"),
            ("a.toml", "a=1\nb   = 2"),
            ("a.css", ".x{color:red;margin:0}"),
            ("a.yaml", "a:   1\nb:\n-   x"),
            ("a.py", "def  f( a,b ):\n    return a+b"),
            ("a.sql", "select a,b from t where x=1"),
            ("a.xml", "<root><a>1</a><b attr='2'/></root>"),
            ("a.html", "<div><p>hi</p><style>a{color:red}</style></div>"),
            ("a.graphql", "query { user(id:1){name email} }"),
            ("a.lua", "local  function f( a,b )\nreturn a+b\nend"),
            ("Dockerfile", "FROM  alpine:3\nrun echo hi\n"),
            (
                "a.hbs",
                "<div  class=\"a\">{{#if x}}<p>{{y}}</p>{{/if}}</div>",
            ),
        ];
        for (name, input) in cases {
            let out = format_file(Path::new(name), input).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert!(out.is_some(), "{name}: expected a formatting change");
        }
    }

    /// Handlebars routes to markup_fmt's Mustache parser rather than falling
    /// through to Html. The difference is not cosmetic: Html reads `{{#if}}` as
    /// prose, so it neither indents the block nor keeps it on its own line, and
    /// the result is a template whose structure has been flattened. Asserting
    /// the Html output is *different* is what makes this a test of the arm and
    /// not of markup_fmt.
    #[test]
    fn handlebars_blocks_are_parsed_not_treated_as_prose() {
        let text =
            "<div>\n{{#if user}}\n<p>{{user.name}}</p>\n{{else}}\n<p>anon</p>\n{{/if}}\n</div>\n";
        let opts = FormatOptions::default();
        let handlebars = format_markup(text, "handlebars", opts)
            .expect("handlebars formats")
            .expect("handlebars changes something");
        // The block body is indented under its opener, and `{{else}}` comes
        // back out -- neither happens when the braces are just text.
        assert!(
            handlebars.contains("  {{#if user}}\n    <p>{{user.name}}</p>\n  {{else}}"),
            "{handlebars}"
        );
        let html = format_markup(text, "html", opts)
            .expect("html formats")
            .expect("html changes something");
        assert_ne!(handlebars, html, "Mustache and Html cannot agree here");
    }

    /// lua is the one engine that takes all three knobs without an `honored`
    /// arm to declare it, and the failure that creates is silent: a setting
    /// poly claims to apply and stylua ignores reads as working and does
    /// nothing. So each knob is asserted against output only it could produce.
    #[test]
    fn lua_honors_all_three_format_options() {
        let lua = |text: &str, opts| format("lua", Path::new("a.lua"), text, opts);

        // Tabs are stylua's own default, so a space indent can only have come
        // from use-tabs, and its width only from indent-width.
        let body = "if x then\nreturn 1\nend\n";
        let spaced = lua(
            body,
            FormatOptions {
                line_width: None,
                indent_width: Some(2),
                use_tabs: Some(false),
            },
        )
        .expect("lua formats")
        .expect("the indent has to change");
        assert!(spaced.contains("\n  return 1"), "{spaced}");
        assert!(lua(body, FormatOptions::default())
            .unwrap()
            .unwrap()
            .contains("\n\treturn 1"));

        // Wide enough for stylua's default 120 and not for 20, so the line
        // splitting is the setting and nothing else.
        let table = "local t = { alpha = 1, beta = 2, gamma = 3, delta = 4 }\n";
        assert_eq!(
            lua(table, FormatOptions::default()).unwrap(),
            None,
            "already formatted at the default width"
        );
        let narrow = lua(
            table,
            FormatOptions {
                line_width: Some(20),
                indent_width: None,
                use_tabs: None,
            },
        )
        .expect("lua formats")
        .expect("20 columns cannot hold that line");
        assert!(narrow.lines().count() > 1, "{narrow}");
    }

    /// MDX goes through the markdown engine, so the question is not whether it
    /// formats but whether it destroys anything: an ESM import line and a JSX
    /// block both have to come back byte-identical while the prose around them
    /// is still normalized. prettier does more than this when a project has it
    /// (poly hands over the real path, so prettier picks its mdx parser); this
    /// is the floor for everyone else.
    #[test]
    fn mdx_keeps_its_imports_and_jsx() {
        let text = "import { Chart } from './chart'\n\n# Title\n\nSome   text.\n\n<Chart data={[1,2,3]}   kind=\"bar\" />\n\n-   a\n";
        let out = format_file(Path::new("a.mdx"), text)
            .expect("mdx formats")
            .expect("the prose needs normalizing");
        assert!(out.contains("import { Chart } from './chart'"), "{out}");
        assert!(
            out.contains("<Chart data={[1,2,3]}   kind=\"bar\" />"),
            "{out}"
        );
        assert!(out.contains("Some text."), "{out}");
        assert!(out.contains("- a"), "{out}");
    }

    /// The three things minifying must not do: reorder keys, touch what is
    /// inside a string, or be fooled by an escaped quote into thinking a string
    /// has ended.
    #[test]
    fn minify_strips_only_what_is_outside_strings() {
        let text =
            "{\n  \"b\": 1,\n  \"a\": \"keep  me\",\n  \"q\": \"a \\\" b\",\n  \"n\": [1, 2]\n}\n";
        let out = minify("json", Path::new("a.json"), text).unwrap().unwrap();
        assert_eq!(
            out,
            "{\"b\":1,\"a\":\"keep  me\",\"q\":\"a \\\" b\",\"n\":[1,2]}"
        );
    }

    /// `.jsonc` reads as json here, so a comment is the one thing in the file
    /// that is unambiguously for a human and the one thing to drop.
    #[test]
    fn minify_drops_comments_but_not_urls_inside_strings() {
        let text =
            "{\n  // leading\n  \"u\": \"https://example.com/a\", /* trailing */\n  \"v\": 2\n}";
        let out = minify("json", Path::new("a.jsonc"), text).unwrap().unwrap();
        assert_eq!(out, "{\"u\":\"https://example.com/a\",\"v\":2}");
    }

    #[test]
    fn minify_declines_other_languages_and_already_minified_json() {
        // Not a failure: a caller batching a directory hands over every file.
        assert!(minify("markdown", Path::new("a.md"), "# t\n")
            .unwrap()
            .is_none());
        // Nothing to remove means no edit, so an editor command is a no-op
        // rather than a change that dirties the buffer.
        assert!(minify("json", Path::new("a.json"), "{\"a\":1}")
            .unwrap()
            .is_none());
    }

    /// The languages that format here and still must not minify, each for its
    /// own reason -- see `minifiable_language`. Worth a test rather than a
    /// comment because every one of them has an engine sitting right there that
    /// would produce *something* if the match arm were widened by a line.
    #[test]
    fn minify_declines_languages_a_printer_could_have_handled() {
        for (lang, file, text) in [
            // Whitespace-significant: one line is a different document.
            ("yaml", "a.yaml", "a:\n  - 1\n"),
            ("toml", "a.toml", "[a]\nb = 1\n"),
            // Formats as CSS, parses with a parser lightningcss does not have.
            ("scss", "a.scss", "a { b { color: red; } }\n"),
            ("less", "a.less", "@x: red;\na { color: @x; }\n"),
            // Formats as markup; an HTML minifier would read the custom blocks
            // as content to collapse.
            ("vue", "a.vue", "<template>\n  <p>hi</p>\n</template>\n"),
            ("svelte", "a.svelte", "<p>\n  hi\n</p>\n"),
        ] {
            assert!(
                minify(lang, Path::new(file), text).unwrap().is_none(),
                "{lang} must decline, not minify"
            );
        }
    }

    /// Invalid input must fail rather than produce confidently broken output,
    /// and it has to fail the way `poly fmt` already fails on the same file.
    ///
    /// All five, because they reach that guarantee by two different routes:
    /// json, css and html run the formatter first, xml and typescript parse
    /// with the crate the formatter parses with. A regression in either route
    /// looks the same from here, which is the point.
    #[test]
    fn minify_rejects_what_the_formatter_rejects() {
        for (lang, file, broken) in [
            ("json", "a.json", "{\"a\": }"),
            ("css", "a.css", "a { color: }}}"),
            ("xml", "a.xml", "<a></b>"),
            ("typescript", "a.js", "function ( {"),
        ] {
            assert!(
                minify(lang, Path::new(file), broken).is_err(),
                "{lang} minified something broken"
            );
            assert!(
                format_file(Path::new(file), broken).is_err(),
                "{lang} formats what it refuses to minify"
            );
        }
    }

    /// CSS collapses to one line, and the three things that are not whitespace
    /// stay: the space in a descendant combinator, the spaces inside `calc()`,
    /// and a declaration that a later one shadows.
    ///
    /// The last is the one that tells a printer from an optimiser.
    /// `StyleSheet::minify` drops the shadowed `color: red` -- correctly, by
    /// its own cascade model -- and that is a file the user did not write.
    ///
    /// The colour assertion pins the exception rather than the rule: `blue`
    /// coming back as `#00f` is the compact printer spelling a value short, and
    /// it is the only rewriting `poly minify` does in any language. Asserted
    /// exactly, so that a lightningcss release which starts rewriting something
    /// else fails here instead of shipping.
    #[test]
    fn minify_css_prints_compactly_without_optimizing() {
        let text = concat!(
            "/* a comment */\n",
            ".a .b {\n",
            "  color: red;\n",
            "  color: blue;\n",
            "  width: calc(100% - 2px);\n",
            "}\n",
        );
        let out = minify("css", Path::new("a.css"), text).unwrap().unwrap();
        assert_eq!(
            out, ".a .b{color:red;color:#00f;width:calc(100% - 2px)}",
            "the comment must go, and nothing else may"
        );
    }

    /// HTML is the one language here where collapsing whitespace is sometimes
    /// wrong, so the test is mostly about what does *not* change: the space
    /// between two inline elements that the renderer draws, everything inside
    /// `<pre>`, and the closing tags minify-html would otherwise omit.
    #[test]
    fn minify_html_keeps_the_whitespace_a_browser_renders() {
        let text = concat!(
            "<!doctype html>\n",
            "<html>\n",
            "  <body>\n",
            "    <!-- gone -->\n",
            "    <p>a <em>b</em> c</p>\n",
            "    <pre>  kept  </pre>\n",
            "    <ul>\n",
            "      <li>one</li>\n",
            "    </ul>\n",
            "  </body>\n",
            "</html>\n",
        );
        let out = minify("html", Path::new("a.html"), text).unwrap().unwrap();
        assert!(!out.contains("gone"), "comment survived: {out}");
        assert!(out.contains("a <em>b</em> c"), "inline spacing lost: {out}");
        assert!(out.contains("<pre>  kept  </pre>"), "pre collapsed: {out}");
        assert!(out.contains("</li>"), "closing tag omitted: {out}");
        assert!(out.contains("<html"), "<html> omitted: {out}");
    }

    /// Indentation goes; character data does not. The `<b>` is the claim worth
    /// pinning -- mixed content is where an XML pretty-printer's inverse stops
    /// being merely cosmetic.
    #[test]
    fn minify_xml_drops_indentation_and_keeps_character_data() {
        let text = "<a>\n  <b>  two  spaces  </b>\n  <c d=\"1\"/>\n</a>\n";
        let out = minify("xml", Path::new("a.xml"), text).unwrap().unwrap();
        assert!(!out.contains("\n  <"), "indentation survived: {out}");
        assert!(out.contains("two  spaces"), "text content changed: {out}");
        assert!(out.contains("d=\"1\""), "attribute lost: {out}");
    }

    /// Whitespace and comments go; nothing else does. Every assertion here is a
    /// thing `swc_ecma_minifier` would have done and the emitter must not:
    /// renaming the local, folding the constant, and deleting the branch it can
    /// prove is dead.
    #[test]
    fn minify_javascript_renames_and_folds_nothing() {
        let text = concat!(
            "// a comment\n",
            "export function go(aLongParameterName) {\n",
            "  const anUnusedLocal = 1 + 2;\n",
            "  if (false) {\n",
            "    neverCalled();\n",
            "  }\n",
            "  return aLongParameterName;\n",
            "}\n",
        );
        let out = minify("typescript", Path::new("a.js"), text)
            .unwrap()
            .unwrap();
        assert!(!out.contains("a comment"), "comment survived: {out}");
        assert!(out.len() < text.len(), "nothing was stripped: {out}");
        assert!(out.contains("aLongParameterName"), "renamed: {out}");
        assert!(
            out.contains("anUnusedLocal"),
            "dropped an unused local: {out}"
        );
        assert!(
            out.contains("1+2") || out.contains("1 + 2"),
            "folded: {out}"
        );
        assert!(out.contains("neverCalled"), "dropped a dead branch: {out}");
    }

    /// TypeScript's own syntax survives a minify, which is what makes the
    /// language id rather than the extension the right gate: poly reads `.ts`
    /// and `.js` as one language, and an arm that quietly transpiled one of
    /// them would be doing a different job than the other.
    #[test]
    fn minify_typescript_keeps_its_types() {
        let text = "export const n: number = 1;\ninterface Shape {\n  side: string;\n}\n";
        let out = minify("typescript", Path::new("a.ts"), text)
            .unwrap()
            .unwrap();
        assert!(out.contains(": number") || out.contains(":number"), "{out}");
        assert!(out.contains("interface Shape"), "{out}");
    }

    #[test]
    fn byte_offsets_become_line_and_column() {
        let text = "ab\ncde\n";
        assert_eq!(line_col(text, 0), (1, 1));
        assert_eq!(line_col(text, 2), (1, 3), "end of the first line");
        assert_eq!(line_col(text, 3), (2, 1), "just past the newline");
        assert_eq!(line_col(text, 5), (2, 3));

        // Columns count characters: a byte count would put the error three
        // columns past where the editor draws the cursor.
        assert_eq!(line_col("中文x", 9), (1, 4));
        // A parser may hand back an offset inside a character, or past the end.
        assert_eq!(line_col("中", 1), (1, 1));
        assert_eq!(line_col("ab", 99), (1, 3));
    }

    /// A parse failure has to name the line. Engines report positions in
    /// whatever unit suits them -- ruff hands back a byte range, and printing
    /// that raw ("at byte range 6..7") gave the user nothing to act on.
    #[test]
    fn parse_failures_report_a_position() {
        let cases: &[(&str, &str, &str)] = &[
            ("a.py", "x = 1\ndef f(:\n    pass\n", "line 2, column 7"),
            ("a.yaml", "a: 1\n  b: 2\n", "line 2, column 4"),
            ("a.graphql", "query { a b\n", "line 2, col 1"),
            ("a.html", "<div><span></div>\n", "line 1, column 13"),
        ];
        for (name, broken, want) in cases {
            let err = format_file(Path::new(name), broken)
                .expect_err(&format!("{name}: expected a parse failure"))
                .to_string();
            assert!(err.contains(want), "{name}: {err:?} lacks {want:?}");
        }

        // xmlem discards the reader offset, so XML can only say what is wrong.
        // (The GraphQL row above has a second half: see
        // `a_graphql_error_at_the_first_byte_is_a_message_not_a_crash`.)
        // It must at least be a sentence rather than a Debug variant dump.
        let err = format_file(Path::new("a.xml"), "<root><a></root>\n")
            .expect_err("expected a parse failure")
            .to_string();
        assert!(!err.contains("IllFormed("), "raw Debug leaked: {err:?}");
    }

    /// A GraphQL file whose first character is already wrong is an error
    /// message, not a panic.
    ///
    /// pretty_graphql formats its own message by mapping the byte offset to a
    /// line and then indexing `line_bounds[line - 1]`; at offset 0 that line is
    /// 0 and the subtraction wraps. Three exclamation marks were enough, an
    /// empty file was enough, and one such file in a repository took the whole
    /// `poly fmt` run down with it -- exit 101, nothing formatted, and in the
    /// editor the daemon itself. Every case here reached the panic before the
    /// error stopped being pretty_graphql's to write.
    #[test]
    fn a_graphql_error_at_the_first_byte_is_a_message_not_a_crash() {
        for broken in ["!!!\n", "}\n", "&\n", ""] {
            let err = format_file(Path::new("a.graphql"), broken)
                .expect_err(&format!("{broken:?}: expected a parse failure"))
                .to_string();
            assert!(
                poly_core::diag::parse_position(&err).is_some(),
                "{broken:?}: {err:?} has no position"
            );
        }
    }

    /// PHP takes all three knobs, and like lua has no `honored` arm saying so,
    /// so each is asserted against output only it could produce.
    #[test]
    fn php_honors_all_three_format_options() {
        let php = |text: &str, opts| format("php", Path::new("a.php"), text, opts);

        // Four spaces are mago's default, so both a two-space indent and a tab
        // can only have come from the knob that asked for them.
        let body = "<?php\nif ($x) {\nreturn 1;\n}\n";
        let two = php(
            body,
            FormatOptions {
                line_width: None,
                indent_width: Some(2),
                use_tabs: None,
            },
        )
        .expect("php formats")
        .expect("the indent has to change");
        assert!(two.contains("\n  return 1;"), "{two}");
        let tabbed = php(
            body,
            FormatOptions {
                line_width: None,
                indent_width: None,
                use_tabs: Some(true),
            },
        )
        .expect("php formats")
        .expect("the indent has to change");
        assert!(tabbed.contains("\n\treturn 1;"), "{tabbed}");

        // Inside mago's default 120 columns and outside 40, so the wrapping is
        // the setting and nothing else.
        let call = "<?php\n\n$result = compute($alpha, $beta, $gamma, $delta, $epsilon);\n";
        assert_eq!(
            php(call, FormatOptions::default()).unwrap(),
            None,
            "already formatted at the default width"
        );
        let narrow = php(
            call,
            FormatOptions {
                line_width: Some(40),
                indent_width: None,
                use_tabs: None,
            },
        )
        .expect("php formats")
        .expect("40 columns cannot hold that line");
        assert!(narrow.contains("\n    $alpha,"), "{narrow}");
    }

    /// A PHP file that does not parse is an error that says where.
    ///
    /// mago's own `ParseError` names neither the position nor the file, and a
    /// `poly fmt` line with no position is one no editor can place -- which is
    /// why this goes through the parser a second time. The offsets here are the
    /// ones that were worth checking for GraphQL: the first byte, and an empty
    /// file.
    #[test]
    fn a_php_parse_failure_is_a_message_with_a_position() {
        for broken in [
            "<?php\nclass X {\n",
            "<?php\n$x = ;\n",
            "<?php\nfunction (\n",
        ] {
            let err = format_file(Path::new("a.php"), broken)
                .expect_err(&format!("{broken:?}: expected a parse failure"))
                .to_string();
            assert!(
                poly_core::diag::parse_position(&err).is_some(),
                "{broken:?}: {err:?} has no position"
            );
        }

        // Neither an empty file nor one that is all inline HTML is broken PHP:
        // both are a document with no statements in it, which is what a `.phtml`
        // template is until the first `<?php`. The empty file gains the newline
        // every file here ends with, and the template is returned untouched --
        // both checked against the released binary, because a formatter that
        // reindented somebody's HTML would be the reason not to ship this.
        assert_eq!(
            format_file(Path::new("a.php"), "").unwrap().as_deref(),
            Some("\n")
        );
        let html = "<div>\n  <p>hello</p>\n</div>\n";
        assert_eq!(format_file(Path::new("a.phtml"), html).unwrap(), None);
    }

    #[test]
    fn already_formatted_returns_none() {
        let out = format_file(Path::new("a.json"), "{ \"a\": 1 }\n").unwrap();
        assert_eq!(out, None);
    }

    /// A line that is prose only because of where it sits must not come back
    /// as a block of its own.
    ///
    /// `1. a` / `   10. b` / `       - c` is one paragraph: `10.` cannot
    /// interrupt a paragraph, so the second line continues the first, and the
    /// third line's indentation puts it four columns past the item's content,
    /// where nothing starts a block either. Write that third line at the
    /// content column and `-` *can* interrupt -- the document now has a bullet
    /// list nobody typed, which is a different document, not a different
    /// layout. Formatting is allowed to move the line, join it, or escape it;
    /// it is not allowed to change the answer.
    #[test]
    fn markdown_does_not_invent_a_block_a_line_never_started() {
        // Each is a list item whose paragraph carries a continuation line that
        // would open a block at the content column: the three bullets, an
        // ordered marker that may interrupt, a heading, and a setext
        // underline -- which turns the item's text into a heading, not merely
        // adds a block.
        for input in [
            "1. a\n   10. b\n       - c\n",
            "1. a\n   10. b\n       * c\n",
            "1. a\n   10. b\n       + c\n",
            "1. a\n   10. b\n       1. c\n",
            "- a\n      # c\n",
            "- a\n      ---\n",
        ] {
            let out = format_file(Path::new("a.md"), input)
                .expect("markdown must format")
                .unwrap_or_else(|| input.to_string());
            assert_eq!(
                commonmark_blocks(&out),
                commonmark_blocks(input),
                "poly fmt changed what this document means:\n{input:?}\n=>\n{out:?}"
            );
        }
    }

    /// The blocks and inline runs a CommonMark parser finds, in order. Text is
    /// left out on purpose: the formatter may rewrite a marker or rewrap a
    /// line, and the claim is only about what the document is made of.
    fn commonmark_blocks(text: &str) -> Vec<String> {
        pulldown_cmark::Parser::new(text)
            .filter_map(|event| match event {
                pulldown_cmark::Event::Start(tag) => Some(format!("{tag:?}")),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn markdown_formats_embedded_code_blocks() {
        let input = "# t\n\n```json\n{\"a\":1,   \"b\":2}\n```\n";
        let out = format_file(Path::new("a.md"), input).unwrap().unwrap();
        assert!(out.contains("{ \"a\": 1, \"b\": 2 }"), "got: {out}");
    }

    /// The same three numbers must stop the run when poly.toml wrote them and
    /// pass through quietly when a `.editorconfig` did. Without the second
    /// half, one repo-wide `indent_size` would make poly refuse every XML and
    /// SQL file in the project.
    #[test]
    fn unhonored_options_fail_when_explicit_and_drop_when_inherited() {
        let all = FormatOptions {
            line_width: Some(100),
            indent_width: Some(4),
            use_tabs: Some(true),
        };

        let err = format("xml", Path::new("a.xml"), "<root><a>1</a></root>", all)
            .expect_err("explicit line-width on xml must be rejected");
        assert!(err.to_string().contains("line-width"), "{err}");

        let inherited = drop_unhonored("xml", all);
        assert_eq!(
            inherited,
            FormatOptions {
                line_width: None,
                // xmlem does indent; it is width and tabs it cannot do.
                indent_width: Some(4),
                use_tabs: None,
            }
        );
        let out = format(
            "xml",
            Path::new("a.xml"),
            "<root><a>1</a></root>",
            inherited,
        )
        .expect("the same settings inherited must still format")
        .expect("expected a formatting change");
        assert!(out.contains("\n    <a>"), "got: {out}");

        // sql honors none of the three, so an inherited set empties out and
        // the file formats with the engine's own defaults.
        assert!(drop_unhonored("sql", all).is_default());
    }
}
