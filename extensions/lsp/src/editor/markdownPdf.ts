/**
 * yzane.markdown-pdf's export, run inside poly: markdown to HTML, PDF, PNG or
 * JPEG. Built to its own bundle (`dist/markdownPdf.js`) and loaded when an
 * export runs, because puppeteer and KaTeX are most of its weight.
 *
 * This is upstream's `extension.ts` (2.2.0, MIT, `markdownPdf/LICENSE.txt`)
 * with its settings under `poly.markdownPdf`; the modules it calls are
 * upstream's own, kept in `markdownPdf/` (see its README for the few lines
 * that differ). What is poly's is said where it is: emoji drawn as text, a
 * Chrome that is pinned and checked, and no download until an export needs it.
 */
import * as PB from "@puppeteer/browsers";
import markdownItKatex from "@vscode/markdown-it-katex";
import fs from "fs";
import hljs from "highlight.js";
import markdownIt from "markdown-it";
import markdownItContainer from "markdown-it-container";
import { full as markdownItEmojiFull } from "markdown-it-emoji";
import markdownItPlantuml from "markdown-it-plantuml";
import os from "os";
import path from "path";
import puppeteer from "puppeteer-core";
import * as vscode from "vscode";
import { CHROME_BUILD, downloadChrome } from "./chromePin";
import * as chromiumResolver from "./markdownPdf/chromium-resolver";
import * as diagnostics from "./markdownPdf/diagnostics";
import * as logger from "./markdownPdf/logger";
import { markdownItCheckbox } from "./markdownPdf/markdown-it-checkbox";
import { markdownItInclude } from "./markdownPdf/markdown-it-include";
import { mathBracketsPlugin } from "./markdownPdf/markdown-it-math-brackets";
import { mathFencePlugin } from "./markdownPdf/markdown-it-math-fence";
import { markdownItNamedHeaders } from "./markdownPdf/markdown-it-named-headers";
import { installSanitizeRules } from "./markdownPdf/markdown-it-sanitize";
import { renderMath } from "./markdownPdf/math-renderer";
import * as utils from "./markdownPdf/utils";

const SECTION = "poly.markdownPdf";
/** Upstream's styles, template and emoji names, with KaTeX's and highlight.js's files, as the build lays them out. */
const ROOT = path.join(__dirname, "markdown-pdf");
const CLOSE_BROWSER_TIMEOUT_MS = 5000;

let extensionContext: vscode.ExtensionContext | undefined;

const config = (uri?: vscode.Uri) => vscode.workspace.getConfiguration(SECTION, uri);

function getExtensionCacheDir(): string {
  return extensionContext?.globalStorageUri.fsPath ?? "";
}

/** Reads poly.markdownPdf.chromium.autoDownload (default: true). */
function getAutoDownload(): boolean {
  const chromium = config()["chromium"];
  if (chromium && typeof chromium === "object" && typeof chromium.autoDownload === "boolean") {
    return chromium.autoDownload;
  }
  return true;
}

/** Collects a host environment snapshot for diagnostics. */
function collectEnvironment(): diagnostics.EnvironmentInfo {
  return {
    extensionVersion: extensionContext?.extension.packageJSON.version ?? "unknown",
    vscodeVersion: vscode.version,
    platform: process.platform,
    osRelease: os.release(),
    arch: process.arch,
    nodeVersion: process.version,
    puppeteerCoreVersion: chromiumResolver.getPuppeteerCoreVersion(),
    expectedChromeBuildId: chromiumResolver.getExpectedBuildId(),
  };
}

// The channel is made the first time this bundle is used, which is also the
// first time anything has something to say in it.
function start(context: vscode.ExtensionContext) {
  if (extensionContext) {
    return;
  }
  extensionContext = context;
  logger.initializeLogger(context, () => vscode.window.createOutputChannel("Markdown PDF (Poly)", { log: true }));
}

/** Outputs an environment snapshot and current settings to the channel, then reveals it. */
export function outputDiagnostics(context: vscode.ExtensionContext): void {
  start(context);
  const env = collectEnvironment();
  const homeDir = os.homedir();
  const settings = config();
  logger.logInfo(diagnostics.buildEnvironmentBlock(env));
  logger.logInfo([
    "--- Settings ---",
    "type: " + JSON.stringify(settings["type"]),
    "sanitize: " + (settings["sanitize"] || "gfm"),
    "executablePath: " + diagnostics.orNotSet(diagnostics.maskHomePath(settings["executablePath"] || "", homeDir)),
    "chromium.autoDownload: " + String(getAutoDownload()),
    "outputDirectory: " + diagnostics.orNotSet(diagnostics.maskHomePath(settings["outputDirectory"] || "", homeDir)),
  ].join("\n"));
  logger.showLog();
}

/**
 * One export: `optionType` is a format, `all`, or `settings` for the formats
 * `poly.markdownPdf.type` names. `document` is the one in front for a command
 * and the one saved for convert-on-save -- upstream converts the active
 * editor's either way, which on a Save All is some other file.
 */
export async function exportMarkdown(
  context: vscode.ExtensionContext,
  optionType: string,
  document: vscode.TextDocument | undefined,
  isMarkdown: (languageId: string) => boolean,
  isOnSave = false,
): Promise<void> {
  start(context);
  try {
    // check active window
    if (!document) {
      logger.logWarn("Export aborted: no active editor.");
      vscode.window.showWarningMessage("No active Editor!");
      return;
    }

    // check markdown mode
    const mode = document.languageId;
    if (!isMarkdown(mode)) {
      logger.logWarn("Export aborted: active document is not markdown (languageId=" + mode + ").");
      vscode.window.showWarningMessage("It is not a markdown mode!");
      return;
    }

    const uri = document.uri;
    const mdfilename = uri.fsPath;
    if (!utils.isExistsPath(mdfilename)) {
      if (document.isUntitled) {
        logger.logWarn("Export aborted: document is untitled (unsaved).");
        vscode.window.showWarningMessage("Please save the file!");
        return;
      }
      logger.logWarn("Export aborted: cannot resolve a local file path for " + uri.toString());
      vscode.window.showWarningMessage(
        "Cannot determine the file path. Virtual or remote workspaces (e.g. Azure DevOps) are not supported. Save the file to a local folder.",
      );
      return;
    }
    if (isOnSave && utils.isExcludeFile(path.basename(mdfilename), config()["convertOnSaveExclude"] || "")) {
      return;
    }

    const typesFormat = ["html", "pdf", "png", "jpeg"];
    const types = utils.resolveExportTypes(optionType, config()["type"]);
    if (types === null || types.length === 0) {
      reportError({
        operation: "Unsupported output format. Supported: html, pdf, png, jpeg.",
        where: "exportMarkdown()",
        context: "type guard (resolveExportTypes returned " + JSON.stringify(types) + ")",
      });
      return;
    }

    // convert and export markdown to pdf, html, png, jpeg
    const sanitizeMode = (config()["sanitize"] || "gfm") as utils.SanitizeMode;
    let sanitizeReport: utils.SanitizeReport = { removedElements: [], strippedAttributes: [] };
    const env = collectEnvironment();
    const homeDir = os.homedir();
    for (const type of types) {
      if (typesFormat.indexOf(type) < 0) {
        reportError({
          operation: "Unsupported output format. Supported: html, pdf, png, jpeg.",
          where: "exportMarkdown()",
          context: "type guard (unexpected type \"" + type + "\")",
        });
        return;
      }
      // Upstream replaces the first `.md` anywhere in the path, which in
      // `notes.md.d/a.md` is the folder's.
      const parsed = path.parse(mdfilename);
      const filename = path.join(parsed.dir, parsed.name + "." + type);
      const text = document.getText();
      const ctx: diagnostics.ConvertContext = {
        sourceFile: mdfilename,
        outputType: type,
        executablePath: config()["executablePath"] || "",
        autoDownload: getAutoDownload(),
        outputDirectory: config()["outputDirectory"] || "",
        sanitize: sanitizeMode,
      };
      logger.logInfo(diagnostics.buildStartDiagnostics(env, ctx, homeDir));
      const converted = convertMarkdownToHtml(mdfilename, type, text, ctx, homeDir);
      if (!converted) {
        // convertMarkdownToHtml already logged the failure and showed an error toast.
        continue;
      }
      // Report is identical across export types (same source + mode); keep the latest.
      sanitizeReport = converted.report;
      const html = makeHtml(converted.html, uri, ctx, homeDir);
      if (html === undefined) {
        // makeHtml already logged the failure and showed an error toast. Skip this type.
        continue;
      }
      await exportPdf(html, filename, type, uri, ctx, homeDir);
    }
    // One notification per invocation, after all export types are processed.
    notifySanitize(sanitizeReport, sanitizeMode, isOnSave);
  } catch (error) {
    reportError({ operation: EXPORT_FAILED_MSG, where: "exportMarkdown()", error });
  }
}

function getFrontMatterBoolean(data: Record<string, unknown>, key: string): boolean | null | undefined {
  const value = data[key];
  return typeof value === "boolean" || value === null ? value : undefined;
}

function getFrontMatterString(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === "string" ? value : undefined;
}

function getFrontMatterRecord(data: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = data[key];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

let emojiNames: string[] | undefined;

/*
 * convert markdown to html (markdown-it)
 */
// ctx/homeDir are used only in the catch block to add diagnostic context to error logs.
function convertMarkdownToHtml(
  filename: string,
  type: string,
  text: string,
  ctx: diagnostics.ConvertContext,
  homeDir: string,
): { html: string; report: utils.SanitizeReport } | undefined {
  let statusbarmessage: vscode.Disposable | undefined;
  try {
    const matterParts = utils.parseFrontMatter(text);
    statusbarmessage = vscode.window.setStatusBarMessage("$(markdown) Converting (convertMarkdownToHtml) ...");
    const breaks = utils.setBooleanValue(getFrontMatterBoolean(matterParts.data, "breaks"), config()["breaks"]);
    const md = markdownIt(
      utils.buildMarkdownItOptions({
        breaks: breaks,
        hljs: hljs,
        escapeHtml: markdownIt().utils.escapeHtml,
      }) as markdownIt.Options,
    );

    // convert the img src of the markdown
    const defaultRender = md.renderer.rules.image;
    md.renderer.rules.image = function(tokens, idx, options, env, self) {
      const token = tokens[idx];
      const href = token.attrs![token.attrIndex("src")][1];
      const transformedHref = utils.transformImageHref(href, type, filename);
      token.attrs![token.attrIndex("src")][1] = transformedHref;
      return defaultRender!(tokens, idx, options, env, self);
    };

    const sanitizeMode = (config()["sanitize"] || "gfm") as utils.SanitizeMode;
    const sanitizeReport: utils.SanitizeReport = { removedElements: [], strippedAttributes: [] };
    installSanitizeRules(
      md,
      sanitizeMode,
      sanitizeReport,
      type !== "html"
        ? function(h: string) {
          return utils.transformHtmlBlock(h, filename);
        }
        : undefined,
    );

    // checkbox
    md.use(markdownItCheckbox);

    // emoji
    const emojiOn = utils.setBooleanValue(getFrontMatterBoolean(matterParts.data, "emoji"), config()["emoji"]);
    if (emojiOn) {
      // The names upstream knows, each drawn as its character in the system's
      // emoji font. Upstream draws them from emoji-images' pictures, which are
      // Apple's and licensed to no one; a name with no character (`:octocat:`)
      // stays as written.
      emojiNames ??= Object.keys(JSON.parse(utils.readFile(path.join(ROOT, "data", "emoji.json")) as string));
      md.use(markdownItEmojiFull, { enabled: emojiNames } as never);
    }

    // toc via the local named-headers plugin
    md.use(markdownItNamedHeaders, { slugify: utils.Slug });

    // markdown-it-container
    // https://github.com/markdown-it/markdown-it-container
    md.use(markdownItContainer, "", utils.buildContainerRenderer());

    // PlantUML
    // https://github.com/gmunguia/markdown-it-plantuml
    const plantumlOptions = utils.buildPlantumlOptions({
      frontmatterOpenMarker: getFrontMatterString(matterParts.data, "plantumlOpenMarker"),
      frontmatterCloseMarker: getFrontMatterString(matterParts.data, "plantumlCloseMarker"),
      settingsOpenMarker: config()["plantumlOpenMarker"] || "",
      settingsCloseMarker: config()["plantumlCloseMarker"] || "",
      server: config()["plantumlServer"] || "",
    });
    md.use(markdownItPlantuml, plantumlOptions);

    // Math rendering via KaTeX
    // https://github.com/microsoft/vscode-markdown-it-katex (same plugin as VS Code's built-in Markdown Math)
    const mathFrontmatter = getFrontMatterRecord(matterParts.data, "math") || {};
    const mathFrontmatterKatex = getFrontMatterRecord(mathFrontmatter, "katex") || {};
    const mathSettings = config().get<{ enabled?: boolean; katex?: { macros?: Record<string, string> } }>("math") || {};
    const mathEnabled = utils.setBooleanValue(
      typeof mathFrontmatter["enabled"] === "boolean" ? (mathFrontmatter["enabled"] as boolean) : undefined,
      mathSettings.enabled,
    ) ?? true;
    const mathMacrosFrontmatter = getFrontMatterRecord(mathFrontmatterKatex, "macros");
    const mathMacrosSettings = (mathSettings.katex && mathSettings.katex.macros) || {};
    const mathMacros: Record<string, string> = {};
    for (const [k, v] of Object.entries(mathMacrosSettings)) {
      if (typeof v === "string") mathMacros[k] = v;
    }
    if (mathMacrosFrontmatter) {
      for (const [k, v] of Object.entries(mathMacrosFrontmatter)) {
        if (typeof v === "string") mathMacros[k] = v;
      }
    }
    if (mathEnabled) {
      md.use(markdownItKatex, { enableBareBlocks: true, enableMathBlockInHtml: false });
      md.use(mathBracketsPlugin);
      // Route delimiter-path math tokens through renderMath(). Inline \[...\]
      // tokens carry markup '\\[' and must render as display math; all other
      // math_inline tokens render inline.
      md.renderer.rules.math_inline = function(tokens, idx) {
        const token = tokens[idx];
        return renderMath(token.content, token.markup === "\\[", { macros: mathMacros });
      };
      md.renderer.rules.math_block = function(tokens, idx) {
        return renderMath(tokens[idx].content, true, { macros: mathMacros });
      };
      md.use(mathFencePlugin, { macros: mathMacros });
    }

    // ```plantuml fenced code blocks render as PlantUML diagrams alongside the
    // @startuml/@enduml block syntax handled by markdown-it-plantuml above.
    const defaultFenceRenderer = md.renderer.rules.fence;
    md.renderer.rules.fence = function(tokens, idx, options, env, self) {
      const token = tokens[idx];
      if (token.info.trim().toLowerCase() === "plantuml") {
        return utils.buildPlantumlImgTag(token.content, plantumlOptions.server);
      }
      if (defaultFenceRenderer) {
        return defaultFenceRenderer(tokens, idx, options, env, self);
      }
      return self.renderToken(tokens, idx, options);
    };

    // Include markdown fragment files with :[alt-text](relative-path-to-file.md) syntax
    // https://talk.commonmark.org/t/transclusion-or-including-sub-documents-for-reuse/270/13
    if (config()["markdown-it-include"]["enable"]) {
      md.use(markdownItInclude, { root: path.dirname(filename), throwError: false });
    }

    statusbarmessage.dispose();
    const html = md.render(matterParts.content);

    // Show warning for missing include files
    const includeErrorRe = /INCLUDE ERROR: (.+?)(?=<\/h1>|<\/p>|\n)/g;
    let match;
    while ((match = includeErrorRe.exec(html)) !== null) {
      vscode.window.showWarningMessage(match[1]);
    }

    return { html: html, report: sanitizeReport };
  } catch (error) {
    statusbarmessage?.dispose();
    reportError({
      operation: "Failed to convert Markdown to HTML.",
      where: "convertMarkdownToHtml()",
      error,
      context: diagnostics.buildContextSummary(ctx, homeDir),
      classify: true,
    });
  }
}

/*
 * make html
 */
function makeHtml(
  data: string,
  uri: vscode.Uri,
  ctx: diagnostics.ConvertContext,
  homeDir: string,
): string | undefined {
  try {
    const view = utils.buildHtmlViewData({
      content: data,
      title: path.basename(uri.fsPath),
      style: readStyles(uri, data) ?? "",
      mermaidServer: config()["mermaidServer"] || "",
    });
    return utils.renderTemplate(utils.readFile(path.join(ROOT, "template", "template.html")) as string, view);
  } catch (error) {
    reportError({
      operation: "Failed to build the HTML document.",
      where: "makeHtml()",
      error,
      context: diagnostics.buildContextSummary(ctx, homeDir),
      classify: true,
    });
  }
}

/*
 * export a html to a pdf file (html-pdf)
 */
function exportPdf(
  data: string,
  filename: string,
  type: string,
  uri: vscode.Uri,
  ctx: diagnostics.ConvertContext,
  homeDir: string,
): Thenable<void> {
  const StatusbarMessageTimeout = config()["StatusbarMessageTimeout"];
  vscode.window.setStatusBarMessage("");
  const exportFilename = getOutputDir(filename, uri);
  if (!exportFilename) {
    return Promise.resolve(); // getOutputDir already showed an error toast
  }
  ctx.outputPath = exportFilename;
  logger.logInfo("Output: " + diagnostics.maskHomePath(exportFilename, homeDir));

  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "[Markdown PDF]: Exporting (" + type + ") ...",
  }, async (progress) => {
    let tmpfilename: string | undefined;
    let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;

    try {
      // Written before anything reads it: upstream starts the write and moves
      // on, so a slow disk can hand Chrome a half-written page, and a failed
      // write shows as success.
      if (type == "html") {
        await fs.promises.writeFile(exportFilename, data, "utf-8");
        vscode.window.setStatusBarMessage("$(markdown) " + exportFilename, StatusbarMessageTimeout);
        return;
      }

      // create temporary file
      tmpfilename = utils.generateTmpHtmlFilename(filename);
      await fs.promises.writeFile(tmpfilename, data, "utf-8");
      const resolution = await resolveChromium(
        config()["executablePath"] || "",
        getExtensionCacheDir(),
        getAutoDownload(),
        (downloaded, total) => {
          if (total > 0) {
            progress.report({
              message: `downloading Chrome ${CHROME_BUILD} (${Math.floor(downloaded / total * 100)}%)`,
            });
          }
        },
      );
      if (!resolution.ok) {
        switch (resolution.reason) {
          case "autodownload-disabled":
            reportError({
              operation: AUTO_DOWNLOAD_DISABLED_MSG,
              where: "exportPdf()",
              action: { kind: "settings", query: "@id:poly.markdownPdf.chromium.autoDownload", label: "Open Settings" },
            });
            break;
          case "network":
            reportError({
              operation: "Could not download Chromium (network error). "
                + "If you are behind a proxy, set http.proxy and restart VS Code.",
              where: "exportPdf()",
              action: { kind: "settings", query: "@id:http.proxy", label: "Open Settings" },
            });
            break;
          case "download-failed":
            reportError({
              operation:
                "Could not obtain Chromium. Install Google Chrome or Microsoft Edge, or set poly.markdownPdf.executablePath.",
              where: "exportPdf()",
              action: { kind: "settings", query: "@id:poly.markdownPdf.executablePath", label: "Open Settings" },
            });
            break;
        }
        return;
      }
      const launchOptions = {
        executablePath: resolution.path,
        args: ["--lang=" + vscode.env.language, "--no-sandbox", "--disable-setuid-sandbox"],
        // Setting Up Chrome Linux Sandbox
        // https://github.com/puppeteer/puppeteer/blob/master/docs/troubleshooting.md#setting-up-chrome-linux-sandbox
      };
      ctx.resolvedChromiumPath = resolution.path;
      ctx.chromiumSource = resolution.source;
      logger.logInfo(
        "Chromium: " + diagnostics.maskHomePath(resolution.path, homeDir) + " (source: " + resolution.source + ")",
      );
      browser = await puppeteer.launch(launchOptions);
      const page = await browser.newPage();
      // PDF/image rendering is headless with no user to answer JS dialogs; auto-dismiss
      // them so a script calling alert/confirm/prompt/beforeunload cannot hang the export.
      page.on("dialog", async function(dialog) {
        const info = "(" + dialog.type() + "): " + dialog.message();
        try {
          await dialog.dismiss();
          logger.logWarn("Dismissed a blocking dialog during rendering " + info);
        } catch (error) {
          logger.logWarn(
            "Failed to dismiss a blocking dialog during rendering " + info + " - "
              + (error instanceof Error ? error.message : String(error)),
          );
        }
      });
      await page.setDefaultTimeout(0);
      await page.goto(vscode.Uri.file(tmpfilename).toString(), { waitUntil: "networkidle0" });
      // generate pdf
      // https://github.com/GoogleChrome/puppeteer/blob/master/docs/api.md#pagepdfoptions
      if (type == "pdf") {
        const settings = config(uri);
        const pdfOptions = utils.buildPdfOptions({
          path: exportFilename,
          width: settings["width"] || "",
          height: settings["height"] || "",
          format: settings["format"] || "A4",
          orientation: settings["orientation"] || "",
          scale: settings["scale"],
          displayHeaderFooter: settings["displayHeaderFooter"],
          headerTemplate: settings["headerTemplate"] || "",
          footerTemplate: settings["footerTemplate"] || "",
          printBackground: settings["printBackground"],
          pageRanges: settings["pageRanges"] || "",
          margin: {
            top: settings["margin"]["top"] || "",
            right: settings["margin"]["right"] || "",
            bottom: settings["margin"]["bottom"] || "",
            left: settings["margin"]["left"] || "",
          },
        });
        await page.pdf(pdfOptions);
      }

      // generate png and jpeg
      // https://github.com/GoogleChrome/puppeteer/blob/master/docs/api.md#pagescreenshotoptions
      if (type == "png" || type == "jpeg") {
        const settings = config();
        const imageOptions = utils.buildImageOptions({
          path: exportFilename,
          type: type,
          quality: settings["quality"] || 100,
          clip: {
            x: settings["clip"]["x"] || null,
            y: settings["clip"]["y"] || null,
            width: settings["clip"]["width"] || null,
            height: settings["clip"]["height"] || null,
          },
          omitBackground: settings["omitBackground"],
        });
        await page.screenshot(imageOptions);
      }

      vscode.window.setStatusBarMessage("$(markdown) " + exportFilename, StatusbarMessageTimeout);
    } catch (error) {
      reportError({
        operation: "Failed to export " + type + ".",
        where: "exportPdf()",
        error,
        context: diagnostics.buildContextSummary(ctx, homeDir),
        classify: true,
      });
    } finally {
      if (browser) {
        try {
          const closeResult = await utils.awaitWithTimeout(browser.close(), CLOSE_BROWSER_TIMEOUT_MS);
          if (closeResult.timedOut) {
            logger.logWarn(
              "Timed out while closing Chromium after export; continuing so the progress notification can finish.",
            );
          }
        } catch (error) {
          logger.logWarn("Failed to close Chromium after export: " + logger.formatError(error));
        }
      }
      if (tmpfilename && utils.isExistsPath(tmpfilename)) {
        try {
          fs.rmSync(tmpfilename, { recursive: true, force: true });
        } catch (error) {
          logger.logWarn("Failed to delete temporary HTML after export: " + logger.formatError(error));
        }
      }
    }
  });
}

/**
 * A Chrome to print with: the one set, else one installed, else the Chrome
 * for Testing poly pins.
 *
 * Upstream's order, save for its last step: it fetches whichever build is
 * newest the moment it is asked, and at activation. Poly downloads the build
 * puppeteer-core was made for, only when an export needs it, and keeps it
 * only if its sha256 is the one in chromePin.ts -- as every other download
 * poly makes.
 */
async function resolveChromium(
  userExecutablePath: string,
  cacheDir: string,
  autoDownload: boolean,
  onProgress: (downloadedBytes: number, totalBytes: number) => void,
): Promise<chromiumResolver.ChromiumResolution> {
  const userPath = chromiumResolver.findChromiumFromUserSetting(userExecutablePath);
  if (userPath) {
    return { ok: true, path: userPath, source: "user-setting" };
  }
  const systemPath = chromiumResolver.findChromiumFromSystem();
  if (systemPath) {
    return { ok: true, path: systemPath, source: "system" };
  }
  const platform = PB.detectBrowserPlatform();
  const pinned = platform
    && PB.computeExecutablePath({ browser: PB.Browser.CHROME, buildId: CHROME_BUILD, cacheDir, platform });
  if (pinned && fs.existsSync(pinned)) {
    return { ok: true, path: pinned, source: "cached" };
  }
  if (!autoDownload) {
    const cached = await chromiumResolver.findLatestCachedChromium(cacheDir);
    return cached ? { ok: true, path: cached, source: "cached" } : { ok: false, reason: "autodownload-disabled" };
  }
  try {
    if (!platform) {
      throw new Error(`poly pins no Chrome for Testing for ${process.platform}-${process.arch}`);
    }
    const executable = await downloadChrome(cacheDir, platform, onProgress);
    await chromiumResolver.cleanupOldChromium(cacheDir, CHROME_BUILD);
    return { ok: true, path: executable, source: "bundled-fallback" };
  } catch (error) {
    logger.logError("Could not download Chrome for Testing " + CHROME_BUILD + ": " + logger.formatError(error));
    return { ok: false, reason: chromiumResolver.isNetworkError(error) ? "network" : "download-failed" };
  }
}

function getOutputDir(filename: string, resource: vscode.Uri): string | undefined {
  try {
    const outputDirectory = config()["outputDirectory"] || "";
    const root = vscode.workspace.getWorkspaceFolder(resource);
    const result = utils.resolveOutputDir(
      filename,
      outputDirectory,
      config()["outputDirectoryRelativePathFile"],
      resource.fsPath,
      root ? root.uri.fsPath : undefined,
    );
    if (result === null) {
      reportError({
        operation: "The output directory does not exist: " + outputDirectory,
        where: "getOutputDir()",
        action: { kind: "settings", query: "@id:poly.markdownPdf.outputDirectory", label: "Open Settings" },
      });
      return;
    }
    if (outputDirectory.indexOf("~") === 0) {
      fs.mkdirSync(outputDirectory.replace(/^~/, os.homedir()), { recursive: true });
    } else if (outputDirectory.length > 0 && !path.isAbsolute(outputDirectory)) {
      fs.mkdirSync(path.dirname(result), { recursive: true });
    }
    return result;
  } catch (error) {
    reportError({ operation: EXPORT_FAILED_MSG, where: "getOutputDir()", error });
  }
}

function readStyles(uri: vscode.Uri, htmlBody: string): string | undefined {
  try {
    let style = utils.buildStyleTags({
      includeDefaultStyles: config()["includeDefaultStyles"],
      highlight: config()["highlight"],
      highlightStyle: config()["highlightStyle"] || "",
      markdownStyles: vscode.workspace.getConfiguration("markdown")["styles"] || [],
      markdownPdfStyles: config()["styles"] || "",
      baseDir: ROOT,
      onMissingHighlightStyle: function(requestedStyle: string, resolvedStyle: string) {
        vscode.window.showWarningMessage(
          "The configured poly.markdownPdf.highlightStyle \"" + requestedStyle
            + "\" is no longer supported. Falling back to \"" + resolvedStyle + "\".",
        );
      },
      resolveHrefFn: function(href: string) {
        return fixHref(uri, href) || "";
      },
    }) || "";

    // Inline KaTeX CSS with data: URI fonts only when the body actually
    // contains KaTeX output. This keeps unrelated documents small.
    if (htmlBody.includes("class=\"katex")) {
      style += utils.buildKatexStyleTag(ROOT);
    }
    return style;
  } catch (error) {
    reportError({ operation: EXPORT_FAILED_MSG, where: "readStyles()", error });
  }
}

/*
 * vscode/extensions/markdown-language-features/src/features/previewContentProvider.ts fixHref()
 * https://github.com/Microsoft/vscode/blob/0c47c04e85bc604288a288422f0a7db69302a323/extensions/markdown-language-features/src/features/previewContentProvider.ts#L95
 */
function fixHref(resource: vscode.Uri, href: string): string | undefined {
  try {
    if (!href) {
      return href;
    }
    // Use href if it is already an URL
    const hrefUri = vscode.Uri.parse(href);
    if (["http", "https"].indexOf(hrefUri.scheme) >= 0) {
      return hrefUri.toString();
    }
    const root = vscode.workspace.getWorkspaceFolder(resource);
    return utils.resolveHref(
      href,
      resource.fsPath,
      config()["stylesRelativePathFile"],
      root ? root.uri.fsPath : undefined,
    ) ?? undefined;
  } catch (error) {
    reportError({ operation: EXPORT_FAILED_MSG, where: "fixHref()", error });
  }
}

// Action label that reveals the diagnostics log; selecting it shows the output channel.
const SHOW_DETAILS_ACTION = "Show Details";

const EXPORT_FAILED_MSG = "Markdown PDF: export failed. The file was not generated.";
const AUTO_DOWNLOAD_DISABLED_MSG = "Chromium not found. Automatic download is disabled "
  + "(poly.markdownPdf.chromium.autoDownload = false). Install Google Chrome / Chromium / Microsoft Edge, "
  + "set poly.markdownPdf.executablePath, or enable poly.markdownPdf.chromium.autoDownload.";

interface ErrorReport {
  operation: string; // toast text (human-readable "what failed")
  where?: string; // internal function name, log only (e.g. 'exportPdf()')
  error?: unknown; // log only: message + stack via formatError
  context?: string; // log only: buildContextSummary(ctx, homeDir)
  classify?: boolean; // when true, derive a hint + action from error
  action?: diagnostics.ErrorActionSpec; // explicit action (takes precedence over classified)
}

function runErrorAction(action: diagnostics.ErrorActionSpec): void {
  if (action.kind === "settings") {
    vscode.commands.executeCommand("workbench.action.openSettings", action.query);
  } else {
    vscode.env.openExternal(vscode.Uri.parse(action.url));
  }
}

// Present an error: a human-readable toast (operation + optional hint) plus a
// "Show Details" button that reveals the full log. The raw error message is
// never shown in the toast -- only in the log.
function reportError(r: ErrorReport): void {
  const classified = r.classify && r.error !== undefined ? diagnostics.classifyError(r.error) : undefined;
  const hint = classified?.hint;
  const action = r.action ?? classified?.action;
  logger.logError(r.operation);
  if (r.where) logger.logError(r.where);
  if (r.context) logger.logError(r.context);
  if (hint) logger.logError("Hint: " + hint);
  if (r.error !== undefined) logger.logError(logger.formatError(r.error));

  let toast = "ERROR: " + r.operation;
  if (hint) {
    toast += " — " + hint;
  }
  const buttons = action ? [action.label, SHOW_DETAILS_ACTION] : [SHOW_DETAILS_ACTION];
  vscode.window.showErrorMessage(toast, ...buttons).then(function(selection) {
    if (action && selection === action.label) {
      runErrorAction(action);
    } else if (selection === SHOW_DETAILS_ACTION) {
      logger.showLog();
    }
  });
}

function notifySanitize(report: utils.SanitizeReport, mode: utils.SanitizeMode, isOnSave: boolean): void {
  if (report.removedElements.length === 0 && report.strippedAttributes.length === 0) {
    return;
  }
  // Always record details to the output channel (manual and on-save).
  logger.logWarn(utils.buildSanitizeLogDetail(report, mode));
  // Toast only on explicit/manual export to avoid spamming on convertOnSave.
  if (!isOnSave) {
    vscode.window.showWarningMessage(utils.buildSanitizeSummary(report), SHOW_DETAILS_ACTION).then(function(selection) {
      if (selection === SHOW_DETAILS_ACTION) {
        logger.showLog();
      }
    });
  }
}
