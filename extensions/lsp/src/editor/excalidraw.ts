/**
 * Excalidraw's editor, as pomdtr.excalidraw-editor offers it. This file is the
 * part that needs no VSCode: what a file holds, what the page is called, and
 * the page itself. excalidrawEditor.ts is the rest.
 */

/** The files the editor opens, and the links it opens in itself. */
export const SCENES = [".excalidraw", ".excalidraw.json", ".excalidraw.svg", ".excalidraw.png"];

export function isScene(file: string): boolean {
  const lower = file.toLowerCase();
  return SCENES.some((suffix) => lower.endsWith(suffix));
}

/**
 * What the page parses the bytes as, by the last extension alone: a scene
 * saved as `.excalidraw.svg` is an SVG with the scene embedded in it.
 */
export function contentTypeOf(file: string): string {
  const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
  return ext === ".svg" ? "image/svg+xml" : ext === ".png" ? "image/png" : "application/json";
}

/** The drawing's name, which Excalidraw offers as the file name on export. */
export function sceneName(file: string): string {
  const base = file.slice(Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")) + 1);
  const name = base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : base;
  return name.endsWith(".excalidraw") ? name.slice(0, -".excalidraw".length) : name;
}

/**
 * VSCode's display languages to Excalidraw's, for when
 * `poly.excalidraw.language` is unset. pomdtr's table wrote Japanese, Korean
 * and Czech as ja-JA, ko-KO and cs-CS, codes Excalidraw does not have, so
 * those three got English.
 */
export const LANGUAGES: Readonly<Record<string, string>> = {
  en: "en",
  "zh-cn": "zh-CN",
  "zh-tw": "zh-TW",
  fr: "fr-FR",
  de: "de-DE",
  it: "it-IT",
  es: "es-ES",
  ja: "ja-JP",
  ko: "ko-KR",
  ru: "ru-RU",
  "pt-br": "pt-BR",
  tr: "tr-TR",
  pl: "pl-PL",
  cs: "cs-CZ",
};

/** `poly.excalidraw.image`, as the setting spells it. */
export interface ImageSetting {
  exportScale?: 1 | 2 | 3;
  exportWithBackground?: boolean;
  exportWithDarkMode?: boolean;
}

/**
 * The setting in Excalidraw's own names, which the page spreads over the
 * scene's state before every save. pomdtr passed the setting through as it
 * was, and Excalidraw has no `exportWithBackground`: turning it off did
 * nothing.
 */
export function imageParams(image: ImageSetting | undefined) {
  return {
    exportScale: image?.exportScale ?? 1,
    exportBackground: image?.exportWithBackground ?? true,
    exportWithDarkMode: image?.exportWithDarkMode ?? false,
  };
}

/** Where a saved scene says it came from. pomdtr's points at its marketplace page. */
export const EXPORT_SOURCE = "https://github.com/linzeyan/vscode-syntax";

/**
 * The page. The scene travels in an attribute as base64 JSON, as pomdtr's
 * page expects it. pomdtr's page had no CSP; this one allows what Excalidraw
 * reaches for: fonts and images inline or from the extension, the two fonts
 * not shipped (Xiaolai, Liberation) from esm.sh as Excalidraw falls back to,
 * pictures and embeds from the web, and eval. The font subsetting an SVG save
 * runs is WebAssembly whose glue builds functions from strings; refused, the
 * save embeds every font whole instead, 237 KB for a drawing pomdtr saves in
 * 13 KB (tools/excalidraw-diff).
 */
export function excalidrawHtml(page: {
  config: object;
  script: string;
  style: string;
  assets: string;
  cspSource: string;
  nonce: string;
}): string {
  const { cspSource, nonce } = page;
  const csp = [
    "default-src 'none'",
    `img-src ${cspSource} data: blob: https:`,
    `font-src ${cspSource} data: https://esm.sh`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}' ${cspSource} 'unsafe-eval'`,
    `connect-src ${cspSource} https: data: blob:`,
    `worker-src ${cspSource} blob:`,
    "frame-src https:",
  ].join("; ");
  const config = Buffer.from(JSON.stringify(page.config)).toString("base64");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${page.style}">
<script nonce="${nonce}">
window.EXCALIDRAW_EXPORT_SOURCE = ${JSON.stringify(EXPORT_SOURCE)};
window.EXCALIDRAW_ASSET_PATH = ${JSON.stringify(page.assets)};
</script>
<script nonce="${nonce}" type="module" src="${page.script}"></script>
</head>
<body>
<div id="root" data-excalidraw-config="${config}"></div>
</body>
</html>`;
}
