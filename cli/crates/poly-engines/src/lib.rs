//! Embedded formatter engines, linked as native Rust crates (M0 "option 0",
//! validated against the WASM-host plan in docs/02-architecture.md §3.3).
//!
//! Returns `Ok(None)` when the input is already formatted.

pub mod lint;
pub mod shell;
mod workflow;

use std::path::Path;
use std::sync::OnceLock;

use anyhow::{anyhow, Result};
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
        external_formatter: None,
    })
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

/// Languages `minify` can act on. JSON only, and deliberately: minifying is
/// only meaningful where whitespace is purely presentational and something
/// downstream reads the result by machine. Markdown and YAML are whitespace-
/// significant, and a "minified" TOML is a file nobody has a use for.
pub fn minifiable_language(lang: &str) -> bool {
    lang == "json"
}

/// Strip everything a machine reading this JSON does not need.
///
/// The inverse of formatting rather than a mode of it, which is why it is its
/// own entry point instead of a `FormatOptions` knob: `poly fmt`'s contract is
/// "make this file match the project's style", and a caller who wanted that
/// would not want one line of 40KB.
///
/// Validation runs through the same engine that formats the file, so a JSON
/// poly refuses to minify is exactly one it refuses to format, reported at the
/// same position in the same words -- rather than a second parser with its own
/// opinions about what counts as JSON.
///
/// What comes out is the same document with whitespace and comments removed;
/// nothing is re-serialized. That is what keeps key order intact -- a
/// round-trip through a map type would quietly sort them, and a diff of a
/// minified file is unreadable enough without also being reordered.
pub fn minify(lang: &str, path: &Path, text: &str) -> Result<Option<String>> {
    if !minifiable_language(lang) {
        return Ok(None);
    }
    format_json(path, text, FormatOptions::default())?;
    let stripped = strip_json(text);
    Ok((stripped != text).then_some(stripped))
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
    Ok((result != text).then_some(result))
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
    let result = pretty_graphql::format_text(text, &options).map_err(|e| anyhow!("graphql {e}"))?;
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

    /// Invalid JSON must fail rather than produce confidently broken output,
    /// and it has to fail the way `poly fmt` already fails on the same file.
    #[test]
    fn minify_rejects_json_the_formatter_rejects() {
        let broken = "{\"a\": }";
        assert!(minify("json", Path::new("a.json"), broken).is_err());
        assert!(format_file(Path::new("a.json"), broken).is_err());
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
        // It must at least be a sentence rather than a Debug variant dump.
        let err = format_file(Path::new("a.xml"), "<root><a></root>\n")
            .expect_err("expected a parse failure")
            .to_string();
        assert!(!err.contains("IllFormed("), "raw Debug leaked: {err:?}");
    }

    #[test]
    fn already_formatted_returns_none() {
        let out = format_file(Path::new("a.json"), "{ \"a\": 1 }\n").unwrap();
        assert_eq!(out, None);
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
