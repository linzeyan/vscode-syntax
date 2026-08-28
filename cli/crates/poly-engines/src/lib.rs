//! Embedded formatter engines, linked as native Rust crates (M0 "option 0",
//! validated against the WASM-host plan in docs/02-architecture.md §3.3).
//!
//! Returns `Ok(None)` when the input is already formatted.

pub mod lint;

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
            | "sql"
            | "xml"
            | "html"
            | "vue"
            | "svelte"
            | "astro"
            | "jinja"
            | "graphql"
            | "dockerfile"
    )
}

/// Which of `[format.<lang>]`'s three knobs this engine can actually honor.
/// Silently dropping one would mean poly.toml and the output disagree, so
/// `format` rejects the file instead and names the key.
fn unsupported_option(lang: &str, opts: &FormatOptions) -> Option<&'static str> {
    let (width, indent, tabs) = match lang {
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
    };
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
        "sql" => format_sql(text),
        "xml" => format_xml(text, opts),
        "html" | "vue" | "svelte" | "astro" | "jinja" => format_markup(text, lang, opts),
        "graphql" => format_graphql(text, opts),
        "dockerfile" => format_dockerfile(path, text, opts),
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

fn format_python(path: &Path, text: &str, opts: FormatOptions) -> Result<Option<String>> {
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
    let printed = ruff_python_formatter::format_module_source(text, options)
        .map_err(|e| python_error(text, &e))?;
    let result = printed.into_code();
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
            ("Dockerfile", "FROM  alpine:3\nrun echo hi\n"),
        ];
        for (name, input) in cases {
            let out = format_file(Path::new(name), input).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert!(out.is_some(), "{name}: expected a formatting change");
        }
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
}
