//! Running someone else's language server.
//!
//! poly implements no completion, no go-to-definition and no rename. For the
//! languages that have a real language server the answer to "how should poly
//! do this" is R7's: it should not, it should run gopls. This module is the
//! plumbing that lets one editor connection reach one of them.
//!
//! What poly adds over installing those extensions directly is that the
//! routing, the resolution and the lifecycle sit next to the formatting and
//! lint that already work this way — one extension, one binary, one place
//! where "which tool answers for this language" is decided.
//!
//! The proxy is deliberately dumb: it does not interpret a single request. A
//! reply that poly could improve on is a reply poly would have to keep
//! improving, and the whole point is that the server's own maintainers are
//! better at that than poly ever will be.

use std::io::BufReader;
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use lsp_server::{Message, Notification, Request, RequestId, Response};

/// Ids poly invents for its own traffic, so they can be told apart from the
/// editor's. The editor's client numbers its requests; nothing it sends will
/// collide with a string in this shape.
const POLY_ID: &str = "poly:";

/// How long a server gets to answer `initialize` before poly gives up on it.
///
/// Bounded because this wait happens on the thread serving the editor: a
/// server that never answers would otherwise take formatting and lint down
/// with it, which is a far worse failure than not having completion.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);

/// The requests poly hands over, paired with the capability field a server
/// uses to declare it.
///
/// Everything here is a plain request/response about one position in one
/// document — no state poly would have to keep in step. Rename and code
/// actions are absent for that reason: they come back as workspace edits that
/// interact with poly's own formatting, and that interaction has to be
/// designed rather than discovered.
pub const PROXIED: &[(&str, &str)] = &[
    ("textDocument/hover", "hoverProvider"),
    ("textDocument/definition", "definitionProvider"),
    ("textDocument/typeDefinition", "typeDefinitionProvider"),
    ("textDocument/implementation", "implementationProvider"),
    ("textDocument/references", "referencesProvider"),
    ("textDocument/documentSymbol", "documentSymbolProvider"),
    ("textDocument/completion", "completionProvider"),
];

/// Document lifecycle notifications a downstream server needs to see. Without
/// these it is reading files from disk while the editor holds unsaved changes,
/// and every answer is subtly stale.
pub const SYNCED: &[&str] = &[
    "textDocument/didOpen",
    "textDocument/didChange",
    "textDocument/didSave",
    "textDocument/didClose",
];

pub struct Downstream {
    /// Binary name, for logs.
    pub name: String,
    /// The language poly routes to this server.
    pub language: String,
    /// `capabilities` from the server's `initialize` result, verbatim. poly
    /// re-registers a subset of these with the editor rather than asserting
    /// what the server can do.
    pub capabilities: serde_json::Value,
    child: Child,
    stdin: ChildStdin,
}

impl Downstream {
    /// Start `command`, complete the LSP handshake, and begin pumping its
    /// output to `forward`.
    ///
    /// `init_params` is the editor's own `InitializeParams`, passed through
    /// unchanged: the server has to see the same rootUri, workspaceFolders and
    /// client capabilities the editor offered, or it resolves imports against
    /// the wrong tree. poly is a pipe here, not a negotiator.
    pub fn start(
        name: &str,
        language: &str,
        command: &Path,
        init_params: &serde_json::Value,
        forward: Box<dyn Fn(Message) + Send>,
    ) -> Result<Downstream> {
        let mut child = Command::new(command)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .with_context(|| format!("starting {name} ({})", command.display()))?;
        let mut stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");

        // A server's stderr is where it says it cannot find the toolchain or
        // ran out of memory. Dropping it would turn every such failure into
        // "completion just does not work", which is the shape of bug this
        // project keeps finding and refusing to ship.
        if let Some(stderr) = child.stderr.take() {
            let name = name.to_string();
            std::thread::spawn(move || {
                use std::io::BufRead;
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    eprintln!("[{name}] {line}");
                }
            });
        }

        // One reader thread does the framing for both phases. The handshake
        // drains the channel with a deadline; everything after it is pumped
        // straight through.
        let (tx, rx) = mpsc::channel::<Message>();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            while let Ok(Some(message)) = Message::read(&mut reader) {
                if tx.send(message).is_err() {
                    break; // poly stopped listening
                }
            }
        });

        let handshake = RequestId::from(format!("{POLY_ID}initialize"));
        Message::Request(Request {
            id: handshake.clone(),
            method: "initialize".to_string(),
            params: init_params.clone(),
        })
        .write(&mut stdin)
        .with_context(|| format!("sending initialize to {name}"))?;

        let capabilities = loop {
            let message = rx.recv_timeout(HANDSHAKE_TIMEOUT).map_err(|_| {
                anyhow!(
                    "{name} did not answer initialize within {}s",
                    HANDSHAKE_TIMEOUT.as_secs()
                )
            })?;
            match message {
                Message::Response(response) if response.id == handshake => {
                    if let Some(error) = response.error {
                        return Err(anyhow!("{name} refused initialize: {}", error.message));
                    }
                    break response
                        .result
                        .and_then(|mut r| r.get_mut("capabilities").map(serde_json::Value::take))
                        .unwrap_or(serde_json::Value::Null);
                }
                // A server may log or ask the editor something before it
                // answers; those are the editor's business either way.
                other => forward(other),
            }
        };

        Message::Notification(Notification {
            method: "initialized".to_string(),
            params: serde_json::json!({}),
        })
        .write(&mut stdin)
        .with_context(|| format!("sending initialized to {name}"))?;

        let language = language.to_string();
        let tag_with = language.clone();
        std::thread::spawn(move || {
            for message in rx {
                // Replies to poly's own requests are poly's business; passing
                // them on would have the editor answering for a request it
                // never made.
                if let Message::Response(response) = &message {
                    if is_poly_id(&response.id) {
                        continue;
                    }
                }
                // A request from the server carries an id in *its* numbering,
                // and the editor's reply comes back to poly with that id and
                // nothing else. Tagging it with the language is what lets the
                // reply find its way home once there is more than one server.
                let message = match message {
                    Message::Request(mut request) => {
                        request.id = tag(&tag_with, &request.id);
                        Message::Request(request)
                    }
                    other => other,
                };
                forward(message);
            }
        });

        Ok(Downstream {
            name: name.to_string(),
            language: language.clone(),
            capabilities,
            child,
            stdin,
        })
    }

    pub fn send(&mut self, message: Message) -> Result<()> {
        message
            .write(&mut self.stdin)
            .with_context(|| format!("writing to {}", self.name))
    }

    /// Ask the server to stop, then make sure it did.
    ///
    /// The editor closing is not a reason to leave a gopls behind holding a
    /// module's worth of memory, and a server that ignores `exit` is exactly
    /// the one that would.
    pub fn stop(&mut self) {
        let _ = Message::Request(Request {
            id: RequestId::from(format!("{POLY_ID}shutdown")),
            method: "shutdown".to_string(),
            params: serde_json::Value::Null,
        })
        .write(&mut self.stdin);
        let _ = Message::Notification(Notification {
            method: "exit".to_string(),
            params: serde_json::Value::Null,
        })
        .write(&mut self.stdin);
        for _ in 0..20 {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                Err(_) => break,
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The `client/registerCapability` entries poly sends once a server is up.
///
/// Dynamic registration rather than declaring these in poly's own `initialize`
/// result, because an LSP capability is server-wide while this one is not:
/// poly speaks for 29 languages and gopls answers for one. A documentSelector
/// is how the editor is told which. It also means a server that failed to
/// start registers nothing at all, rather than leaving the editor offering a
/// feature that answers null.
///
/// Driven by what the server declared, never by poly's idea of it — gopls's
/// completion trigger characters are gopls's to choose, and a capability it
/// does not have must not reach the editor as one that does.
pub fn registrations(capabilities: &serde_json::Value, language: &str) -> Vec<serde_json::Value> {
    let selector = serde_json::json!([{ "scheme": "file", "language": language }]);
    PROXIED
        .iter()
        .filter_map(|(method, capability)| {
            let declared = capabilities.get(capability)?;
            if declared.is_null() || declared == &serde_json::Value::Bool(false) {
                return None;
            }
            // A capability is either `true` or an options object; the object
            // is the server's own registration options already.
            let mut options = match declared {
                serde_json::Value::Object(map) => serde_json::Value::Object(map.clone()),
                _ => serde_json::json!({}),
            };
            options["documentSelector"] = selector.clone();
            Some(serde_json::json!({
                "id": format!("{POLY_ID}{language}:{method}"),
                "method": method,
                "registerOptions": options,
            }))
        })
        .collect()
}

/// Was this id minted by poly rather than by the editor?
pub fn is_poly_id(id: &RequestId) -> bool {
    serde_json::to_value(id)
        .ok()
        .and_then(|value| value.as_str().map(|s| s.starts_with(POLY_ID)))
        .unwrap_or(false)
}

/// `42` -> `"go:42"`. The tag rides on the id itself, so a reply routes with
/// no table for poly to keep in step with the traffic.
fn tag(language: &str, id: &RequestId) -> RequestId {
    RequestId::from(format!("{language}:{id}"))
}

/// Undo `tag`: the language poly sent this request out for, and the id the
/// server knows it by.
pub fn untag(id: &RequestId) -> Option<(String, RequestId)> {
    let tagged = serde_json::to_value(id).ok()?;
    let tagged = tagged.as_str()?;
    let (language, original) = tagged.split_once(':')?;
    // `tag` formats through Display, which quotes a string id and leaves a
    // numeric one bare -- so this parses back to whichever the server used.
    let original = original
        .parse::<i32>()
        .map(RequestId::from)
        .unwrap_or_else(|_| RequestId::from(original.trim_matches('"').to_string()));
    Some((language.to_string(), original))
}

/// A response saying poly has nothing for this request.
///
/// Sent when a request arrives for a language whose server is not running: an
/// empty answer is the truth, and an error would surface as a popup about a
/// feature the user did not ask poly for.
pub fn nothing(id: RequestId) -> Response {
    Response {
        id,
        result: Some(serde_json::Value::Null),
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tagging_survives_a_round_trip() {
        for original in [RequestId::from(42), RequestId::from("abc".to_string())] {
            let (language, back) = untag(&tag("go", &original)).expect("tagged id parses");
            assert_eq!(language, "go");
            assert_eq!(back, original, "id changed shape in transit");
        }
        // The editor's own ids are untagged and must stay that way.
        assert!(untag(&RequestId::from(7)).is_none());
    }

    #[test]
    fn poly_ids_are_distinguishable_from_the_editors() {
        assert!(is_poly_id(&RequestId::from(format!("{POLY_ID}initialize"))));
        assert!(!is_poly_id(&RequestId::from(1)));
        assert!(!is_poly_id(&RequestId::from("1".to_string())));
    }

    /// Registration is driven by what the server declared, not by poly's list:
    /// a capability the server does not have must not be advertised to the
    /// editor, or the feature exists in the UI and answers nothing.
    #[test]
    fn only_declared_capabilities_are_registered() {
        let declared = serde_json::json!({
            "hoverProvider": true,
            // Explicitly unsupported, and absent entirely: both mean the
            // editor must not be told the feature exists.
            "definitionProvider": false,
            "completionProvider": {"triggerCharacters": ["."], "resolveProvider": true},
        });
        let registrations = registrations(&declared, "go");
        let methods: Vec<&str> = registrations
            .iter()
            .map(|r| r["method"].as_str().unwrap())
            .collect();
        assert_eq!(methods, ["textDocument/hover", "textDocument/completion"]);

        // The server's own options ride along untouched: poly does not invent
        // trigger characters for someone else's completion.
        let completion = &registrations[1]["registerOptions"];
        assert_eq!(completion["triggerCharacters"], serde_json::json!(["."]));
        assert_eq!(completion["resolveProvider"], serde_json::json!(true));
        // Scoped to the one language this server answers for, not to all 29
        // poly speaks for.
        assert_eq!(completion["documentSelector"][0]["language"], "go");
        assert_eq!(
            registrations[0]["registerOptions"]["documentSelector"][0]["scheme"],
            "file"
        );
    }
}
