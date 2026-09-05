//! poly's own lint rules for GitHub Actions workflows.
//!
//! The second engine that is not a substitution, and here for the reason the
//! Dockerfile rules are: actionlint is Go, cannot be linked in, and the Rust
//! crates that claim the job (`gh-actions-lint`, `gha-lint`) are hobby scale.
//! So these rules are written here, they are poly's opinions rather than
//! anyone's answers, and their codes are poly's own -- `actions-unknown-runner`,
//! not one of actionlint's. See `RULES`.
//!
//! What is here is the *structural* half of what actionlint reports: the
//! workflow schema, the `needs` graph, `uses:` references, event filters, cron
//! and the numeric ranges. What is deliberately absent is the other half and the
//! one that distinguishes actionlint -- parsing `${{ }}` and type-checking it
//! against the `github` / `env` / `matrix` / `steps` / `needs` / `inputs`
//! contexts -- which is what catches a `steps.<id>.outputs.<name>` whose step id
//! is misspelt, or a property that context does not have. That is a type
//! checker, not a rule, and poly does not have one. Every rule below therefore
//! *stops* at an expression rather than guessing what it evaluates to.
//!
//! actionlint stays wired in alongside this. See the module doc on `lint`.

use poly_core::diag::{Fix, Issue, Severity};
use rowan::ast::AstNode;
use yaml_parser::ast;

use crate::lint::line_col;

/// Every workflow rule poly has, with the prose `lint::rule_doc` serves for it.
///
/// One table rather than a doc comment beside each emitter, for the reason
/// `DOCKER_RULES` is one table: poly's own rules have no documentation site, so
/// an undocumented code reaches a reader as a few words in a terminal with
/// nothing behind them. `every_workflow_rule_is_documented` holds this list and
/// the codes the linter emits to the same set, in both directions.
pub const RULES: &[(&str, &str)] = &[
    (
        "actions-duplicate-key",
        "A YAML mapping keeps the last value for a repeated key and silently \
         discards the earlier ones. In a workflow that means a second `env:` \
         entry, a second job with an id already used, or a step key typed twice \
         quietly deletes the first -- and the file still runs, doing something \
         other than what it reads as. There is nothing in the text saying which \
         of the two the author meant.",
    ),
    (
        "actions-duplicate-step-id",
        "Step ids are how a later step reads an earlier one's outputs, through \
         `steps.<id>.outputs`. Two steps with the same id make that reference \
         ambiguous -- the second step's outputs win, so the expression reads a \
         value produced somewhere other than where the id suggests, and the \
         mistake shows up as a wrong value rather than as an error.",
    ),
    (
        "actions-invalid-action-ref",
        "`uses:` takes one of three shapes: `owner/repo@ref` (optionally with a \
         subdirectory, `owner/repo/path@ref`), a path beginning with `./` for an \
         action in this repository, or `docker://image:tag`. Anything else is \
         rejected when the workflow is loaded, so the run never starts and the \
         error arrives from GitHub rather than from the file.",
    ),
    (
        "actions-invalid-cron",
        "`schedule` takes POSIX cron with five fields -- minute, hour, day of \
         month, month, day of week -- and GitHub supports only `*`, ranges, \
         lists and steps within them. The Quartz extensions (`?`, `L`, `W`, `#`) \
         that many cron references document are not accepted. A schedule GitHub \
         cannot parse does not fail loudly: the workflow simply never fires, and \
         the first symptom is a job nobody noticed was missing.",
    ),
    (
        "actions-invalid-env-name",
        "A variable is read either by the shell inside `run:` or through a \
         `${{ env.NAME }}` expression, and a name starting with a digit or \
         containing a space or punctuation is reachable by neither -- it is set \
         and then unreadable, with no error anywhere to say so. A `-` in the \
         middle is deliberately allowed: the shell cannot expand `$cache-name`, \
         but `${{ env.cache-name }}` reads it and that spelling is in GitHub's \
         own caching documentation.",
    ),
    (
        "actions-invalid-glob",
        "`branches`, `tags` and `paths` take GitHub's filter pattern syntax, \
         where `!` negates and only at the start of a pattern, and `[` opens a \
         character class that has to be closed. A pattern outside that grammar is \
         rejected with the whole workflow. An empty pattern is the same mistake \
         written as a blank list entry.",
    ),
    (
        "actions-invalid-id",
        "A job id or step id has to start with a letter or `_` and may then \
         contain letters, digits, `-` and `_`. This is not style: the id becomes \
         a key in the `needs` and `steps` contexts, so anything else cannot be \
         referenced, and GitHub rejects the workflow rather than accepting an id \
         nothing can name.",
    ),
    (
        "actions-invalid-permission",
        "`permissions` grants the job's `GITHUB_TOKEN` a level per scope, and \
         both halves are a closed set: the scope has to be one GitHub defines and \
         the value has to be `read`, `write` or `none`. A misspelled scope is the \
         dangerous shape -- listing any scope at all drops every other scope to \
         `none`, so a typo does not add a permission, it silently removes the \
         ones that were meant to be there and the job fails somewhere far from \
         this line.",
    ),
    (
        "actions-job-without-steps",
        "A job either runs steps or calls a reusable workflow with `uses:`. One \
         with neither is a job that starts a runner, does nothing and reports \
         success -- which is worse than failing, because anything gating on it \
         goes green.",
    ),
    (
        "actions-max-parallel-out-of-range",
        "`max-parallel` caps how many matrix jobs run at once, so it has to be a \
         positive whole number. `0` is not \"unlimited\", and a non-numeric value \
         is rejected with the workflow.",
    ),
    (
        "actions-missing-required-key",
        "A workflow needs `on:` to say when it runs and `jobs:` to say what it \
         does. Without `on:` nothing ever triggers it, and the file sits in the \
         repository looking like coverage that does not exist. Note that YAML 1.1 \
         reads a bare `on` as the boolean true, which is why quoting it (`\"on\":`) \
         is also accepted here.",
    ),
    (
        "actions-missing-runs-on",
        "A job with steps has to say which runner they run on. GitHub rejects the \
         workflow rather than picking a default, so this is a file that does not \
         run at all -- and the usual cause is `runs-on` indented one level too \
         far, where it reads as a step key instead.",
    ),
    (
        "actions-mutable-action-ref",
        "`uses: some/action@main` re-resolves on every run, so the code executing \
         in your CI -- with your `GITHUB_TOKEN` and your secrets -- is whatever \
         that branch contains at the moment the job starts. Nobody reviews that \
         change, because from this repository's side nothing changed. A tag is \
         better and a commit SHA is the only reference that cannot be moved \
         underneath you.",
    ),
    (
        "actions-needs-cycle",
        "`needs` describes a dependency order, so a cycle has no order to run in. \
         GitHub rejects the workflow, and the cycle is usually not visible from \
         any single job -- each line reads as reasonable and only the closed loop \
         is wrong.",
    ),
    (
        "actions-step-uses-and-run",
        "A step either runs an action or runs a command; `uses:` and `run:` in \
         one step is rejected. The usual cause is an edit that replaced one with \
         the other and left both behind, which reads as though the action still \
         runs.",
    ),
    (
        "actions-step-without-uses-or-run",
        "A step with neither `uses:` nor `run:` does nothing. It is almost always \
         a `run:` that lost its body to a bad indent, or a `name:` left behind \
         after the step it named was deleted -- either way the job is quietly \
         doing less than the file says.",
    ),
    (
        "actions-timeout-out-of-range",
        "`timeout-minutes` has to be a positive whole number of minutes. `0` does \
         not mean \"no limit\", it means the job is cancelled the moment it starts; \
         and GitHub will not run anything longer than 35 days, so a larger number \
         is a unit mistake -- seconds or milliseconds written where minutes were \
         asked for.",
    ),
    (
        "actions-unknown-event",
        "`on:` takes events from a closed set GitHub defines. A misspelled one is \
         not an error at load time in any way you will see: the workflow is \
         accepted, the event never arrives, and the workflow never runs. This is \
         the failure that looks most like everything working.",
    ),
    (
        "actions-unknown-event-filter",
        "Each event accepts its own filters, and they are not interchangeable: \
         `push` has `tags` and `tags-ignore` where `pull_request` has neither, \
         `workflow_dispatch` takes only `inputs`, and `paths` is meaningless on \
         an event that carries no diff. A filter the event does not define is \
         either rejected or silently ignored, and the second is worse -- the \
         workflow runs on far more than the file appears to say.",
    ),
    (
        "actions-unknown-job-in-needs",
        "`needs` names other jobs by their id. A name that matches no job in this \
         workflow is rejected, and the usual cause is a job that was renamed \
         while the jobs depending on it were not -- or `needs` naming the job's \
         `name:` (its human title) rather than its id.",
    ),
    (
        "actions-unknown-job-key",
        "Job keys are a closed set. GitHub rejects a workflow containing one it \
         does not define, so an unknown key here is a file that does not run -- \
         most often a step key (`run`, `uses`, `with`) that lost an indent level \
         and landed beside `steps` instead of inside it.",
    ),
    (
        "actions-unknown-runner",
        "A `runs-on` label nothing answers to means the job never runs: an image \
         GitHub has retired fails to start, and a label that was never real \
         leaves the job pending until the workflow times out. This rule speaks up \
         in three cases only -- a retired image, a label one or two characters \
         from a real one, or a GitHub-hosted OS at a version that never existed. \
         Anything else is assumed to be a self-hosted or third-party runner and \
         left alone, because poly cannot know what somebody named their machines. \
         The list of live images is a snapshot and will age: when GitHub ships a \
         new one, this rule reports it until poly's next release.",
    ),
    (
        "actions-unknown-step-key",
        "Step keys are a closed set and GitHub rejects a workflow containing one \
         it does not define. An action's own inputs go under `with:`, which is \
         where a key like `path` or `node-version` written directly on the step \
         was meant to go.",
    ),
    (
        "actions-unknown-workflow-key",
        "The top level of a workflow accepts eight keys and nothing else. An \
         unknown one is rejected with the whole file, and the usual cause is a \
         job key (`steps`, `runs-on`) written at column zero after an indent \
         slipped, or `job:` for `jobs:`.",
    ),
    (
        "actions-unpinned-action",
        "`uses: actions/checkout` names no version, and GitHub requires one -- \
         there is no implicit default branch. The workflow is rejected at load \
         time, so this is not a supply-chain preference like the mutable-ref rule \
         next to it; it is a file that does not run.",
    ),
    (
        "actions-with-without-uses",
        "`with:` supplies inputs to the action a step runs, so it has no meaning \
         on a step that has `run:` instead, and GitHub rejects the pair. A `run:` \
         step takes its inputs from `env:`.",
    ),
];

// ── the workflow schema, as GitHub defines it ──────────────────────────────

const WORKFLOW_KEYS: &[&str] = &[
    "concurrency",
    "defaults",
    "env",
    "jobs",
    "name",
    "on",
    "permissions",
    "run-name",
];

/// Job keys, both kinds of job in one list.
///
/// `uses`, `with` and `secrets` belong to a reusable-workflow call and the rest
/// to a job that runs steps; splitting the list would let this rule report the
/// *shape* of a job, which is `actions-job-without-steps`' question, not this
/// one's.
const JOB_KEYS: &[&str] = &[
    "concurrency",
    "container",
    "continue-on-error",
    "defaults",
    "env",
    "environment",
    "if",
    "name",
    "needs",
    "outputs",
    "permissions",
    "runs-on",
    "secrets",
    "services",
    "steps",
    "strategy",
    "timeout-minutes",
    "uses",
    "with",
];

const STEP_KEYS: &[&str] = &[
    "continue-on-error",
    "env",
    "id",
    "if",
    "name",
    "run",
    "shell",
    "timeout-minutes",
    "uses",
    "with",
    "working-directory",
];

/// Every event that can appear under `on:`, with the filters it accepts.
///
/// The empty list is meaningful and not a gap: `create`, `fork` and `public`
/// carry no branch, no diff and no activity types, so any filter under them is
/// a misunderstanding rather than a typo.
const EVENTS: &[(&str, &[&str])] = &[
    ("branch_protection_rule", &["types"]),
    ("check_run", &["types"]),
    ("check_suite", &["types"]),
    ("create", &[]),
    ("delete", &[]),
    ("deployment", &[]),
    ("deployment_status", &[]),
    ("discussion", &["types"]),
    ("discussion_comment", &["types"]),
    ("fork", &[]),
    ("gollum", &[]),
    ("issue_comment", &["types"]),
    ("issues", &["types"]),
    ("label", &["types"]),
    ("merge_group", &["types"]),
    ("milestone", &["types"]),
    ("page_build", &[]),
    ("project", &["types"]),
    ("project_card", &["types"]),
    ("project_column", &["types"]),
    ("public", &[]),
    (
        "pull_request",
        &[
            "types",
            "branches",
            "branches-ignore",
            "paths",
            "paths-ignore",
        ],
    ),
    ("pull_request_review", &["types"]),
    ("pull_request_review_comment", &["types"]),
    (
        "pull_request_target",
        &[
            "types",
            "branches",
            "branches-ignore",
            "paths",
            "paths-ignore",
        ],
    ),
    (
        "push",
        &[
            "branches",
            "branches-ignore",
            "tags",
            "tags-ignore",
            "paths",
            "paths-ignore",
        ],
    ),
    ("registry_package", &["types"]),
    ("release", &["types"]),
    ("repository_dispatch", &["types"]),
    ("schedule", &[]),
    ("status", &[]),
    ("watch", &["types"]),
    ("workflow_call", &["inputs", "outputs", "secrets"]),
    ("workflow_dispatch", &["inputs"]),
    (
        "workflow_run",
        &["types", "workflows", "branches", "branches-ignore"],
    ),
];

const PERMISSION_SCOPES: &[&str] = &[
    "actions",
    "artifact-metadata",
    "attestations",
    "checks",
    "contents",
    "deployments",
    "discussions",
    "id-token",
    "issues",
    "models",
    "packages",
    "pages",
    "pull-requests",
    "repository-projects",
    "security-events",
    "statuses",
];

/// The labels GitHub schedules on, lower-cased.
///
/// Only ever consulted through `unknown_runner`, which does not report a label
/// merely for being absent here -- a self-hosted or third-party runner has any
/// name its owner chose, and the corpus is full of them (`blacksmith-*`,
/// `ubicloud-*`). This list is what "close to a real label" is measured against.
const RUNNERS: &[&str] = &[
    "arm",
    "arm64",
    "linux",
    "macos",
    "macos-14",
    "macos-14-large",
    "macos-14-xlarge",
    "macos-15",
    "macos-15-intel",
    "macos-15-large",
    "macos-15-xlarge",
    "macos-26",
    "macos-26-intel",
    "macos-26-large",
    "macos-26-xlarge",
    "macos-latest",
    "macos-latest-large",
    "macos-latest-xlarge",
    "self-hosted",
    "ubuntu-22.04",
    "ubuntu-22.04-arm",
    "ubuntu-24.04",
    "ubuntu-24.04-arm",
    "ubuntu-latest",
    "ubuntu-latest-16-cores",
    "ubuntu-latest-4-cores",
    "ubuntu-latest-8-cores",
    "ubuntu-slim",
    "windows",
    "windows-11-arm",
    "windows-2022",
    "windows-2025",
    "windows-2025-vs2026",
    "windows-latest",
    "windows-latest-8-cores",
    "x64",
    "x86",
];

/// Images GitHub published and has since switched off.
///
/// Separate from "never existed" because the remedy is different and the reader
/// already knows the label was real: a job asking for one of these does not sit
/// pending, it fails to start outright, and what it needs is the next version
/// rather than a spell-check. This is the single most common thing wrong with
/// the workflows measured -- 152 of the 1372 ask for a retired image, over half
/// of them `ubuntu-20.04`.
///
/// Each entry carries what to move to, because "retired" without a destination
/// is a finding the reader has to go and research.
const RETIRED_RUNNERS: &[(&str, &str)] = &[
    ("macos-10.15", "macos-14"),
    ("macos-11", "macos-14"),
    ("macos-12", "macos-14"),
    ("macos-13", "macos-14"),
    ("macos-13-large", "macos-15-large"),
    ("macos-13-xlarge", "macos-15-xlarge"),
    ("ubuntu-16.04", "ubuntu-24.04"),
    ("ubuntu-18.04", "ubuntu-24.04"),
    ("ubuntu-20.04", "ubuntu-24.04"),
    ("windows-2016", "windows-2022"),
    ("windows-2019", "windows-2022"),
];

/// Refs that name a moving target rather than a fixed commit.
const MUTABLE_REFS: &[&str] = &[
    "main", "master", "head", "develop", "dev", "latest", "trunk",
];

// ── the value tree ─────────────────────────────────────────────────────────

/// One YAML node and the byte range it came from.
///
/// A layer above `yaml_parser`'s CST rather than the rules reading the CST
/// directly. The rules below ask "what is under `jobs`", "is this a string",
/// "which key is this" a few hundred times between them, and every one of those
/// questions is four `Option` hops and a cast on the tree as parsed. The cost of
/// the layer is one pass and one allocation per node; what it buys is rules that
/// read like the schema they are enforcing.
#[derive(Debug)]
struct Node {
    at: usize,
    end: usize,
    value: Value,
}

#[derive(Debug)]
enum Value {
    Scalar(String),
    Seq(Vec<Node>),
    /// Key node and value node, in the order they were written -- findings are
    /// reported at the key, and a map has to be walkable for duplicates.
    Map(Vec<(Node, Node)>),
    /// `key:` with nothing under it, an alias, a tagged node, or anything else
    /// poly declines to have an opinion about.
    Opaque,
}

impl Node {
    fn opaque(range: rowan::TextRange) -> Node {
        Node {
            at: range.start().into(),
            end: range.end().into(),
            value: Value::Opaque,
        }
    }

    fn str(&self) -> Option<&str> {
        match &self.value {
            Value::Scalar(s) => Some(s),
            _ => None,
        }
    }

    fn seq(&self) -> &[Node] {
        match &self.value {
            Value::Seq(items) => items,
            _ => &[],
        }
    }

    fn map(&self) -> &[(Node, Node)] {
        match &self.value {
            Value::Map(entries) => entries,
            _ => &[],
        }
    }

    fn is_map(&self) -> bool {
        matches!(self.value, Value::Map(_))
    }

    fn get(&self, key: &str) -> Option<&Node> {
        self.map()
            .iter()
            .find(|(k, _)| k.str() == Some(key))
            .map(|(_, v)| v)
    }

    /// The key node for `key`, which is where a finding about it belongs.
    fn key_of(&self, key: &str) -> Option<&Node> {
        self.map()
            .iter()
            .find(|(k, _)| k.str() == Some(key))
            .map(|(k, _)| k)
    }

    /// A scalar, or the one-element sequence GitHub treats identically -- both
    /// `runs-on: ubuntu-latest` and `branches: [main]` are written either way.
    fn strings(&self) -> Vec<&Node> {
        match &self.value {
            Value::Scalar(_) => vec![self],
            Value::Seq(items) => items.iter().filter(|i| i.str().is_some()).collect(),
            _ => Vec::new(),
        }
    }

    /// Does this node's text contain a `${{ }}`?
    ///
    /// Every rule stops here. poly has no expression evaluator, so a value that
    /// is computed is a value poly does not know -- and the alternative,
    /// reporting on the un-evaluated text, is how a linter teaches people that
    /// half its findings are noise. 246 of the 1372 workflows measured write
    /// `runs-on: ${{ matrix.os }}`.
    fn is_expression(&self) -> bool {
        self.str().is_some_and(|s| s.contains("${{"))
    }
}

/// The first document of `text` as a value tree, or `None` if there is nothing
/// to have an opinion about.
fn parse(text: &str) -> Option<Node> {
    let tree = yaml_parser::parse(text).ok()?;
    let root = ast::Root::cast(tree)?;
    let document = root.documents().next()?;
    if let Some(block) = document.block() {
        return Some(from_block(&block));
    }
    document.flow().as_ref().map(from_flow)
}

fn from_block(block: &ast::Block) -> Node {
    let range = block.syntax().text_range();
    if let Some(map) = block.block_map() {
        let entries = map
            .entries()
            .filter_map(|entry| {
                let key = entry.key().as_ref().map(from_block_map_key)?;
                let value = match entry.value().as_ref().map(from_block_map_value) {
                    Some(value) => value,
                    // `key:` with nothing under it. The key still exists and
                    // still has to answer to the schema rules, so the entry is
                    // kept with an empty value rather than dropped.
                    None => Node::opaque(entry.syntax().text_range()),
                };
                Some((key, value))
            })
            .collect();
        return Node {
            at: range.start().into(),
            end: range.end().into(),
            value: Value::Map(entries),
        };
    }
    if let Some(seq) = block.block_seq() {
        let items = seq
            .entries()
            .map(|entry| match (entry.block(), entry.flow()) {
                (Some(block), _) => from_block(&block),
                (None, Some(flow)) => from_flow(&flow),
                (None, None) => Node::opaque(entry.syntax().text_range()),
            })
            .collect();
        return Node {
            at: range.start().into(),
            end: range.end().into(),
            value: Value::Seq(items),
        };
    }
    if let Some(scalar) = block.block_scalar() {
        let text = scalar
            .text()
            .map(|token| token.text().to_string())
            .unwrap_or_default();
        return Node {
            at: range.start().into(),
            end: range.end().into(),
            value: Value::Scalar(text),
        };
    }
    Node::opaque(range)
}

fn from_block_map_key(key: &ast::BlockMapKey) -> Node {
    match (key.block(), key.flow()) {
        (Some(block), _) => from_block(&block),
        (None, Some(flow)) => from_flow(&flow),
        (None, None) => Node::opaque(key.syntax().text_range()),
    }
}

fn from_block_map_value(value: &ast::BlockMapValue) -> Node {
    match (value.block(), value.flow()) {
        (Some(block), _) => from_block(&block),
        (None, Some(flow)) => from_flow(&flow),
        (None, None) => Node::opaque(value.syntax().text_range()),
    }
}

fn from_flow(flow: &ast::Flow) -> Node {
    // The scalar token's own range rather than the `Flow` node's: a `Flow`
    // carries any anchor and tag written before the value, and a finding
    // underlining `&anchor !!str value` to complain about `value` points at
    // two things the reader did not ask about.
    if let Some(token) = flow.plain_scalar() {
        return scalar(fold_plain(token.text()), token.text_range());
    }
    if let Some(token) = flow.single_quoted_scalar() {
        return scalar(unquote_single(token.text()), token.text_range());
    }
    if let Some(token) = flow.double_qouted_scalar() {
        return scalar(unquote_double(token.text()), token.text_range());
    }
    let range = flow.syntax().text_range();
    if let Some(seq) = flow.flow_seq() {
        let items = seq
            .entries()
            .map(|entries| {
                entries
                    .entries()
                    .map(|entry| match (entry.flow(), entry.flow_pair()) {
                        (Some(flow), _) => from_flow(&flow),
                        (None, Some(pair)) => Node::opaque(pair.syntax().text_range()),
                        (None, None) => Node::opaque(entry.syntax().text_range()),
                    })
                    .collect()
            })
            .unwrap_or_default();
        return Node {
            at: range.start().into(),
            end: range.end().into(),
            value: Value::Seq(items),
        };
    }
    if let Some(map) = flow.flow_map() {
        let entries = map
            .entries()
            .map(|entries| {
                entries
                    .entries()
                    .filter_map(|entry| {
                        let key = entry.key().and_then(|k| k.flow()).as_ref().map(from_flow)?;
                        let value = match entry.value().and_then(|v| v.flow()).as_ref() {
                            Some(flow) => from_flow(flow),
                            None => Node::opaque(entry.syntax().text_range()),
                        };
                        Some((key, value))
                    })
                    .collect()
            })
            .unwrap_or_default();
        return Node {
            at: range.start().into(),
            end: range.end().into(),
            value: Value::Map(entries),
        };
    }
    Node::opaque(range)
}

fn scalar(text: String, range: rowan::TextRange) -> Node {
    Node {
        at: range.start().into(),
        end: range.end().into(),
        value: Value::Scalar(text),
    }
}

/// A plain scalar, with a multi-line one folded the way YAML folds it.
///
/// `if: github.event_name == 'push'` continued over two lines is one value with
/// a newline in the middle of it; every rule below compares such a value against
/// a table of names, and a stray newline makes every one of those comparisons
/// fail silently.
fn fold_plain(text: &str) -> String {
    if !text.contains('\n') {
        return text.trim().to_string();
    }
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn unquote_single(text: &str) -> String {
    let inner = text
        .strip_prefix('\'')
        .and_then(|rest| rest.strip_suffix('\''))
        .unwrap_or(text);
    inner.replace("''", "'")
}

/// A double-quoted scalar with its escapes resolved.
///
/// Only the escapes that appear in a workflow are resolved by name; anything
/// else keeps the character after the backslash, which is right for `\\` and
/// `\"` and harmless for the numeric escapes no workflow key uses.
fn unquote_double(text: &str) -> String {
    let inner = text
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .unwrap_or(text);
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some('0') => out.push('\0'),
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    out
}

// ── findings ───────────────────────────────────────────────────────────────

/// One finding, anchored on the line the offending text starts on.
///
/// The end is clamped to that line, for the reason `docker_issue` clamps it: a
/// `run: |` body or a `jobs:` mapping is one node spanning most of the file, and
/// underlining all of it to complain about one key fills the screen.
fn issue(
    text: &str,
    node: &Node,
    code: &str,
    severity: Severity,
    message: String,
    fix: Option<Fix>,
) -> Issue {
    let at = node.at.min(text.len());
    let (line, col) = line_col(text, at);
    let line_end = text[at..].find('\n').map_or(text.len(), |i| at + i);
    let end = if node.end > at && node.end <= line_end {
        node.end
    } else {
        line_end
    };
    let (end_line, end_col) = line_col(text, end);
    Issue {
        line,
        col,
        end_line,
        end_col,
        severity,
        code: code.to_string(),
        message,
        // poly's own rules, under poly's own name. See `RULES`.
        source: "poly",
        fix,
        // There is no page to link: the prose is in `RULES` and reaches the
        // editor through `lint::rule_doc`.
        url: None,
    }
}

/// Lint one GitHub Actions workflow against poly's own rules.
///
/// A parse failure returns nothing rather than an error: `poly fmt` already
/// refuses a broken YAML file with a line and column, and a second report of the
/// same syntax error under a rule code would be poly saying it twice.
pub fn lint(text: &str) -> Vec<Issue> {
    let Some(root) = parse(text) else {
        return Vec::new();
    };
    if !root.is_map() {
        return Vec::new();
    }
    let mut found = Vec::new();

    duplicate_keys(text, &root, &mut found);
    workflow_keys(text, &root, &mut found);
    triggers(text, &root, &mut found);
    permissions(text, &root, &mut found);
    env_names(text, &root, &mut found);
    jobs(text, &root, &mut found);

    found.sort_by_key(|issue| (issue.line, issue.col, issue.code.clone()));
    found
}

/// Every repeated key in every mapping in the file.
///
/// Whole-tree rather than per-construct because the mistake is the same
/// wherever it happens -- two jobs sharing an id, two `env` entries sharing a
/// name, `runs-on` written twice -- and a rule per construct would be five
/// copies of one check that each have to be remembered separately when a new
/// construct is added.
fn duplicate_keys(text: &str, node: &Node, found: &mut Vec<Issue>) {
    match &node.value {
        Value::Map(entries) => {
            let mut seen: Vec<&str> = Vec::new();
            for (key, value) in entries {
                if let Some(name) = key.str() {
                    if seen.contains(&name) {
                        found.push(issue(
                            text,
                            key,
                            "actions-duplicate-key",
                            Severity::Warning,
                            format!(
                                "`{name}` is set more than once here; YAML keeps only the last"
                            ),
                            None,
                        ));
                    } else {
                        seen.push(name);
                    }
                }
                duplicate_keys(text, value, found);
            }
        }
        Value::Seq(items) => {
            for item in items {
                duplicate_keys(text, item, found);
            }
        }
        _ => {}
    }
}

fn workflow_keys(text: &str, root: &Node, found: &mut Vec<Issue>) {
    for (key, _) in root.map() {
        let Some(name) = key.str() else { continue };
        if WORKFLOW_KEYS.contains(&name) {
            continue;
        }
        found.push(issue(
            text,
            key,
            "actions-unknown-workflow-key",
            Severity::Error,
            format!(
                "`{name}` is not a workflow key{}",
                suggestion(name, WORKFLOW_KEYS)
            ),
            None,
        ));
    }
    for required in ["on", "jobs"] {
        if root.get(required).is_none() {
            found.push(issue(
                text,
                root,
                "actions-missing-required-key",
                Severity::Error,
                format!("a workflow needs a `{required}:` key"),
                None,
            ));
        }
    }
}

// ── on: ────────────────────────────────────────────────────────────────────

fn triggers(text: &str, root: &Node, found: &mut Vec<Issue>) {
    let Some(on) = root.get("on") else { return };
    match &on.value {
        // `on: push` and `on: [push, pull_request]`: names only, no filters.
        Value::Scalar(_) | Value::Seq(_) => {
            for name in on.strings() {
                check_event(text, name, found);
            }
        }
        Value::Map(entries) => {
            for (key, value) in entries {
                let Some(name) = key.str() else { continue };
                if !check_event(text, key, found) {
                    continue;
                }
                if name == "schedule" {
                    schedule(text, value, found);
                    continue;
                }
                event_filters(text, name, value, found);
            }
        }
        Value::Opaque => {}
    }
}

/// Is `node`'s text an event GitHub defines? Reports it if not.
fn check_event(text: &str, node: &Node, found: &mut Vec<Issue>) -> bool {
    let Some(name) = node.str() else {
        return false;
    };
    if EVENTS.iter().any(|(event, _)| *event == name) {
        return true;
    }
    let names: Vec<&str> = EVENTS.iter().map(|(event, _)| *event).collect();
    found.push(issue(
        text,
        node,
        "actions-unknown-event",
        Severity::Error,
        format!(
            "`{name}` is not a GitHub Actions event, so nothing will ever trigger this workflow{}",
            suggestion(name, &names)
        ),
        None,
    ));
    false
}

fn event_filters(text: &str, event: &str, value: &Node, found: &mut Vec<Issue>) {
    let Some((_, allowed)) = EVENTS.iter().find(|(name, _)| *name == event) else {
        return;
    };
    for (key, filter) in value.map() {
        let Some(name) = key.str() else { continue };
        if !allowed.contains(&name) {
            let closing = if allowed.is_empty() {
                format!("`{event}` takes no filters")
            } else {
                format!("`{event}` takes {}", listed(allowed))
            };
            found.push(issue(
                text,
                key,
                "actions-unknown-event-filter",
                Severity::Error,
                format!("`{name}` is not a filter for `{event}`: {closing}"),
                None,
            ));
            continue;
        }
        if matches!(
            name,
            "branches" | "branches-ignore" | "tags" | "tags-ignore" | "paths" | "paths-ignore"
        ) {
            for pattern in filter.strings() {
                globs(text, pattern, found);
            }
        }
    }
}

fn schedule(text: &str, value: &Node, found: &mut Vec<Issue>) {
    for entry in value.seq() {
        let Some(cron) = entry.get("cron") else {
            continue;
        };
        if cron.is_expression() {
            continue;
        }
        let Some(spec) = cron.str() else { continue };
        if let Err(why) = check_cron(spec) {
            found.push(issue(
                text,
                cron,
                "actions-invalid-cron",
                Severity::Error,
                format!("`{spec}` is not a schedule GitHub can parse: {why}"),
                None,
            ));
        }
    }
}

/// GitHub's five-field POSIX cron, and only the operators it supports.
fn check_cron(spec: &str) -> Result<(), String> {
    const MONTHS: &[&str] = &[
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ];
    const DAYS: &[&str] = &["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

    let fields: Vec<&str> = spec.split_whitespace().collect();
    if fields.len() != 5 {
        return Err(format!(
            "it has {} field{}, and cron takes five (minute hour day-of-month month day-of-week)",
            fields.len(),
            if fields.len() == 1 { "" } else { "s" }
        ));
    }
    // Quartz's extensions are what a cron reference found by searching is most
    // likely to document, and GitHub supports none of them.
    if let Some(c) = spec.chars().find(|c| matches!(c, '?' | 'L' | 'W' | '#')) {
        return Err(format!(
            "`{c}` is a Quartz extension, and GitHub accepts only `*`, `,`, `-` and `/`"
        ));
    }
    let limits: [(u32, u32, &[&str]); 5] = [
        (0, 59, &[]),
        (0, 23, &[]),
        (1, 31, &[]),
        (1, 12, MONTHS),
        (0, 6, DAYS),
    ];
    for (field, (low, high, names)) in fields.iter().zip(limits) {
        if !cron_field(field, low, high, names) {
            return Err(format!("`{field}` is not a value in {low}..={high}"));
        }
    }
    Ok(())
}

fn cron_field(field: &str, low: u32, high: u32, names: &[&str]) -> bool {
    if field.is_empty() {
        return false;
    }
    field.split(',').all(|part| {
        let (range, step) = match part.split_once('/') {
            Some((range, step)) => (range, Some(step)),
            None => (part, None),
        };
        if let Some(step) = step {
            if !step.parse::<u32>().is_ok_and(|n| n > 0) {
                return false;
            }
        }
        let value = |text: &str| {
            text.parse::<u32>().is_ok_and(|n| (low..=high).contains(&n))
                || names.contains(&text.to_ascii_lowercase().as_str())
        };
        if range == "*" {
            return true;
        }
        match range.split_once('-') {
            Some((from, to)) => value(from) && value(to),
            None => value(range),
        }
    })
}

/// GitHub's filter pattern grammar, for `branches`, `tags` and `paths`.
fn globs(text: &str, pattern: &Node, found: &mut Vec<Issue>) {
    if pattern.is_expression() {
        return;
    }
    let Some(glob) = pattern.str() else { return };
    let why = if glob.is_empty() {
        Some("it is empty".to_string())
    } else if glob[1..].contains('!') {
        Some("`!` negates a pattern and is only allowed as its first character".to_string())
    } else {
        let mut depth = 0i32;
        let mut unbalanced = false;
        for c in glob.chars() {
            match c {
                '[' => depth += 1,
                ']' => depth -= 1,
                _ => {}
            }
            if depth < 0 {
                unbalanced = true;
                break;
            }
        }
        (unbalanced || depth != 0).then(|| "its `[` character class is not closed".to_string())
    };
    if let Some(why) = why {
        found.push(issue(
            text,
            pattern,
            "actions-invalid-glob",
            Severity::Warning,
            format!("`{glob}` is not a filter pattern: {why}"),
            None,
        ));
    }
}

// ── permissions: and env: ──────────────────────────────────────────────────

/// `permissions` wherever it appears -- the workflow, and every job.
fn permissions(text: &str, root: &Node, found: &mut Vec<Issue>) {
    let mut check = |node: Option<&Node>| {
        let Some(node) = node else { return };
        for (key, value) in node.map() {
            let Some(scope) = key.str() else { continue };
            if !PERMISSION_SCOPES.contains(&scope) {
                found.push(issue(
                    text,
                    key,
                    "actions-invalid-permission",
                    Severity::Error,
                    format!(
                        "`{scope}` is not a permission scope{}",
                        suggestion(scope, PERMISSION_SCOPES)
                    ),
                    None,
                ));
                continue;
            }
            if value.is_expression() {
                continue;
            }
            let Some(level) = value.str() else { continue };
            if !matches!(level, "read" | "write" | "none") {
                found.push(issue(
                    text,
                    value,
                    "actions-invalid-permission",
                    Severity::Error,
                    format!("`{scope}: {level}` is not a permission: use read, write or none"),
                    None,
                ));
            }
        }
    };
    check(root.get("permissions"));
    for (_, job) in root.get("jobs").map(Node::map).unwrap_or(&[]) {
        check(job.get("permissions"));
    }
}

/// `env` wherever it appears -- the workflow, every job, and every step.
fn env_names(text: &str, root: &Node, found: &mut Vec<Issue>) {
    let mut check = |node: Option<&Node>| {
        let Some(node) = node else { return };
        for (key, _) in node.map() {
            let Some(name) = key.str() else { continue };
            if name.contains("${{") || shell_identifier(name) {
                continue;
            }
            found.push(issue(
                text,
                key,
                "actions-invalid-env-name",
                Severity::Warning,
                format!(
                    "`{name}` is not a name a shell can expand: use letters, digits and \
                     underscores, not starting with a digit"
                ),
                None,
            ));
        }
    };
    check(root.get("env"));
    for (_, job) in root.get("jobs").map(Node::map).unwrap_or(&[]) {
        check(job.get("env"));
        for step in job.get("steps").map(Node::seq).unwrap_or(&[]) {
            check(step.get("env"));
        }
    }
}

/// Can anything read a variable called `name`?
///
/// `-` is allowed, deliberately and against first instinct: a shell cannot
/// expand `$cache-name`, but `${{ env.cache-name }}` reads it fine and that
/// spelling is in GitHub's own caching documentation -- it was the only thing
/// this rule reported across 1372 real workflows, three times, every one of them
/// the documented idiom. A rule whose entire output is somebody following the
/// official example is a rule that teaches people to stop reading.
///
/// What is left is a name no reader can reach at all: one starting with a digit,
/// or carrying a space, a dot or punctuation that neither the shell nor the
/// expression grammar accepts.
fn shell_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

// ── jobs: ──────────────────────────────────────────────────────────────────

fn jobs(text: &str, root: &Node, found: &mut Vec<Issue>) {
    let Some(all) = root.get("jobs") else { return };
    let ids: Vec<&str> = all.map().iter().filter_map(|(k, _)| k.str()).collect();

    for (id, job) in all.map() {
        if let Some(name) = id.str() {
            check_id(text, id, name, "job", found);
        }
        job_keys(text, id, job, found);
        needs(text, id, job, &ids, found);
        runs_on(text, id, job, found);
        limits(text, job, found);
        steps(text, job, found);
    }
    cycles(text, all, found);
}

fn check_id(text: &str, node: &Node, name: &str, what: &str, found: &mut Vec<Issue>) {
    let valid = {
        let mut chars = name.chars();
        chars
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    };
    if valid {
        return;
    }
    found.push(issue(
        text,
        node,
        "actions-invalid-id",
        Severity::Error,
        format!(
            "`{name}` cannot be a {what} id: it has to start with a letter or `_` and \
             then use only letters, digits, `-` and `_`"
        ),
        None,
    ));
}

fn job_keys(text: &str, id: &Node, job: &Node, found: &mut Vec<Issue>) {
    for (key, _) in job.map() {
        let Some(name) = key.str() else { continue };
        if JOB_KEYS.contains(&name) {
            continue;
        }
        found.push(issue(
            text,
            key,
            "actions-unknown-job-key",
            Severity::Error,
            format!("`{name}` is not a job key{}", suggestion(name, JOB_KEYS)),
            None,
        ));
    }
    // A job runs steps or calls a reusable workflow, and `uses` is how it says
    // it is doing the second -- so its absence alongside `steps` is what makes
    // this a job with nothing to run.
    if job.get("steps").is_none() && job.get("uses").is_none() && job.is_map() {
        found.push(issue(
            text,
            id,
            "actions-job-without-steps",
            Severity::Error,
            "this job has neither `steps:` nor `uses:`, so it starts a runner and does nothing"
                .to_string(),
            None,
        ));
    }
}

fn needs(text: &str, id: &Node, job: &Node, ids: &[&str], found: &mut Vec<Issue>) {
    let Some(needs) = job.get("needs") else {
        return;
    };
    for name in needs.strings() {
        if name.is_expression() {
            continue;
        }
        let Some(needed) = name.str() else { continue };
        if ids.contains(&needed) {
            continue;
        }
        found.push(issue(
            text,
            name,
            "actions-unknown-job-in-needs",
            Severity::Error,
            format!(
                "`{}` needs `{needed}`, which is not a job in this workflow{}",
                id.str().unwrap_or("this job"),
                suggestion(needed, ids)
            ),
            None,
        ));
    }
}

/// Any job that can reach itself through `needs`.
///
/// Once per cycle rather than once per job on it: a two-job loop reported twice
/// reads as two problems, and the second finding tells the reader nothing the
/// first did not. The job reported is the first one in file order that is on a
/// loop no earlier finding already described, and the message names the whole
/// loop so it is clear which link to cut.
fn cycles(text: &str, all: &Node, found: &mut Vec<Issue>) {
    let graph: Vec<(&Node, &str, Vec<&str>)> = all
        .map()
        .iter()
        .filter_map(|(id, job)| {
            let name = id.str()?;
            let edges = job
                .get("needs")
                .map(|needs| {
                    needs
                        .strings()
                        .into_iter()
                        .filter_map(Node::str)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            Some((id, name, edges))
        })
        .collect();

    let mut reported: Vec<&str> = Vec::new();
    for (node, name, _) in &graph {
        if reported.contains(name) {
            continue;
        }
        let mut path = vec![*name];
        if !closes_loop(&graph, name, name, &mut path) {
            continue;
        }
        reported.extend(path.iter().copied());
        found.push(issue(
            text,
            node,
            "actions-needs-cycle",
            Severity::Error,
            format!("`{name}` needs itself: {}", path.join(" -> ")),
            None,
        ));
    }
}

/// Depth-first from `current`, looking for a way back to `start`.
///
/// `path` is both the answer and the visited set: a job already on it is a
/// branch being explored, so revisiting it would loop forever without finding
/// anything new. That bounds the recursion at the number of jobs.
fn closes_loop<'a>(
    graph: &[(&Node, &'a str, Vec<&'a str>)],
    current: &str,
    start: &str,
    path: &mut Vec<&'a str>,
) -> bool {
    let Some((_, _, edges)) = graph.iter().find(|(_, name, _)| *name == current) else {
        return false;
    };
    for edge in edges {
        if *edge == start {
            path.push(edge);
            return true;
        }
        if path.contains(edge) {
            continue;
        }
        path.push(edge);
        if closes_loop(graph, edge, start, path) {
            return true;
        }
        path.pop();
    }
    false
}

fn runs_on(text: &str, id: &Node, job: &Node, found: &mut Vec<Issue>) {
    let Some(runs_on) = job.get("runs-on") else {
        // A job calling a reusable workflow runs on whatever that workflow says.
        if job.get("steps").is_some() && job.get("uses").is_none() {
            found.push(issue(
                text,
                id,
                "actions-missing-runs-on",
                Severity::Error,
                "this job has steps but no `runs-on:`, so GitHub has no runner to schedule it on"
                    .to_string(),
                None,
            ));
        }
        return;
    };
    // `runs-on: {group: ..., labels: ...}` names a runner group, whose members
    // are configured outside this repository.
    if runs_on.get("group").is_some() {
        return;
    }
    let labels = match runs_on.get("labels") {
        Some(labels) => labels.strings(),
        None => runs_on.strings(),
    };
    // A set containing `self-hosted` is a self-hosted runner's label set, and
    // every other label in it was chosen by whoever runs the machine.
    if labels
        .iter()
        .any(|label| label.str() == Some("self-hosted"))
    {
        return;
    }
    for label in labels {
        if label.is_expression() {
            continue;
        }
        let Some(name) = label.str() else { continue };
        if let Some(why) = unknown_runner(name) {
            found.push(issue(
                text,
                label,
                "actions-unknown-runner",
                Severity::Warning,
                why,
                None,
            ));
        }
    }
}

/// Why `label` cannot be a runner, when poly is confident enough to say so.
///
/// Three ways to be confident, and nothing else reports. The label is one GitHub
/// has retired; or it is one or two characters from a real one, which is a typo
/// rather than a runner somebody provisioned; or it claims a GitHub-hosted OS
/// with a version-shaped suffix that GitHub never offered. Everything else is
/// silently accepted, because the corpus is full of
/// `blacksmith-4vcpu-ubuntu-2404`, `ubicloud-standard-8` and `style-checker`,
/// and poly has no way to know what a third party named its machines. That is
/// the difference measured against actionlint over the same 1372 workflows: it
/// reports every label not on its list, which is right 152 times and wrong 41.
fn unknown_runner(label: &str) -> Option<String> {
    let lower = label.to_ascii_lowercase();
    if RUNNERS.contains(&lower.as_str()) {
        return None;
    }
    // Before the near-miss check, because a retired image is usually one
    // character from a live one -- `ubuntu-20.04` is distance 1 from
    // `ubuntu-22.04` -- and "did you mean" would describe a working label the
    // author chose deliberately three years ago as a spelling mistake.
    if let Some((_, replacement)) = RETIRED_RUNNERS.iter().find(|(name, _)| *name == lower) {
        return Some(format!(
            "GitHub has retired the `{label}` image, so this job fails to start rather \
             than running on something newer; `{replacement}` is the current one"
        ));
    }
    if let Some(near) = RUNNERS
        .iter()
        .filter(|known| distance(&lower, known) <= 2)
        .min_by_key(|known| distance(&lower, known))
    {
        return Some(format!(
            "`{label}` is not a runner label; did you mean `{near}`?"
        ));
    }
    // `ubuntu-25.04` and `macos-16` claim an image GitHub publishes and name a
    // version it does not have. `ubuntu-slim` does not: the suffix is a word, so
    // it is somebody's self-hosted label and none of poly's business.
    let (os, version) = lower.split_once('-')?;
    let versioned = !version.is_empty()
        && version
            .chars()
            .all(|c| c.is_ascii_digit() || c == '.' || c == '-');
    if !versioned || !matches!(os, "ubuntu" | "windows" | "macos") {
        return None;
    }
    Some(format!(
        "GitHub has no `{label}` image, so this job has no runner to schedule on and \
         will queue until the workflow times out"
    ))
}

/// Levenshtein distance, capped where the answer stops mattering.
///
/// Used only for "did you mean": every caller compares against 3 and none cares
/// how far apart two genuinely different strings are.
fn distance(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    if a.len().abs_diff(b.len()) > 3 {
        return usize::MAX / 2;
    }
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut diagonal = row[0];
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cost = usize::from(ca != cb);
            let next = (row[j + 1] + 1).min(row[j] + 1).min(diagonal + cost);
            diagonal = row[j + 1];
            row[j + 1] = next;
        }
    }
    row[b.len()]
}

fn limits(text: &str, job: &Node, found: &mut Vec<Issue>) {
    // 50400 minutes is GitHub's 35-day ceiling on a workflow run; anything
    // larger was written in seconds or milliseconds.
    bounded(
        text,
        job.get("timeout-minutes"),
        "timeout-minutes",
        1,
        50_400,
        "actions-timeout-out-of-range",
        found,
    );
    if let Some(strategy) = job.get("strategy") {
        bounded(
            text,
            strategy.get("max-parallel"),
            "max-parallel",
            1,
            256,
            "actions-max-parallel-out-of-range",
            found,
        );
    }
    for step in job.get("steps").map(Node::seq).unwrap_or(&[]) {
        bounded(
            text,
            step.get("timeout-minutes"),
            "timeout-minutes",
            1,
            50_400,
            "actions-timeout-out-of-range",
            found,
        );
    }
}

fn bounded(
    text: &str,
    node: Option<&Node>,
    key: &str,
    low: u64,
    high: u64,
    code: &str,
    found: &mut Vec<Issue>,
) {
    let Some(node) = node else { return };
    if node.is_expression() {
        return;
    }
    let Some(value) = node.str() else { return };
    if value
        .parse::<u64>()
        .is_ok_and(|n| (low..=high).contains(&n))
    {
        return;
    }
    found.push(issue(
        text,
        node,
        code,
        Severity::Error,
        format!("`{key}: {value}` is not a whole number in {low}..={high}"),
        None,
    ));
}

fn steps(text: &str, job: &Node, found: &mut Vec<Issue>) {
    let Some(all) = job.get("steps") else { return };
    let mut ids: Vec<&str> = Vec::new();
    for step in all.seq() {
        if !step.is_map() {
            continue;
        }
        for (key, _) in step.map() {
            let Some(name) = key.str() else { continue };
            if STEP_KEYS.contains(&name) {
                continue;
            }
            found.push(issue(
                text,
                key,
                "actions-unknown-step-key",
                Severity::Error,
                format!(
                    "`{name}` is not a step key{}; an action's own inputs go under `with:`",
                    suggestion(name, STEP_KEYS)
                ),
                None,
            ));
        }

        if let Some(id) = step.get("id") {
            if let Some(name) = id.str() {
                check_id(text, id, name, "step", found);
                if ids.contains(&name) {
                    found.push(issue(
                        text,
                        id,
                        "actions-duplicate-step-id",
                        Severity::Error,
                        format!(
                            "`{name}` is already a step id in this job, so `steps.{name}.outputs` \
                             reads the later step"
                        ),
                        None,
                    ));
                } else {
                    ids.push(name);
                }
            }
        }

        let (uses, run) = (step.get("uses"), step.get("run"));
        match (uses, run) {
            (Some(_), Some(_)) => found.push(issue(
                text,
                step.key_of("uses").unwrap_or(step),
                "actions-step-uses-and-run",
                Severity::Error,
                "a step runs an action or a command, not both: `uses:` and `run:` are \
                 in the same step"
                    .to_string(),
                None,
            )),
            (None, None) => found.push(issue(
                text,
                step,
                "actions-step-without-uses-or-run",
                Severity::Error,
                "this step has neither `uses:` nor `run:`, so it does nothing".to_string(),
                None,
            )),
            _ => {}
        }
        if run.is_some() && uses.is_none() {
            if let Some(with) = step.key_of("with") {
                found.push(issue(
                    text,
                    with,
                    "actions-with-without-uses",
                    Severity::Error,
                    "`with:` supplies an action's inputs and has no meaning on a `run:` \
                     step; use `env:`"
                        .to_string(),
                    None,
                ));
            }
        }
        if let Some(uses) = uses {
            action_ref(text, uses, found);
        }
    }
    // A reusable workflow call is a `uses:` on the job rather than on a step,
    // and the same three shapes apply to it.
    if let Some(uses) = job.get("uses") {
        action_ref(text, uses, found);
    }
}

fn action_ref(text: &str, node: &Node, found: &mut Vec<Issue>) {
    if node.is_expression() {
        return;
    }
    let Some(reference) = node.str() else { return };
    // A local action or workflow is versioned by the commit it is checked out
    // at, which is this repository's own.
    if reference.starts_with("./") || reference.starts_with(".\\") {
        return;
    }
    // A docker image carries its version in its tag, which is the registry's
    // syntax rather than this one's.
    if reference.starts_with("docker://") {
        return;
    }
    let Some((repository, git_ref)) = reference.rsplit_once('@') else {
        found.push(issue(
            text,
            node,
            "actions-unpinned-action",
            Severity::Error,
            format!("`{reference}` names no version; GitHub requires `@<ref>`"),
            Some(Fix::Described {
                what: format!("Write `{reference}@<tag-or-sha>`"),
                safe: false,
            }),
        ));
        return;
    };
    let mut parts = repository.split('/');
    let well_formed = matches!(parts.next(), Some(owner) if !owner.is_empty())
        && matches!(parts.next(), Some(repo) if !repo.is_empty())
        && !git_ref.is_empty();
    if !well_formed {
        found.push(issue(
            text,
            node,
            "actions-invalid-action-ref",
            Severity::Error,
            format!(
                "`{reference}` is not an action reference: use `owner/repo@ref`, `./path` \
                 or `docker://image`"
            ),
            None,
        ));
        return;
    }
    if MUTABLE_REFS.contains(&git_ref.to_ascii_lowercase().as_str()) {
        found.push(issue(
            text,
            node,
            "actions-mutable-action-ref",
            Severity::Warning,
            format!(
                "`{git_ref}` is a branch, so this runs whatever it contains at the moment \
                 the job starts"
            ),
            Some(Fix::Described {
                what: format!("Pin `{repository}` to a tag or a commit SHA"),
                safe: false,
            }),
        ));
    }
}

// ── shared wording ─────────────────────────────────────────────────────────

/// ", did you mean `x`?" when one candidate is close enough to be a typo.
///
/// Empty far more often than not, deliberately: a suggestion that is merely the
/// nearest of a long list is worse than none, because a reader who follows it
/// once and finds it wrong stops reading the rest of the message too.
fn suggestion(name: &str, candidates: &[&str]) -> String {
    let lower = name.to_ascii_lowercase();
    candidates
        .iter()
        .filter(|candidate| distance(&lower, &candidate.to_ascii_lowercase()) <= 2)
        .min_by_key(|candidate| distance(&lower, &candidate.to_ascii_lowercase()))
        .map(|near| format!(", did you mean `{near}`?"))
        .unwrap_or_default()
}

/// "`a`, `b` or `c`" -- the closing half of a message listing what is accepted.
fn listed(items: &[&str]) -> String {
    let quoted: Vec<String> = items.iter().map(|item| format!("`{item}`")).collect();
    match quoted.split_last() {
        Some((last, [])) => last.clone(),
        Some((last, rest)) => format!("{} or {last}", rest.join(", ")),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The codes linting `text` reports, with the two invariants every one of
    /// poly's own findings has to hold checked on the way past.
    fn codes(text: &str) -> Vec<String> {
        lint(text)
            .into_iter()
            .map(|issue| {
                assert_eq!(issue.source, "poly", "{issue:?}");
                assert_eq!(issue.url, None, "poly's own rules have no page to link");
                issue.code
            })
            .collect()
    }

    /// Does linting `text` report `code`?
    ///
    /// Asked by name rather than by counting, because every fixture below
    /// triggers something else incidentally -- the shortest workflow that can
    /// exercise a step rule already has an `on:`, a job id and a runner.
    fn fires(text: &str, code: &str) -> bool {
        codes(text).iter().any(|found| found == code)
    }

    /// A workflow that is correct, with `{}` marking where a fixture splices in
    /// the part under test. Keeping the surroundings valid is what lets a
    /// non-triggering case mean "this rule stayed quiet" rather than "the file
    /// was too broken to reach the rule".
    fn workflow(steps: &str) -> String {
        format!("on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n{steps}")
    }

    // ── the rule set and its documentation ─────────────────────────────────

    /// A file that triggers each rule, one row per rule.
    ///
    /// A second copy of what the per-rule tests below already cover, and
    /// deliberately: those ask whether a rule fires for the right reason, and
    /// this asks whether the rule set and the *documented* rule set are the same
    /// set. Only a list complete by construction can answer the second question.
    const TRIGGERS: &[(&str, &str)] = &[
        (
            "actions-duplicate-key",
            "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n",
        ),
        (
            "actions-duplicate-step-id",
            "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n        id: same\n      - run: y\n        id: same\n",
        ),
        (
            "actions-invalid-action-ref",
            "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: checkout@v4\n",
        ),
        (
            "actions-invalid-cron",
            "on:\n  schedule:\n    - cron: \"0 0 * *\"\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n",
        ),
        (
            "actions-invalid-env-name",
            "on: push\nenv:\n  2FA: 1\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n",
        ),
        (
            "actions-invalid-glob",
            "on:\n  push:\n    branches: [\"re[lease\"]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n",
        ),
        (
            "actions-invalid-id",
            "on: push\njobs:\n  1build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n",
        ),
        (
            "actions-invalid-permission",
            "on: push\npermissions:\n  content: read\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n",
        ),
        (
            "actions-job-without-steps",
            "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n",
        ),
        (
            "actions-max-parallel-out-of-range",
            "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    strategy:\n      max-parallel: 0\n    steps:\n      - run: x\n",
        ),
        ("actions-missing-required-key", "name: x\non: push\n"),
        (
            "actions-missing-runs-on",
            "on: push\njobs:\n  a:\n    steps:\n      - run: x\n",
        ),
        (
            "actions-mutable-action-ref",
            "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@main\n",
        ),
        (
            "actions-needs-cycle",
            "on: push\njobs:\n  a:\n    needs: [b]\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n  b:\n    needs: [a]\n    runs-on: ubuntu-latest\n    steps:\n      - run: y\n",
        ),
        (
            "actions-step-uses-and-run",
            "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n        run: x\n",
        ),
        (
            "actions-step-without-uses-or-run",
            "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - name: nothing\n",
        ),
        (
            "actions-timeout-out-of-range",
            "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    timeout-minutes: 0\n    steps:\n      - run: x\n",
        ),
        (
            "actions-unknown-event",
            "on: pusg\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n",
        ),
        (
            "actions-unknown-event-filter",
            "on:\n  pull_request:\n    tags: [v1]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n",
        ),
        (
            "actions-unknown-job-in-needs",
            "on: push\njobs:\n  a:\n    needs: [nosuchjob]\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n",
        ),
        (
            "actions-unknown-job-key",
            "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    run: echo hi\n    steps:\n      - run: x\n",
        ),
        (
            "actions-unknown-runner",
            "on: push\njobs:\n  a:\n    runs-on: ubunutu-latest\n    steps:\n      - run: x\n",
        ),
        (
            "actions-unknown-step-key",
            "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/setup-node@v4\n        node-version: 20\n",
        ),
        ("actions-unknown-workflow-key", "on: push\njob:\n  a: 1\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n"),
        (
            "actions-unpinned-action",
            "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout\n",
        ),
        (
            "actions-with-without-uses",
            "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n        with:\n          a: 1\n",
        ),
    ];

    /// Every code poly emits has prose behind it, and every piece of prose
    /// belongs to a code poly emits.
    ///
    /// Both directions, because these rules have no documentation site: a code
    /// with no entry reaches the reader as a sentence in a terminal with nothing
    /// to look up, and an entry with no code is prose about a rule that no
    /// longer exists. `every_docker_rule_is_documented` asks this of the other
    /// engine poly wrote; `every_sqruff_rule_has_documentation` asks it of a
    /// tool poly links.
    #[test]
    fn every_workflow_rule_is_documented() {
        let mut emitted: Vec<&str> = Vec::new();
        for (code, fixture) in TRIGGERS {
            assert!(
                fires(fixture, code),
                "{code} no longer fires for its own fixture:\n{fixture}"
            );
            emitted.push(code);
        }
        emitted.sort_unstable();
        emitted.dedup();
        let mut documented: Vec<&str> = RULES.iter().map(|(code, _)| *code).collect();
        documented.sort_unstable();
        assert_eq!(
            emitted, documented,
            "rules and their documentation disagree"
        );

        for (code, doc) in RULES {
            assert_eq!(crate::lint::rule_doc("poly", code), Some(*doc), "{code}");
            assert!(doc.len() > 80, "{code}: {doc}");
        }
        assert!(crate::lint::rule_doc("poly", "actions-no-such-rule").is_none());
        // Still nobody else's rules: what `rule_doc` documents is that poly
        // repeats what a tool says rather than paraphrasing it.
        assert!(crate::lint::rule_doc("actionlint", "syntax-check").is_none());
    }

    /// A workflow with nothing wrong with it reports nothing.
    ///
    /// The test that makes every other one in this file mean something: 26 rules
    /// firing correctly is worth nothing if the 27th fires on everything. This
    /// is a real workflow shape -- matrix, needs, permissions, concurrency,
    /// reusable call, expressions -- rather than the two-line minimum.
    #[test]
    fn a_correct_workflow_is_quiet() {
        let text = r#"name: CI
run-name: CI for ${{ github.ref }}
on:
  push:
    branches: [main]
    paths-ignore: ["docs/**", "!docs/api/**"]
  pull_request:
    types: [opened, synchronize]
  schedule:
    - cron: "0 3 * * 1-5"
  workflow_dispatch:
    inputs:
      level:
        type: string
permissions:
  contents: read
  id-token: write
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
env:
  CARGO_TERM_COLOR: always
defaults:
  run:
    shell: bash
jobs:
  build:
    name: Build ${{ matrix.target }}
    runs-on: ${{ matrix.os }}
    timeout-minutes: 30
    strategy:
      fail-fast: false
      max-parallel: 4
      matrix:
        include:
          - { target: x86_64-unknown-linux-gnu, os: ubuntu-latest }
          - { target: aarch64-apple-darwin, os: macos-14 }
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/setup
      - uses: docker://alpine:3.19
      - name: Build
        id: build
        working-directory: cli
        continue-on-error: false
        timeout-minutes: 20
        env:
          RUSTFLAGS: "-D warnings"
        run: cargo build --release
      - uses: actions/upload-artifact@v4
        with:
          name: poly-${{ matrix.target }}
  test:
    needs: [build]
    runs-on: [self-hosted, linux, custom-label]
    steps:
      - run: cargo test
  publish:
    needs: build
    uses: ./.github/workflows/release.yml
    secrets: inherit
"#;
        let found = lint(text);
        assert!(found.is_empty(), "{found:#?}");
    }

    // ── schema ─────────────────────────────────────────────────────────────

    /// GitHub rejects a workflow carrying a top-level key it does not define, so
    /// a typo here is a file that never runs at all.
    #[test]
    fn an_unknown_top_level_key_is_a_workflow_that_cannot_load() {
        let text = "on: push\njob:\n  a: 1\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n";
        assert!(fires(text, "actions-unknown-workflow-key"));
        // The suggestion is the substance: `job` for `jobs` is the whole reason
        // a reader needs more than "unknown key".
        let found = lint(text);
        let issue = found
            .iter()
            .find(|i| i.code == "actions-unknown-workflow-key")
            .unwrap();
        assert!(issue.message.contains("did you mean `jobs`"), "{issue:?}");
        // Every key a real workflow uses stays quiet.
        assert!(!fires(
            "name: x\nrun-name: y\non: push\npermissions: {}\nenv: {}\ndefaults: {}\nconcurrency: g\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n",
            "actions-unknown-workflow-key"
        ));
    }

    /// A step key that lost an indent level lands beside `steps` and becomes a
    /// job key, which is the most common way a workflow stops loading.
    #[test]
    fn a_step_key_at_job_level_is_an_unknown_job_key() {
        assert!(fires(
            "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    run: echo hi\n    steps:\n      - run: x\n",
            "actions-unknown-job-key"
        ));
        assert!(!fires(
            "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n",
            "actions-unknown-job-key"
        ));
    }

    /// An action's inputs go under `with:`. Written directly on the step they
    /// are an unknown key, and the action silently receives nothing.
    #[test]
    fn an_action_input_written_on_the_step_is_not_a_step_key() {
        assert!(fires(
            &workflow("      - uses: actions/setup-node@v4\n        node-version: 20\n"),
            "actions-unknown-step-key"
        ));
        assert!(!fires(
            &workflow(
                "      - uses: actions/setup-node@v4\n        with:\n          node-version: 20\n"
            ),
            "actions-unknown-step-key"
        ));
    }

    /// Without `on:` nothing ever triggers the workflow, and the file sits in
    /// the repository looking like coverage that does not exist.
    #[test]
    fn a_workflow_needs_on_and_jobs() {
        assert!(fires("name: x\non: push\n", "actions-missing-required-key"));
        assert!(fires(
            "name: x\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n",
            "actions-missing-required-key"
        ));
        assert!(!fires(
            "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n",
            "actions-missing-required-key"
        ));
        // YAML 1.1 reads a bare `on` as the boolean true, so projects quote it.
        // Reading the CST rather than a deserialized document is what keeps both
        // spellings working; a `serde` round-trip would have turned the key into
        // `true` and made this rule fire on every quoted workflow in the world.
        assert!(!fires(
            "\"on\": push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n",
            "actions-missing-required-key"
        ));
    }

    // ── identity ───────────────────────────────────────────────────────────

    /// A YAML mapping keeps the last value for a repeated key, so the earlier
    /// one is silently deleted and the file still runs.
    #[test]
    fn a_repeated_key_silently_discards_the_first_one() {
        assert!(fires(
            "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    runs-on: macos-14\n    steps:\n      - run: x\n",
            "actions-duplicate-key"
        ));
        // Two jobs with one id, which is the same mistake one level up.
        assert!(fires(
            "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: y\n",
            "actions-duplicate-key"
        ));
        // And in a step's env, which is where it is hardest to see.
        assert!(fires(
            &workflow("      - run: x\n        env:\n          A: 1\n          A: 2\n"),
            "actions-duplicate-key"
        ));
        assert!(!fires(
            &workflow("      - run: x\n"),
            "actions-duplicate-key"
        ));
    }

    /// An id is a key in the `needs` and `steps` contexts, so one outside
    /// GitHub's identifier rules cannot be referenced by anything.
    #[test]
    fn an_id_that_breaks_githubs_identifier_rules_cannot_be_referenced() {
        assert!(fires(
            "on: push\njobs:\n  1build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n",
            "actions-invalid-id"
        ));
        assert!(fires(
            &workflow("      - run: x\n        id: has spaces\n"),
            "actions-invalid-id"
        ));
        // `-` and `_` are allowed after the first character, and `_` may lead.
        assert!(!fires(
            "on: push\njobs:\n  _build-and-test_2:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n",
            "actions-invalid-id"
        ));
    }

    /// Two steps with one id make `steps.<id>.outputs` read the later step, so
    /// the mistake surfaces as a wrong value rather than as an error.
    #[test]
    fn two_steps_sharing_an_id_make_their_outputs_ambiguous() {
        assert!(fires(
            &workflow("      - run: x\n        id: same\n      - run: y\n        id: same\n"),
            "actions-duplicate-step-id"
        ));
        assert!(!fires(
            &workflow("      - run: x\n        id: one\n      - run: y\n        id: two\n"),
            "actions-duplicate-step-id"
        ));
    }

    // ── the needs graph ────────────────────────────────────────────────────

    /// `needs` names jobs by id. The usual mistake is naming the job's `name:`
    /// -- its human title -- or a job that was renamed without its dependents.
    #[test]
    fn needs_naming_a_job_that_does_not_exist_never_runs() {
        let text = "on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n  test:\n    needs: [biuld]\n    runs-on: ubuntu-latest\n    steps:\n      - run: y\n";
        assert!(fires(text, "actions-unknown-job-in-needs"));
        let found = lint(text);
        let issue = found
            .iter()
            .find(|i| i.code == "actions-unknown-job-in-needs")
            .unwrap();
        assert!(issue.message.contains("did you mean `build`"), "{issue:?}");
        // Both spellings of the same thing: a scalar and a one-element list.
        assert!(!fires(
            "on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n  test:\n    needs: build\n    runs-on: ubuntu-latest\n    steps:\n      - run: y\n",
            "actions-unknown-job-in-needs"
        ));
    }

    /// A cycle has no order to run in, and it is invisible from any one job --
    /// every line reads as reasonable and only the closed loop is wrong.
    #[test]
    fn a_cycle_in_needs_has_no_order_to_run_in() {
        let text = "on: push\njobs:\n  a:\n    needs: [c]\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n  b:\n    needs: [a]\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n  c:\n    needs: [b]\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n";
        let found = lint(text);
        let cycles: Vec<&Issue> = found
            .iter()
            .filter(|i| i.code == "actions-needs-cycle")
            .collect();
        // Once for the loop, not once per job on it: three findings for one
        // mistake is three times the noise and no extra information.
        assert_eq!(cycles.len(), 1, "{found:#?}");
        // The whole loop, so the reader can see which link to cut.
        assert!(
            cycles[0].message.contains("a -> c -> b -> a"),
            "{:?}",
            cycles[0]
        );

        // A job needing itself is the one-link case of the same thing.
        assert!(fires(
            "on: push\njobs:\n  a:\n    needs: [a]\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n",
            "actions-needs-cycle"
        ));
        // A diamond is not a cycle, and this is the shape that a naive
        // "already visited" check reports by mistake.
        assert!(!fires(
            "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n  b:\n    needs: [a]\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n  c:\n    needs: [a]\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n  d:\n    needs: [b, c]\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n",
            "actions-needs-cycle"
        ));
    }

    // ── runners ────────────────────────────────────────────────────────────

    /// GitHub rejects a job with steps and no runner rather than picking a
    /// default, and the usual cause is `runs-on` indented one level too far.
    #[test]
    fn a_job_with_steps_needs_a_runner() {
        assert!(fires(
            "on: push\njobs:\n  a:\n    steps:\n      - run: x\n",
            "actions-missing-runs-on"
        ));
        // A job calling a reusable workflow runs on whatever that workflow says.
        assert!(!fires(
            "on: push\njobs:\n  a:\n    uses: ./.github/workflows/other.yml\n",
            "actions-missing-runs-on"
        ));
    }

    /// A label no runner offers means the job queues until the workflow times
    /// out -- GitHub accepts the workflow and then finds nothing to schedule it
    /// on.
    #[test]
    fn a_runner_label_no_machine_answers_to_never_runs() {
        let on = |label: &str| {
            format!("on: push\njobs:\n  a:\n    runs-on: {label}\n    steps:\n      - run: x\n")
        };
        assert!(fires(&on("ubunutu-latest"), "actions-unknown-runner"));
        // A GitHub-hosted OS at a version GitHub never published.
        assert!(fires(&on("ubuntu-25.04"), "actions-unknown-runner"));

        // A retired image, which is the most common thing wrong with the real
        // workflows measured: 152 of 1372 ask for one, over half `ubuntu-20.04`.
        // It says *retired* and names the replacement rather than offering a
        // spelling correction -- the label was real, and `ubuntu-22.04` is one
        // character away, so a "did you mean" would describe a deliberate choice
        // made three years ago as a typo.
        let found = lint(&on("ubuntu-20.04"));
        let issue = found
            .iter()
            .find(|i| i.code == "actions-unknown-runner")
            .unwrap_or_else(|| panic!("{found:#?}"));
        assert!(issue.message.contains("retired"), "{issue:?}");
        assert!(issue.message.contains("ubuntu-24.04"), "{issue:?}");
        assert!(!issue.message.contains("did you mean"), "{issue:?}");
        for retired in ["macos-11", "macos-12", "windows-2019", "ubuntu-18.04"] {
            assert!(fires(&on(retired), "actions-unknown-runner"), "{retired}");
        }
    }

    /// The other half of the runner rule, and the more important half: poly has
    /// no way to know what a third party or a self-hosted fleet named its
    /// machines, so anything that is not plainly a typo is left alone.
    ///
    /// Every label here is one the corpus of 1372 real workflows actually
    /// contains. A rule that reported them would be wrong on its most common
    /// input, which is how a linter teaches people to ignore it.
    #[test]
    fn a_runner_poly_cannot_recognise_is_not_a_runner_poly_reports() {
        for label in [
            "blacksmith-4vcpu-ubuntu-2404",
            "ubicloud-standard-8",
            "ubuntu-slim",
            "ubuntu-latest-8-cores",
            "macos-26",
            "windows-11-arm",
            "${{ matrix.os }}",
            "${{ inputs.use_hosted && 'ubuntu-24.04' || 'blacksmith-4vcpu-ubuntu-2404' }}",
        ] {
            let text = format!(
                "on: push\njobs:\n  a:\n    runs-on: \"{label}\"\n    steps:\n      - run: x\n"
            );
            assert!(
                !fires(&text, "actions-unknown-runner"),
                "reported the real label {label:?}"
            );
        }
        // A self-hosted label set: every label in it was chosen by whoever runs
        // the machine, so none of them is poly's business.
        assert!(!fires(
            "on: push\njobs:\n  a:\n    runs-on: [self-hosted, style-checker]\n    steps:\n      - run: x\n",
            "actions-unknown-runner"
        ));
        // A runner group's members are configured outside this repository.
        assert!(!fires(
            "on: push\njobs:\n  a:\n    runs-on:\n      group: aws-general-8-plus\n    steps:\n      - run: x\n",
            "actions-unknown-runner"
        ));
    }

    /// A job with neither steps nor a reusable-workflow call starts a runner,
    /// does nothing and reports success -- so anything gating on it goes green.
    #[test]
    fn a_job_that_runs_nothing_still_reports_success() {
        assert!(fires(
            "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n",
            "actions-job-without-steps"
        ));
        assert!(!fires(
            "on: push\njobs:\n  a:\n    uses: ./.github/workflows/other.yml\n",
            "actions-job-without-steps"
        ));
    }

    // ── steps ──────────────────────────────────────────────────────────────

    /// A step runs an action or a command. Both is rejected, and the usual cause
    /// is an edit that replaced one with the other and left both behind.
    #[test]
    fn a_step_cannot_both_use_an_action_and_run_a_command() {
        assert!(fires(
            &workflow("      - uses: actions/checkout@v4\n        run: echo hi\n"),
            "actions-step-uses-and-run"
        ));
        assert!(!fires(
            &workflow("      - uses: actions/checkout@v4\n      - run: echo hi\n"),
            "actions-step-uses-and-run"
        ));
    }

    /// A step with neither is almost always a `run:` that lost its body to a bad
    /// indent, so the job quietly does less than the file says.
    #[test]
    fn a_step_with_no_action_and_no_command_does_nothing() {
        assert!(fires(
            &workflow("      - name: build the thing\n"),
            "actions-step-without-uses-or-run"
        ));
        assert!(!fires(
            &workflow("      - name: build the thing\n        run: make\n"),
            "actions-step-without-uses-or-run"
        ));
    }

    /// `with:` supplies an action's inputs, so on a `run:` step it is rejected.
    /// A `run:` step takes its inputs from `env:`.
    #[test]
    fn with_has_no_meaning_on_a_run_step() {
        assert!(fires(
            &workflow("      - run: echo $A\n        with:\n          a: 1\n"),
            "actions-with-without-uses"
        ));
        assert!(!fires(
            &workflow("      - run: echo $A\n        env:\n          A: 1\n"),
            "actions-with-without-uses"
        ));
        assert!(!fires(
            &workflow(
                "      - uses: actions/setup-node@v4\n        with:\n          node-version: 20\n"
            ),
            "actions-with-without-uses"
        ));
    }

    // ── uses: ──────────────────────────────────────────────────────────────

    /// GitHub requires a ref on `uses:` -- there is no implicit default branch
    /// -- so this is a workflow that does not load, not a style preference.
    #[test]
    fn an_action_without_a_ref_is_a_workflow_that_does_not_load() {
        assert!(fires(
            &workflow("      - uses: actions/checkout\n"),
            "actions-unpinned-action"
        ));
        assert!(!fires(
            &workflow("      - uses: actions/checkout@v4\n"),
            "actions-unpinned-action"
        ));
        // The two shapes that carry their version somewhere other than a ref: a
        // local action is versioned by this repository's own commit, and a
        // docker image by its tag.
        assert!(!fires(
            &workflow("      - uses: ./.github/actions/setup\n"),
            "actions-unpinned-action"
        ));
        assert!(!fires(
            &workflow("      - uses: docker://alpine:3.19\n"),
            "actions-unpinned-action"
        ));
    }

    /// A branch re-resolves on every run, so the code executing with this
    /// repository's `GITHUB_TOKEN` is whatever that branch contains at the
    /// moment the job starts, and nobody reviews the change.
    #[test]
    fn a_branch_ref_runs_unreviewed_code_with_your_token() {
        for git_ref in ["main", "master", "HEAD", "develop"] {
            assert!(
                fires(
                    &workflow(&format!("      - uses: some/action@{git_ref}\n")),
                    "actions-mutable-action-ref"
                ),
                "{git_ref}"
            );
        }
        // A tag moves too, in principle, but tagging is the practice GitHub
        // documents and 289 of the corpus's `uses:` lines are `@v4`. A rule
        // that reported them would be silenced on the day it was turned on,
        // and a SHA is what it would have been asking for.
        assert!(!fires(
            &workflow("      - uses: actions/checkout@v4\n"),
            "actions-mutable-action-ref"
        ));
        assert!(!fires(
            &workflow("      - uses: actions/checkout@8f4b7f84864484a7bf31766abe9204da3cbe65b3\n"),
            "actions-mutable-action-ref"
        ));
    }

    /// `uses:` takes `owner/repo@ref`, `./path` or `docker://image`. Anything
    /// else is rejected when the workflow loads.
    #[test]
    fn a_uses_outside_the_three_shapes_is_rejected_at_load_time() {
        assert!(fires(
            &workflow("      - uses: checkout@v4\n"),
            "actions-invalid-action-ref"
        ));
        assert!(fires(
            &workflow("      - uses: actions/checkout@\n"),
            "actions-invalid-action-ref"
        ));
        // A subdirectory inside the repository is the fourth spelling of the
        // first shape, not a fourth shape.
        assert!(!fires(
            &workflow("      - uses: github/codeql-action/init@v3\n"),
            "actions-invalid-action-ref"
        ));
    }

    // ── on: ────────────────────────────────────────────────────────────────

    /// A misspelled event is the failure that looks most like everything
    /// working: the workflow is accepted, the event never arrives, and nothing
    /// ever runs.
    #[test]
    fn a_misspelled_event_means_the_workflow_never_runs() {
        assert!(fires(
            "on: pusg\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n",
            "actions-unknown-event"
        ));
        // All three spellings of `on:` reach the same check.
        assert!(fires(
            "on: [push, pull_reqest]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n",
            "actions-unknown-event"
        ));
        assert!(fires(
            "on:\n  workflow_dispatc:\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n",
            "actions-unknown-event"
        ));
        assert!(!fires(
            "on: [push, pull_request, workflow_dispatch, schedule]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n",
            "actions-unknown-event"
        ));
    }

    /// Filters are per event and not interchangeable. `pull_request` has no
    /// `tags`, and a filter the event ignores means the workflow runs on far
    /// more than the file appears to say.
    #[test]
    fn a_filter_the_event_does_not_define_is_ignored_or_rejected() {
        assert!(fires(
            "on:\n  pull_request:\n    tags: [v1]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n",
            "actions-unknown-event-filter"
        ));
        // `push` does have tags, so the same key one event over is correct.
        assert!(!fires(
            "on:\n  push:\n    tags: [\"v*\"]\n    branches-ignore: [wip]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n",
            "actions-unknown-event-filter"
        ));
        // An event that carries no branch and no diff takes no filters at all.
        assert!(fires(
            "on:\n  fork:\n    branches: [main]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n",
            "actions-unknown-event-filter"
        ));
    }

    /// A schedule GitHub cannot parse does not fail loudly -- the workflow
    /// simply never fires, and the first symptom is a job nobody noticed was
    /// missing.
    #[test]
    fn a_schedule_github_cannot_parse_never_fires() {
        let bad = |cron: &str| {
            format!("on:\n  schedule:\n    - cron: \"{cron}\"\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n")
        };
        // Four fields, not five.
        assert!(fires(&bad("0 0 * *"), "actions-invalid-cron"));
        // Out of range: there is no 25th hour.
        assert!(fires(&bad("0 25 * * *"), "actions-invalid-cron"));
        // Quartz's extensions, which every cron reference documents and GitHub
        // supports none of.
        assert!(fires(&bad("0 0 ? * MON"), "actions-invalid-cron"));
        assert!(fires(&bad("0 0 L * *"), "actions-invalid-cron"));

        for good in [
            "0 3 * * 1-5",
            "*/15 * * * *",
            "0 0,12 1 */2 *",
            "0 0 * JAN SUN",
        ] {
            assert!(!fires(&bad(good), "actions-invalid-cron"), "{good}");
        }
        // An expression is a value poly does not know, so it is not judged.
        assert!(!fires(&bad("${{ vars.CRON }}"), "actions-invalid-cron"));
    }

    /// `!` negates and only at the start of a pattern, and `[` opens a class
    /// that has to be closed. Outside that grammar the workflow is rejected.
    #[test]
    fn a_filter_pattern_outside_githubs_grammar_is_rejected() {
        let with = |pattern: &str| {
            format!("on:\n  push:\n    branches: [\"{pattern}\"]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n")
        };
        assert!(fires(&with("re[lease"), "actions-invalid-glob"));
        assert!(fires(&with("v1!2"), "actions-invalid-glob"));
        for good in ["main", "!wip", "releases/**", "v[0-9]*", "feature/*"] {
            assert!(!fires(&with(good), "actions-invalid-glob"), "{good}");
        }
    }

    // ── permissions, env, numbers ──────────────────────────────────────────

    /// Listing any scope drops every other scope to `none`, so a misspelled
    /// scope does not add a permission -- it silently removes the ones that were
    /// meant to be there.
    #[test]
    fn a_misspelled_permission_scope_silently_removes_permissions() {
        assert!(fires(
            "on: push\npermissions:\n  content: read\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n",
            "actions-invalid-permission"
        ));
        // The value half of the same closed set.
        assert!(fires(
            "on: push\npermissions:\n  contents: readonly\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n",
            "actions-invalid-permission"
        ));
        // And on a job, which is where most of them are written.
        assert!(fires(
            "on: push\njobs:\n  a:\n    permissions:\n      pull-request: write\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n",
            "actions-invalid-permission"
        ));
        assert!(!fires(
            "on: push\npermissions:\n  contents: read\n  id-token: write\n  packages: none\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n",
            "actions-invalid-permission"
        ));
    }

    /// A name neither the shell nor a `${{ env.* }}` expression can reach is set
    /// and then unreadable, with nothing anywhere saying so.
    #[test]
    fn an_env_name_nothing_can_read_is_set_and_lost() {
        let at_workflow = |name: &str| {
            format!("on: push\nenv:\n  {name}: 1\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n")
        };
        assert!(fires(&at_workflow("2FA"), "actions-invalid-env-name"));
        assert!(fires(
            &at_workflow("\"my var\""),
            "actions-invalid-env-name"
        ));
        assert!(fires(&at_workflow("\"a.b\""), "actions-invalid-env-name"));

        // A `-` in the middle stays quiet, and this is the case that matters:
        // `${{ env.cache-name }}` is GitHub's own caching example, and it was
        // the only thing this rule reported over 1372 real workflows -- three
        // times, every one of them somebody following the documentation.
        assert!(!fires(
            &at_workflow("cache-name"),
            "actions-invalid-env-name"
        ));
        assert!(!fires(
            "on: push\nenv:\n  MY_VAR: 1\n  _private: 2\n  PATH2: 3\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n",
            "actions-invalid-env-name"
        ));
        // Still checked on a step, which is where most of them are written.
        assert!(fires(
            &workflow("      - run: x\n        env:\n          9lives: 1\n"),
            "actions-invalid-env-name"
        ));
    }

    /// `0` does not mean "no limit", it means the job is cancelled the moment it
    /// starts; and past GitHub's 35-day ceiling the number was written in some
    /// other unit.
    #[test]
    fn a_timeout_outside_the_range_is_a_unit_mistake_or_an_instant_cancel() {
        assert!(fires(
            "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    timeout-minutes: 0\n    steps:\n      - run: x\n",
            "actions-timeout-out-of-range"
        ));
        // Seconds written where minutes were asked for.
        assert!(fires(
            "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    timeout-minutes: 1800000\n    steps:\n      - run: x\n",
            "actions-timeout-out-of-range"
        ));
        assert!(fires(
            &workflow("      - run: x\n        timeout-minutes: -5\n"),
            "actions-timeout-out-of-range"
        ));
        assert!(!fires(
            "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    timeout-minutes: 30\n    steps:\n      - run: x\n        timeout-minutes: 5\n",
            "actions-timeout-out-of-range"
        ));
        // A value poly cannot evaluate is not a value poly judges.
        assert!(!fires(
            "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    timeout-minutes: ${{ inputs.timeout }}\n    steps:\n      - run: x\n",
            "actions-timeout-out-of-range"
        ));
    }

    /// `max-parallel: 0` is not "unlimited"; it is a number GitHub rejects.
    #[test]
    fn max_parallel_has_to_be_a_positive_count() {
        assert!(fires(
            "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    strategy:\n      max-parallel: 0\n    steps:\n      - run: x\n",
            "actions-max-parallel-out-of-range"
        ));
        assert!(!fires(
            "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    strategy:\n      max-parallel: 4\n    steps:\n      - run: x\n",
            "actions-max-parallel-out-of-range"
        ));
    }

    // ── positions and the parser ───────────────────────────────────────────

    /// A finding lands on the key it is about, not on the construct containing
    /// it.
    ///
    /// Anchoring is the substance of a workflow finding rather than a detail of
    /// it: `jobs:` is one node spanning most of the file, so a rule that
    /// reported its span would underline the whole screen to complain about one
    /// misspelled label. This is also the reason the parser had to be one with
    /// spans.
    #[test]
    fn a_finding_marks_the_key_it_is_about_not_the_whole_job() {
        let text =
            "on: push\njobs:\n  build:\n    runs-on: ubunutu-latest\n    steps:\n      - run: x\n";
        let found = lint(text);
        let issue = found
            .iter()
            .find(|i| i.code == "actions-unknown-runner")
            .unwrap_or_else(|| panic!("{found:#?}"));
        // Line 3 (0-based), at the label -- not line 1 where `jobs:` starts and
        // not column 4 where `runs-on` does.
        assert_eq!((issue.line, issue.col), (3, 13), "{issue:?}");
        assert_eq!(issue.end_line, issue.line, "one line, not the whole job");
        assert_eq!(issue.end_col, 27, "{issue:?}");
    }

    /// A `run: |` body is one node spanning many lines, and a finding on the
    /// step must not underline all of it.
    #[test]
    fn a_finding_on_a_step_with_a_block_body_stays_on_one_line() {
        let text = "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - name: long\n        run: |\n          one\n          two\n          three\n        with:\n          a: 1\n";
        let found = lint(text);
        let issue = found
            .iter()
            .find(|i| i.code == "actions-with-without-uses")
            .unwrap_or_else(|| panic!("{found:#?}"));
        assert_eq!(issue.line, 10, "{issue:?}");
        assert_eq!(issue.end_line, issue.line, "{issue:?}");
    }

    /// Broken YAML reports nothing rather than an error.
    ///
    /// `poly fmt` already refuses the file with a line and a column, and a
    /// second report of the same syntax error under a rule code would be poly
    /// saying it twice. It must also not panic, which is the real risk: the
    /// editor lints on every keystroke, so a half-typed workflow is the state
    /// this code spends most of its life in.
    #[test]
    fn a_file_that_does_not_parse_is_quiet_rather_than_loud() {
        for broken in [
            "on: push\njobs:\n  a:\n   - [unclosed\n",
            "\t\ttabs: everywhere\n",
            "",
            "\n\n\n",
            "just a string",
            "- a\n- b\n",
            "%YAML 1.2\n---\non: push\n",
        ] {
            let found = lint(broken);
            assert!(
                found.iter().all(|i| i.source == "poly"),
                "{broken:?} -> {found:#?}"
            );
        }
    }

    /// Quoted, folded and block scalars all have to reach the rules as the
    /// string they represent, or every table lookup below silently misses.
    #[test]
    fn scalars_reach_the_rules_with_their_quoting_resolved() {
        // Double-quoted, single-quoted and plain, all naming the same event.
        for spelling in ["\"pusg\"", "'pusg'", "pusg"] {
            assert!(
                fires(
                    &format!("on: {spelling}\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n"),
                    "actions-unknown-event"
                ),
                "{spelling}"
            );
        }
        // A quoted correct one stays quiet, so the test above is not passing
        // because quoting broke the lookup outright.
        assert!(!fires(
            "on: \"push\"\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n",
            "actions-unknown-event"
        ));
    }

    /// Every rule stops at a `${{ }}`.
    ///
    /// poly has no expression evaluator, so a computed value is a value poly
    /// does not know -- and reporting on the un-evaluated text is how a linter
    /// teaches people that half its findings are noise. 246 of the corpus's
    /// 1372 workflows write `runs-on: ${{ matrix.os }}` alone.
    #[test]
    fn a_computed_value_is_one_poly_declines_to_judge() {
        let text = "on: push\njobs:\n  a:\n    runs-on: ${{ matrix.os }}\n    timeout-minutes: ${{ inputs.t }}\n    needs: ${{ fromJSON(inputs.needs) }}\n    steps:\n      - uses: ${{ inputs.action }}\n        with:\n          a: 1\n      - run: x\n        env:\n          ${{ inputs.name }}: 1\n";
        let found = lint(text);
        assert!(found.is_empty(), "{found:#?}");
    }

    /// The flow spellings of a mapping and a sequence are the same structures
    /// written on one line, and the rules have to see through both.
    #[test]
    fn flow_style_is_read_as_the_same_structure_as_block_style() {
        // `tags` is a `push` filter and not a `pull_request` one, so the same
        // two lines differ only in the event -- which is what proves the flow
        // mapping was read as a mapping rather than skipped.
        assert!(fires(
            "on: {pull_request: {tags: [v1]}}\njobs: {a: {runs-on: ubuntu-latest, steps: [{run: x}]}}\n",
            "actions-unknown-event-filter"
        ));
        assert!(!fires(
            "on: {push: {tags: [v1]}}\njobs: {a: {runs-on: ubuntu-latest, steps: [{run: x}]}}\n",
            "actions-unknown-event-filter"
        ));
        // And the flow job/step structures reach the step rules at all.
        assert!(fires(
            "on: push\njobs: {a: {runs-on: ubuntu-latest, steps: [{name: nothing}]}}\n",
            "actions-step-without-uses-or-run"
        ));
    }

    // ── the seam ───────────────────────────────────────────────────────────

    /// These rules reach a file because of where it is, not what it contains.
    ///
    /// A workflow is YAML, so without the path test `poly check` on a
    /// Kubernetes repository would report `unknown workflow key` on every
    /// manifest in it. `lint::supported` and `lint::lint` both ask
    /// `poly_core::is_workflow_file`, and they have to agree: the first decides
    /// whether the file is read at all and the second what is done with it.
    #[test]
    fn only_a_file_github_would_run_as_a_workflow_is_linted() {
        use std::path::Path;
        let text = "on: push\njob: nope\n";
        let workflow = Path::new(".github/workflows/ci.yml");
        assert!(crate::lint::supported("yaml", workflow));
        assert!(!crate::lint::lint("yaml", workflow, text)
            .unwrap()
            .is_empty());

        // A Helm chart, a compose file, and a fragment kept one directory below
        // the one GitHub actually reads.
        for other in [
            "k8s/deployment.yaml",
            "docker-compose.yml",
            ".github/workflows/templates/base.yml",
            ".github/actions/setup/action.yml",
        ] {
            let path = Path::new(other);
            assert!(!crate::lint::supported("yaml", path), "{other}");
            assert!(
                crate::lint::lint("yaml", path, text).unwrap().is_empty(),
                "{other}"
            );
        }
    }
}
