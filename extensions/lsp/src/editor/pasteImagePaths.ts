/**
 * Where Paste Image puts the image and what it types into the editor: the half
 * of mushan.vscode-paste-image that is only strings (see pasteImage.ts). Kept
 * apart from `vscode` so the unit tests can load it.
 */
import moment from "moment";
import * as path from "path";

/** `poly.pasteImage.*`, as the manifest declares them. */
export interface Settings {
  path: string;
  basePath: string;
  forceUnixStyleSeparator: boolean;
  prefix: string;
  suffix: string;
  defaultName: string;
  namePrefix: string;
  nameSuffix: string;
  encodePath: "none" | "urlEncode" | "urlEncodeSpace";
  insertPattern: string;
  showFilePathConfirmInputBox: boolean;
  filePathConfirmInputBoxMode: "fullPath" | "onlyName";
}

/** The image syntax the pasted-into file's language gets. */
export type Markup = "markdown" | "asciidoc" | undefined;

/**
 * The settings' variables filled in. Each value goes in through a function:
 * upstream passed them as replacement strings, where a folder named `a$&b`
 * came out with the variable's own text in the middle of it.
 */
function fill(text: string, values: Record<string, string>): string {
  return text.replace(/\$\{(\w+)\}/g, (all, name: string) => (Object.hasOwn(values, name) ? values[name] : all));
}

/**
 * The settings as upstream uses them: an empty `path` or `defaultName` means
 * the default, and the file's variables are filled in -- into `defaultName`
 * as moment escapes, so that a file called `May.md` does not come out as a
 * month. Throws on a folder with a space at either end, which upstream also
 * refused rather than guess whether the space was meant.
 */
export function expand(raw: Settings, file: string, projectRoot: string): Settings {
  for (const key of ["path", "basePath"] as const) {
    if (raw[key] !== raw[key].trim()) {
      throw new Error(`poly.pasteImage.${key} is '${raw[key]}', with a space at an end. Remove it and paste again.`);
    }
  }
  const values: Record<string, string> = {
    projectRoot,
    currentFileDir: path.dirname(file),
    currentFileName: path.basename(file),
    currentFileNameWithoutExt: path.basename(file, path.extname(file)),
  };
  const escaped = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, `[${value}]`]));
  return {
    ...raw,
    path: fill(raw.path || "${currentFileDir}", values),
    basePath: fill(raw.basePath, values),
    defaultName: fill(raw.defaultName || "Y-MM-DD-HH-mm-ss", escaped),
    namePrefix: fill(raw.namePrefix, values),
    nameSuffix: fill(raw.nameSuffix, values),
    insertPattern: fill(raw.insertPattern, values),
  };
}

/** The image's file name: the selected text, or else the time in `defaultName`'s format. */
export function imageFileName(settings: Settings, selection: string, now: Date): string {
  return `${settings.namePrefix}${selection || moment(now).format(settings.defaultName)}${settings.nameSuffix}.png`;
}

/** Where an image of that name goes: `path` is from the pasted-into file's folder unless absolute. */
export function imagePath(settings: Settings, file: string, name: string): string {
  return path.isAbsolute(settings.path)
    ? path.join(settings.path, name)
    : path.join(path.dirname(file), settings.path, name);
}

/** upath's `toUnix`, half of the `normalize` upstream's `forceUnixStyleSeparator` calls. */
function toUnix(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

/** The text that goes into the editor for the image at `image`. */
export function insertion(settings: Settings, markup: Markup, image: string): string {
  let original = settings.basePath ? path.relative(settings.basePath, image) : image;
  if (settings.forceUnixStyleSeparator) original = toUnix(path.normalize(toUnix(original)));
  let filePath = `${settings.prefix}${original}${settings.suffix}`;
  if (settings.encodePath === "urlEncode") filePath = encodeURI(filePath);
  else if (settings.encodePath === "urlEncodeSpace") filePath = filePath.replace(/ /g, "%20");
  const [open, close] = markup === "markdown" ? ["![](", ")"] : markup === "asciidoc" ? ["image::", "[]"] : ["", ""];
  return fill(settings.insertPattern, {
    imageSyntaxPrefix: open,
    imageSyntaxSuffix: close,
    imageFilePath: filePath,
    imageOriginalFilePath: original,
    imageFileName: path.basename(original),
    imageFileNameWithoutExt: path.basename(original, path.extname(original)),
  });
}
