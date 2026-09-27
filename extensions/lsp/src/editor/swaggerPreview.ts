/**
 * arjun.swagger-viewer 3.2.0's preview server (its `src/preview/server.ts`),
 * and the parsing its client does.
 *
 * Bundled on its own (`dist/swaggerPreview.js`) and loaded on the first
 * preview: swagger-parser and js-yaml are for the few who preview.
 *
 * Upstream serves with express and pushes with socket.io; this is Node's own
 * `http` pushing Server-Sent Events, which is all a push to a page that never
 * talks back needs. Upstream's URLs carry a hash of the file's path, which any
 * page in the browser can compute, and it serves the extension's whole
 * `node_modules`; these carry a random token, and serve Swagger UI's files
 * alone.
 */
import SwaggerParser from "@apidevtools/swagger-parser";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import * as http from "http";
import yaml from "js-yaml";
import type { AddressInfo } from "net";
import * as path from "path";

const ROOT = path.join(__dirname, "swagger");

const TYPES: Record<string, string> = {
  ".css": "text/css",
  ".js": "application/javascript",
  ".png": "image/png",
};

/** What the page loads from `node_modules/swagger-ui-dist/`; the build copies these. */
const SWAGGER_UI = [
  "favicon-16x16.png",
  "favicon-32x32.png",
  "swagger-ui-bundle.js",
  "swagger-ui-standalone-preset.js",
  "swagger-ui.css",
];

/** By lowercased path or URL, as upstream keys its hash. */
const tokens = new Map<string, string>();
const specs = new Map<string, unknown>();
const pages = new Map<string, Set<http.ServerResponse>>();

/** What upstream reads off a parsed document to tell a spec: a `.match` on a non-string `openapi` throws, as there. */
type Versions = { swagger?: unknown; openapi?: string } | null | undefined;

let server: http.Server | undefined;
let starting: Promise<void> | undefined;
let origin = "";

/** Upstream's `getParsedContent`: undefined for a language it does not read, null for what does not parse. */
export function parse(content: string, languageId: string): unknown {
  try {
    if (languageId === "json") return JSON.parse(content);
    if (languageId === "yaml") return yaml.load(content);
    if (languageId === "plaintext") return /^\s*[{[]/.test(content) ? JSON.parse(content) : yaml.load(content);
  } catch (error) {
    console.error("Error parsing content:", error);
    return null;
  }
}

/** Whether the file on disk is a Swagger 2.0 or OpenAPI 3.0/3.1 document, as upstream's file list decides. */
export async function isSpec(file: string): Promise<boolean> {
  try {
    const content = await fs.readFile(file, "utf8");
    const parsed: Versions = file.endsWith(".json") ? JSON.parse(content) : yaml.load(content);
    return !!parsed && (parsed.swagger === "2.0" || !!(parsed.openapi && parsed.openapi.match(/^3\.[01]\.\d/)));
  } catch {
    return false;
  }
}

/** The schema redhat.vscode-yaml should validate a document against, as upstream's contributor names it. */
export function schemaOf(text: string): string | null {
  const parsed = yaml.load(text) as Versions;
  if (parsed) {
    if (parsed.swagger === "2.0") return "swaggerviewer:swagger";
    if (parsed.openapi && parsed.openapi.match(/^3\.[01]\.\d(-.+)?$/)) return "swaggerviewer:openapi";
  }
  return null;
}

function tokenOf(file: string): string {
  const key = file.toLowerCase();
  let token = tokens.get(key);
  if (!token) tokens.set(key, token = randomUUID());
  return token;
}

function push(page: http.ServerResponse, spec: unknown) {
  page.write(`data: ${JSON.stringify(spec ?? null)}\n\n`);
}

async function serve(request: http.IncomingMessage, response: http.ServerResponse) {
  const [, first, second, third] = new URL(request.url ?? "/", "http://localhost").pathname.split("/");
  const known = (token: string | undefined) => token !== undefined && specs.has(token);
  if (first === "node_modules" && second === "swagger-ui-dist" && SWAGGER_UI.includes(third)) {
    response.writeHead(200, { "Content-Type": TYPES[path.extname(third)] });
    response.end(await fs.readFile(path.join(ROOT, "swagger-ui-dist", third)));
  } else if (first === "events" && known(second) && third === undefined) {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    push(response, specs.get(second));
    const open = pages.get(second) ?? new Set();
    pages.set(second, open.add(response));
    response.on("close", () => open.delete(response));
  } else if (known(first) && second === undefined) {
    const page = await fs.readFile(path.join(ROOT, "index.html"), "utf8");
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(page.replace("%FILE_HASH%", first));
  } else {
    response.writeHead(404).end();
  }
}

async function listen(host: string, port: number): Promise<void> {
  for (;; port++) {
    const created = http.createServer((request, response) =>
      void serve(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      })
    );
    try {
      await new Promise<void>((resolve, reject) => {
        created.once("error", reject);
        created.listen(port, host, resolve);
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || port >= 65535) throw error;
      continue;
    }
    server = created;
    origin = `http://${host}:${(created.address() as AddressInfo).port}`;
    return;
  }
}

/**
 * Listens on `host`, from `port` up to the first port that is free, as
 * upstream's portfinder does. A second preview asked for while the first is
 * still starting waits for the same server, rather than leaving one listening
 * that nothing can stop.
 */
export function start(host: string, port: number): Promise<void> {
  starting ??= listen(host, port).catch((error) => {
    starting = undefined;
    throw error;
  });
  return starting;
}

/**
 * The file's spec with its external `$ref`s pulled in, falling back to the
 * spec as it is when they do not resolve; open pages get it at once.
 *
 * Upstream means to do the same, but calls `bundle` on the module namespace
 * TypeScript's `import * as` makes, which is no constructor: every call throws,
 * and its pages get the spec as typed.
 */
export async function update(file: string, content: unknown): Promise<void> {
  const token = tokenOf(file);
  try {
    specs.set(token, await SwaggerParser.bundle(file, content as Parameters<typeof SwaggerParser.bundle>[1], {}));
  } catch (error) {
    console.error("Error updating swagger content:", error);
    specs.set(token, content);
  }
  for (const page of pages.get(token) ?? []) push(page, specs.get(token));
}

export function url(file: string): string {
  return `${origin}/${tokenOf(file)}`;
}

/** Whether a preview of the file was ever opened, so edits to it are worth bundling. */
export function previewed(file: string): boolean {
  return tokens.has(file.toLowerCase());
}

/**
 * Stops taking new pages. As upstream, the pages already open stay connected
 * and keep updating.
 */
export function stop(): void {
  server?.close();
  server = undefined;
  starting = undefined;
}
