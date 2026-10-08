import * as path from "path";
import * as vscode from "vscode";

import { affects } from "../settings";
import type { MarkdownIt } from "./markdownIt";

/**
 * marp-team.marp-vscode, vendored in ./marp and bundled to dist/marp. Installed,
 * it is the one that runs: its markdown-it plugin and poly's would both take
 * over the same documents, and its preview script and poly's define the same
 * custom elements, which throws the second time.
 */
const MARP = "marp-team.marp-vscode";

/** Upstream contributes these, so they can arrive before anything is loaded. */
const COMMANDS = [
  "poly.marp.export",
  "poly.marp.newMarpMarkdown",
  "poly.marp.showQuickPick",
  "poly.marp.toggleMarpFeature",
];

interface Marp {
  extendMarkdownIt(md: MarkdownIt): MarkdownIt;
}

/** Sets Marp up to load when it is first needed; returns its markdown-it plugin. */
export function registerMarp(context: vscode.ExtensionContext): (md: MarkdownIt) => MarkdownIt {
  const yielded = () => vscode.extensions.getExtension(MARP) !== undefined;
  const standDown = () => void vscode.commands.executeCommand("setContext", "poly.yield.marp", yielded());
  standDown();

  // marp-core and MathJax take about 110 ms to load. Upstream pays that on
  // `onLanguage:markdown`, but poly is activated at startup whatever the
  // language, so it waits for the same moment itself: the first Markdown
  // document, or the first Marp command, whichever comes first. A command
  // that comes first finds a stand-in that loads the real one and hands over.
  let marp: Marp | undefined;
  const standIns = COMMANDS.map((id) =>
    vscode.commands.registerCommand(id, (...args: unknown[]) => {
      load();
      return vscode.commands.executeCommand(id, ...args);
    })
  );
  const load = (): Marp => {
    if (!marp) {
      for (const standIn of standIns) standIn.dispose();
      marp = require(path.join(__dirname, "marp", "extension.js")).activate(context) as Marp;
    }
    return marp;
  };
  const off = () => yielded() || !vscode.workspace.getConfiguration("poly.marp").get<boolean>("enabled", true);
  const loadFor = (document: vscode.TextDocument) => {
    if (document.languageId === "markdown" && !off()) load();
  };
  vscode.workspace.textDocuments.forEach(loadFor);
  context.subscriptions.push(
    ...standIns,
    vscode.extensions.onDidChange(standDown),
    vscode.workspace.onDidOpenTextDocument(loadFor),
    // Once loaded, Marp refreshes the preview on its own settings; before
    // that nobody is listening, and a switch turned on would show nothing.
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!marp && affects(event, "poly.marp.enabled")) {
        void vscode.commands.executeCommand("markdown.preview.refresh");
      }
    }),
  );
  return (md) => {
    if (yielded()) return md;
    if (!off()) return load().extendMarkdownIt(md);
    // The markdown extension asks for plugins once per window, so a plugin
    // left out now would stay out until a reload. Instead Marp is put in on
    // the first render after the switch is turned on; switched off again,
    // Marp itself stops recognising its documents.
    const it = md as MarkdownIt & { parse(src: string, env: unknown): unknown };
    const { parse } = it;
    it.parse = (markdown, env) => {
      if (off()) return parse.call(it, markdown, env);
      it.parse = parse;
      load().extendMarkdownIt(it);
      return it.parse(markdown, env);
    };
    return md;
  };
}
