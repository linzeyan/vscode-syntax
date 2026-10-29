/**
 * The Toolbox's shortcuts that skip the tab: transform's conversions applied
 * where the text or the file already is.
 *
 * - Transform Selection: encode, decode, hash, URL-escape or re-express each
 *   selection in place; a decoded JWT opens as JSON instead.
 * - Convert Document To: JSON, YAML, TOML, XML, GraphQL or Protobuf into any
 *   of transform's text formats, as a new untitled document.
 * - Convert File To (Explorer): a data file or an image, written beside it.
 *
 * Each command also takes its choices as arguments, for keybindings and tests;
 * without them it asks.
 */
import * as path from "path";
import * as vscode from "vscode";

import { convertedName, entries, fileKind, labelOf, numberBase, TEXT_FORMATS, textFormatOf, timestampSource } from "./toolboxOps";

let engine: typeof import("./transformEngine") | undefined;
const load = () => engine ??= require(path.join(__dirname, "transformEngine.js")) as typeof import("./transformEngine");

const zh = () => /^zh-(tw|hant)/.test(vscode.env.language.toLowerCase());
const say = (en: string, zhText: string) => (zh() ? zhText : en);
// The wasm throws its messages as plain strings.
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const OPERATIONS = [
  { id: "encode", en: "Encode", zh: "編碼", enHint: "Base16, 32, 64, 85, 91", zhHint: "Base16、32、64、85、91" },
  { id: "decode", en: "Decode", zh: "解碼", enHint: "Every Base encoding the text is valid in", zhHint: "列出文字能成立的每一種 Base 編碼" },
  { id: "hash", en: "Hash", zh: "雜湊", enHint: "MD5, SHA-1, SHA-2, SHA-3, CRC", zhHint: "MD5、SHA-1、SHA-2、SHA-3、CRC" },
  { id: "urlEncode", en: "URL Encode", zh: "URL 編碼", enHint: "Percent-encoding", zhHint: "百分比編碼" },
  { id: "urlDecode", en: "URL Decode", zh: "URL 解碼", enHint: "Percent-encoding", zhHint: "百分比編碼" },
  { id: "jwtDecode", en: "Decode JWT", zh: "解開 JWT", enHint: "Header and payload, as JSON", zhHint: "header 與 payload，以 JSON 開啟" },
  { id: "timestamp", en: "Timestamp", zh: "時間戳", enHint: "An epoch or a date, in another format", zhHint: "epoch 或日期，換成其他格式" },
  { id: "numberBase", en: "Number Base", zh: "進位", enHint: "Binary, octal, decimal, hex", zhHint: "二、八、十、十六進位" },
] as const;
type Operation = (typeof OPERATIONS)[number]["id"];

/** Every Base encoding transform decodes, as `encode_content` names them. */
const DECODINGS = [
  "base64_standard",
  "base64_raw_standard",
  "base64_url",
  "base64_raw_url",
  "base32_standard",
  "base32_standard_no_padding",
  "base32_hex",
  "base32_hex_no_padding",
  "base85_ascii85",
  "base91",
  "hex_upper",
];

/**
 * The text a selection can become, by name. Several, for the operations that
 * have more than one answer; decoding keeps only the encodings the text is
 * valid in and decodes to readable text in, since nearly any string of
 * letters is valid Base64 of something.
 */
function results(operation: Exclude<Operation, "jwtDecode">, text: string): [string, string][] {
  const wasm = load();
  switch (operation) {
    case "encode":
      return entries(wasm.encode_content(text));
    case "decode":
      return DECODINGS.flatMap((kind): [string, string][] => {
        try {
          const decoded = wasm.decode_content(kind, text);
          // Lossy UTF-8 marks bytes that were not text with U+FFFD.
          return decoded && !/[�\0-\x08\x0E-\x1F]/.test(decoded) ? [[kind, decoded]] : [];
        } catch {
          return [];
        }
      });
    case "hash":
      return entries(wasm.hash_content(text));
    case "urlEncode":
      return [["url", wasm.url_encode(text)]];
    case "urlDecode":
      return [["url", wasm.url_decode(text)]];
    case "timestamp":
      return entries(wasm.convert_timestamp(timestampSource(text), text));
    case "numberBase":
      return entries(wasm.convert_number_base(numberBase(text), text));
  }
}

async function transformSelection(operation?: unknown, choice?: unknown) {
  const editor = vscode.window.activeTextEditor;
  const selections = editor?.selections.filter((one) => !one.isEmpty) ?? [];
  if (!editor || !selections.length) {
    void vscode.window.showInformationMessage(say("Select the text to transform first.", "請先選取要轉換的文字。"));
    return;
  }
  const picked = OPERATIONS.find((one) => one.id === operation)?.id ??
    (await vscode.window.showQuickPick(
      OPERATIONS.map((one) => ({ label: zh() ? one.zh : one.en, detail: zh() ? one.zhHint : one.enHint, id: one.id })),
      { placeHolder: say("Transform the selection", "轉換選取範圍") },
    ))?.id;
  if (!picked) return;
  const texts = selections.map((one) => editor.document.getText(one));
  try {
    if (picked === "jwtDecode") {
      for (const token of texts) {
        // header and payload arrive as JSON text; parsed, they read as part of
        // the document rather than as two escaped strings in it.
        const { header, payload, ...rest } = load().jwt_decode(token.trim()) as Record<string, string>;
        const content = JSON.stringify({ header: JSON.parse(header), payload: JSON.parse(payload), ...rest }, null, 2);
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: "json", content }));
      }
      return;
    }
    // The choice is made on the first selection and applied to every one, so
    // that a multi-cursor edit stays one kind of edit.
    const first = results(picked, texts[0]);
    if (!first.length) throw new Error(say("Nothing to show for this text.", "這段文字沒有可用的結果。"));
    const key = typeof choice === "string"
      ? choice
      : new Set(first.map(([, value]) => value)).size === 1
      ? first[0][0]
      : (await vscode.window.showQuickPick(
        // One row per distinct answer: Base64 and Base64 URL decode most text
        // to the same thing, and two identical rows read as a choice that is not.
        [...new Set(first.map(([, value]) => value))].map((value) => {
          const named = first.filter((pair) => pair[1] === value).map(([name]) => name);
          return { label: value, description: named.map(labelOf).join(", "), name: named[0] };
        }),
        { placeHolder: say("Replace the selection with", "以此取代選取範圍"), matchOnDescription: true },
      ))?.name;
    if (!key) return;
    const values = texts.map((text, index) => (index === 0 ? first : results(picked, text)).find(([name]) => name === key)?.[1]);
    await editor.edit((edit) => {
      selections.forEach((selection, index) => {
        if (values[index] !== undefined) edit.replace(selection, values[index]!);
      });
    });
    const skipped = values.filter((value) => value === undefined).length;
    if (skipped) {
      void vscode.window.showWarningMessage(
        say(`${skipped} selection(s) had no ${key} result and were left as they were.`, `${skipped} 個選取範圍沒有 ${key} 的結果，保持原樣。`),
      );
    }
  } catch (error) {
    void vscode.window.showErrorMessage(`Toolbox: ${message(error)}`);
  }
}

async function convertDocument(target?: unknown) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const selection = editor.selection;
  const text = editor.document.getText(selection.isEmpty ? undefined : selection);
  const readable = TEXT_FORMATS.filter((format) => format.from.length);
  const from = textFormatOf(editor.document.languageId) ??
    (await vscode.window.showQuickPick(readable.map((format) => format.id), {
      placeHolder: say("Read the document as", "將文件視為"),
    }));
  if (!from) return;
  const name = typeof target === "string" && target !== from
    ? target
    : await vscode.window.showQuickPick(
      TEXT_FORMATS.filter((format) => format.id !== from).map((format) => format.id),
      { placeHolder: say(`Convert ${from} to`, `將 ${from} 轉換為`) },
    );
  const format = TEXT_FORMATS.find((one) => one.id === name);
  if (!format) return;
  try {
    const content = load().transform_format(from, format.id, text);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: format.language, content }));
  } catch (error) {
    void vscode.window.showErrorMessage(`Toolbox: ${message(error)}`);
  }
}

async function convertFile(resource?: unknown, target?: unknown) {
  const uri = resource instanceof vscode.Uri ? resource : vscode.window.activeTextEditor?.document.uri;
  const kind = uri && fileKind(uri.path);
  if (!uri || !kind) {
    void vscode.window.showInformationMessage(
      say(
        "Convert File To works on CSV, TSV, JSON, Parquet, Avro and Arrow files, and on PNG, JPEG and WebP images.",
        "轉換檔案適用於 CSV、TSV、JSON、Parquet、Avro、Arrow 檔，以及 PNG、JPEG、WebP 圖片。",
      ),
    );
    return;
  }
  const chosen = kind.targets.find((one) => one.id === target) ??
    (await vscode.window.showQuickPick(
      kind.targets.map((one) => ({ label: one.label, description: `.${one.extension}`, target: one })),
      { placeHolder: say(`Convert ${path.posix.basename(uri.path)} to`, `將 ${path.posix.basename(uri.path)} 轉換為`) },
    ))?.target;
  if (!chosen) return;
  const name = convertedName(path.posix.basename(uri.path), chosen.extension);
  const destination = uri.with({ path: path.posix.join(path.posix.dirname(uri.path), name) });
  try {
    await vscode.workspace.fs.stat(destination);
    const replace = say("Replace", "取代");
    const answer = await vscode.window.showWarningMessage(
      say(`${name} already exists.`, `${name} 已經存在。`),
      { modal: true },
      replace,
    );
    if (answer !== replace) return;
  } catch {
    // Not there yet, which is the usual case.
  }
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: say(`Writing ${name}`, `正在寫入 ${name}`) },
      async () => {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const wasm = load();
        const output = kind.kind === "data"
          ? wasm.convert_tabular_format(kind.from, chosen.id, bytes).bytes
          : Buffer.from(wasm.convert_image_format(kind.from, chosen.id, bytes, {}).data_base64, "base64");
        await vscode.workspace.fs.writeFile(destination, output);
      },
    );
  } catch (error) {
    void vscode.window.showErrorMessage(`Toolbox: ${message(error)}`);
    return;
  }
  // Not awaited: the command is done once the file is, whether or not anyone
  // answers the notification.
  const open = say("Open", "開啟");
  void vscode.window.showInformationMessage(say(`Wrote ${name}.`, `已寫入 ${name}。`), open).then((answer) => {
    if (answer === open) void vscode.commands.executeCommand("vscode.open", destination);
  });
}

export function registerToolboxCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("poly.toolbox.transformSelection", transformSelection),
    vscode.commands.registerCommand("poly.toolbox.convertDocument", convertDocument),
    vscode.commands.registerCommand("poly.toolbox.convertFile", convertFile),
  );
}
