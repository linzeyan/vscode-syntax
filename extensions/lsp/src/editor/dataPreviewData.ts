/**
 * The data half of RandomFractalsInc.vscode-data-preview 2.3.0: its data
 * providers, which read each format into what the page loads -- rows, CSV
 * text, or an Arrow file's own bytes -- and write what the page saves.
 *
 * Kept apart from `vscode` so the unit tests can load it, and bundled on its
 * own (`dist/dataPreview.js`): the readers are most of Data Preview's weight,
 * and dataPreview.ts loads them on the first preview.
 */
import { Table } from "apache-arrow";
import * as avro from "avsc";
import { existsSync, promises as fs } from "fs";
import * as hjson from "hjson";
import * as yaml from "js-yaml";
import jsonSpread = require("json-spread");
import JSON5 from "json5";
import { parse as parseJsonc, ParseError, printParseErrorCode } from "jsonc-parser";
import { ParquetReader } from "parquets";
import * as path from "path";
import * as properties from "properties";
import * as xlsx from "xlsx";

export interface ParseOptions {
  /** The sheet or Markdown table asked for; empty for the first. */
  dataTable: string;
  createJsonFiles: boolean;
  createJsonSchema: boolean;
}

export interface Loaded {
  /** Rows; CSV text, which the page parses itself; or an Arrow file's bytes. */
  data: unknown[] | string | Uint8Array;
  /** A workbook's sheets or a Markdown file's tables, when there is more than one. */
  tableNames: string[];
  /** Arrow's columns and their types. Upstream's parquet reader left it undefined, the rest null. */
  schema: Record<string, string> | null | undefined;
  /** What upstream showed as an error while still loading what it could. */
  errors: string[];
}

/** Upstream's extensions, anchored: its pattern matched `.md` inside `x.mdx` and `.config` in `vite.config.ts`. */
const SUPPORTED =
  /\.(json|jsonl|json5|hjson|ndjson|arrow|arr|avro|parquet|parq|config|env|properties|ini|yaml|yml|md|csv|tsv|txt|tab|dif|ods|xls|xlsb|xlsx|xlsm|xml|html)$/;
const BINARY = /\.(arrow|arr|avro|parquet|parq|dif|ods|xls|xlsb|xlsx|xlsm)$/;

/** Arrow's type names as Perspective's column types. */
const ARROW_TYPES: Record<string, string> = {
  Binary: "string",
  Bool: "boolean",
  Date: "date",
  Dictionary: "string",
  Float32: "float",
  Float64: "float",
  Int8: "integer",
  Int16: "integer",
  Int32: "integer",
  Int64: "integer",
  Timestamp: "datetime",
  Utf8: "string",
};

export const isRemote = (url: string) => url.startsWith("http://") || url.startsWith("https://");

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function read(dataUrl: string): Promise<Buffer> {
  if (isRemote(dataUrl)) {
    const response = await fetch(dataUrl);
    // The wording of superagent, upstream's HTTP client.
    if (!response.ok) throw new Error(response.statusText || "Unsuccessful HTTP response");
    return Buffer.from(await response.arrayBuffer());
  }
  return fs.readFile(dataUrl);
}

const readText = async (dataUrl: string) => (await read(dataUrl)).toString("utf8");

/** Beside `dataUrl`, with its extension swapped for `extension`. */
const beside = (dataUrl: string, extension: string) => dataUrl.slice(0, -path.extname(dataUrl).length) + extension;

/**
 * Writes `.json` or `.schema.json` beside the data, never over a file already
 * there, and nothing beside a URL: upstream tried that too, and failed quietly.
 */
async function createJsonFile(file: string, data: unknown, errors: string[]) {
  if (isRemote(file) || existsSync(file)) return;
  try {
    await fs.writeFile(file, JSON.stringify(data, null, 2));
  } catch {
    errors.push(`Failed to save file: ${file}`);
  }
}

/**
 * An object's leaves as strings, nested keys joined with `.` when
 * `preservePath`. Upstream kept only truthy values, so that `false`, `0` and
 * `""` had no row and no cell.
 */
export function flattenObject(obj: object, preservePath = false): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "object" && value !== null) {
      for (const [childKey, child] of Object.entries(flattenObject(value, preservePath))) {
        flat[preservePath ? `${key}.${childKey}` : childKey] = child;
      }
    } else if (value !== null && value !== undefined) {
      flat[key] = String(value);
    }
  }
  return flat;
}

/** An array as rows with nested fields spread into columns; an object as key/value rows. */
export function convertJsonData(data: unknown): unknown[] {
  if (Array.isArray(data)) return jsonSpread(data);
  if (typeof data !== "object" || data === null) return [];
  return Object.entries(flattenObject(data, true)).map(([key, value]) => ({ key, value }));
}

const loaded = (data: Loaded["data"], errors: string[], extra: Partial<Loaded> = {}): Loaded => ({
  data,
  tableNames: [],
  schema: null,
  errors,
  ...extra,
});

/** A text format parsed into rows, as upstream's JSON5, HJSON, YAML and properties providers do. */
async function parsed(dataUrl: string, parse: (text: string) => unknown): Promise<Loaded> {
  const errors: string[] = [];
  let data: unknown = [];
  try {
    data = parse(await readText(dataUrl));
  } catch (error) {
    errors.push(`Unable to parse data file: '${dataUrl}'. \n\t Error: ${message(error)}`);
  }
  return loaded(convertJsonData(data), errors);
}

async function json(dataUrl: string): Promise<Loaded> {
  const errors: string[] = [];
  let data: unknown = [];
  try {
    const parseErrors: ParseError[] = [];
    data = parseJsonc(await readText(dataUrl), parseErrors, { disallowComments: false, allowTrailingComma: true });
    if (parseErrors.length > 0) {
      const jsonErrors = parseErrors
        .map((error) => `${printParseErrorCode(error.error)} at ${error.offset} of ${error.length} length \n`)
        .join("");
      errors.push(`Invalid json data file: '${dataUrl}'. \n\t Error(s): \n ${jsonErrors}`);
    }
  } catch (error) {
    errors.push(`Unable to parse data file: '${dataUrl}'. \n\t Error: ${message(error)}`);
  }
  return loaded(convertJsonData(data), errors);
}

async function jsonLines(dataUrl: string): Promise<Loaded> {
  const errors: string[] = [];
  const data: unknown[] = [];
  let lineIndex = 1;
  try {
    for (const line of (await readText(dataUrl)).split("\n")) {
      if (line.trim().length > 0) data.push(JSON.parse(line.trim()));
      lineIndex++;
    }
  } catch (error) {
    // Upstream's message, down to the indentation its line continuation left in.
    errors.push(`Unable to parse data file: '${dataUrl}'.         \n\t Line #: ${lineIndex} Error: ${message(error)}`);
  }
  return loaded(convertJsonData(data), errors);
}

async function text(dataUrl: string): Promise<Loaded> {
  const errors: string[] = [];
  let data = "";
  try {
    data = await readText(dataUrl);
  } catch (error) {
    errors.push(`Unable to parse data file: '${dataUrl}'. \n\t Error: ${message(error)}`);
  }
  return loaded(data, errors);
}

/** Each Markdown table, named for its section, as CSV. */
export function markdownToCsv(markdown: string, dataTable: string): { csv: string; tableNames: string[] } {
  const sectionMarker = /(#)/g;
  const tableHeaderSeparator = /((\|)|(:)|(-)|(\s))+/g;
  const tableRowMarkdown = /((\|[^|\r\n]*)+\|(\r?\n|\r)?)/g;
  const tablesMap: Record<string, string[]> = {};
  let tableNames: string[] = [];
  for (const section of markdown.split("\n#")) {
    const sectionLines = section.split("\n");
    const sectionTitle = sectionLines[0].replace(sectionMarker, "").trim();
    // A block ends at a blank line; the section's last block, with no blank
    // line after it, is never looked at, as upstream.
    const textBlocks: string[] = [];
    let textBlock = "";
    for (const textLine of sectionLines) {
      if (textLine.trim().length === 0) {
        textBlocks.push(textBlock);
        textBlock = "";
      } else {
        textBlock += `${textLine}\n`;
      }
    }
    const tables = textBlocks.map((block) => block.match(tableRowMarkdown)).filter((rows) => rows !== null);
    tables.forEach((table, tableIndex) => {
      const tableRows: string[] = [];
      for (let row of table) {
        row = row.trim();
        if (row.startsWith("| ")) row = row.slice(2);
        if (row.endsWith(" |")) row = row.slice(0, row.length - 2);
        if (row.replace(tableHeaderSeparator, "").length !== 0 && row.length > 0) tableRows.push(row);
      }
      if (tableRows.length > 0) {
        const tableTitle = tables.length > 1 ? `${sectionTitle}-table-${tableIndex + 1}` : sectionTitle;
        tablesMap[tableTitle] = tableRows;
        tableNames.push(tableTitle);
      }
    });
  }
  const table = dataTable && dataTable.length > 0 ? tablesMap[dataTable] : tablesMap[tableNames[0]];
  if (tableNames.length === 1) tableNames = [];
  let csv = "";
  for (const row of table ?? []) {
    const cells = row.split(" | ").map((cell) => {
      cell = cell.trim();
      const hasQuotes = cell.includes("\"");
      if (hasQuotes) cell = cell.replace(/"/g, "\"\"");
      return hasQuotes || cell.includes(",") ? `"${cell}"` : cell;
    });
    csv += `${cells.join(",")}\n`;
  }
  return { csv, tableNames };
}

/** CSV as a Markdown table, the columns padded to line up, as upstream saves `.md`. */
export function csvToMarkdownTable(csvContent: string, delimiter = ",", hasTableHeaderRow = true): string {
  if (delimiter !== "\t") csvContent = csvContent.replace(/\t/g, "    ");
  const tableData: string[][] = [];
  const maxColumnLength: number[] = [];
  const cellRegExp = new RegExp(`${delimiter}(?![^"]*"\\B)`);
  csvContent.split("\n").forEach((row, rowIndex) => {
    tableData[rowIndex] = [];
    row.replace("\r", "").split(cellRegExp).forEach((cell, columnIndex) => {
      maxColumnLength[columnIndex] ??= 0;
      if (cell.startsWith("\"")) cell = cell.substring(1);
      if (cell.endsWith("\"")) cell = cell.substring(0, cell.length - 1);
      cell = cell.replace(/("")/g, "\"");
      maxColumnLength[columnIndex] = Math.max(maxColumnLength[columnIndex], cell.length);
      tableData[rowIndex][columnIndex] = cell;
    });
  });
  let tableHeader = "";
  let tableHeaderSeparator = "";
  for (const columnLength of maxColumnLength) {
    tableHeader += `|${" ".repeat(columnLength + 2)}`;
    tableHeaderSeparator += `|${"-".repeat(columnLength + 2)}`;
  }
  tableHeader += "| \n";
  tableHeaderSeparator += "| \n";
  if (hasTableHeaderRow) tableHeader = "";
  let tableRows = "";
  tableData.forEach((row, rowIndex) => {
    let line = "";
    maxColumnLength.forEach((columnLength, columnIndex) => {
      const cellData = row[columnIndex] ?? "";
      line += `| ${cellData}${" ".repeat(columnLength - cellData.length)} `;
    });
    line += "| \n";
    if (hasTableHeaderRow && rowIndex === 0) tableHeader += line;
    else tableRows += line;
  });
  return `${tableHeader}${tableHeaderSeparator}${tableRows}`;
}

async function markdown(dataUrl: string, options: ParseOptions): Promise<Loaded> {
  const errors: string[] = [];
  let csv = "";
  let tableNames: string[] = [];
  try {
    ({ csv, tableNames } = markdownToCsv(await readText(dataUrl), options.dataTable));
  } catch (error) {
    errors.push(`Unable to parse data file: '${dataUrl}'. \n\t Error: ${message(error)}`);
  }
  return loaded(csv, errors, { tableNames });
}

async function excel(dataUrl: string, options: ParseOptions): Promise<Loaded> {
  const errors: string[] = [];
  const workbook = xlsx.read(await read(dataUrl), { cellDates: true });
  let dataRows: unknown[] = [];
  let tableNames: string[] = [];
  if (workbook.SheetNames.length > 0) {
    if (workbook.SheetNames.length > 1) tableNames = workbook.SheetNames;
    const sheetName = options.dataTable.length > 0 && workbook.SheetNames.includes(options.dataTable)
      ? options.dataTable
      : workbook.SheetNames[0];
    dataRows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);
    if (options.createJsonFiles && BINARY.test(path.basename(dataUrl))) {
      let jsonFilePath = beside(dataUrl, ".json");
      if (options.dataTable.length > 0 && workbook.SheetNames.length > 1) {
        jsonFilePath = beside(dataUrl, `-${options.dataTable}.json`);
      }
      await createJsonFile(jsonFilePath, dataRows, errors);
    }
  }
  return loaded(dataRows, errors, { tableNames });
}

async function arrow(dataUrl: string, options: ParseOptions): Promise<Loaded> {
  const errors: string[] = [];
  const dataArray = new Uint8Array(await read(dataUrl));
  const dataTable = Table.from(dataArray);
  const schema: Record<string, string> = {};
  for (const field of dataTable.schema.fields) {
    const fieldType = field.type.toString();
    const at = fieldType.indexOf("<");
    schema[field.name] = ARROW_TYPES[at > 0 ? fieldType.substring(0, at) : fieldType];
  }
  if (options.createJsonSchema) await createJsonFile(beside(dataUrl, ".schema.json"), dataTable.schema, errors);
  if (options.createJsonFiles && !existsSync(beside(dataUrl, ".json"))) {
    const fields = dataTable.schema.fields.map((field) => field.name);
    const rows = Array.from(
      { length: dataTable.length },
      (_, i) => Object.fromEntries(fields.map((name, index) => [name, dataTable.getColumnAt(index)?.get(i)])),
    );
    await createJsonFile(beside(dataUrl, ".json"), rows, errors);
  }
  return loaded(dataArray, errors, { schema });
}

function avroData(dataUrl: string, options: ParseOptions): Promise<Loaded> {
  return new Promise((resolve, reject) => {
    const errors: string[] = [];
    const rows: object[] = [];
    let writing = Promise.resolve();
    avro.createFileDecoder(dataUrl)
      .on("metadata", (type: avro.Type) => {
        if (options.createJsonSchema) writing = createJsonFile(beside(dataUrl, ".schema.json"), type, errors);
      })
      .on("data", (row: object) => rows.push(row))
      .on("error", reject)
      .on("end", async () => {
        await writing;
        if (options.createJsonFiles) await createJsonFile(beside(dataUrl, ".json"), rows, errors);
        resolve(loaded(rows.map((row) => flattenObject(row)), errors));
      });
  });
}

async function parquet(dataUrl: string, options: ParseOptions): Promise<Loaded> {
  const errors: string[] = [];
  const reader = await ParquetReader.openFile(dataUrl);
  const cursor = reader.getCursor();
  const dataRows: unknown[] = [];
  for (let record = await cursor.next(); record; record = await cursor.next()) dataRows.push(record);
  await reader.close();
  if (options.createJsonFiles) await createJsonFile(beside(dataUrl, ".json"), dataRows, errors);
  return loaded(dataRows, errors, { schema: undefined });
}

const PROPERTIES: Record<string, { sections: boolean; comments?: string[] }> = {
  ".env": { sections: true, comments: ["#"] },
  // Some INI files take # for a comment.
  ".ini": { sections: true, comments: [";", "#"] },
  ".properties": { sections: true },
};

type Reader = (dataUrl: string, options: ParseOptions) => Promise<Loaded>;

const READERS: Record<string, Reader> = {
  ".avro": avroData,
  ".arr": arrow,
  ".arrow": arrow,
  ".hjson": (url) => parsed(url, hjson.parse),
  ".config": json,
  ".json": json,
  ".json5": (url) => parsed(url, JSON5.parse),
  ".jsonl": jsonLines,
  ".ndjson": jsonLines,
  ".md": markdown,
  ".parq": parquet,
  ".parquet": parquet,
  ".csv": text,
  ".tsv": text,
  ".txt": text,
  ".tab": text,
  ".yaml": (url) => parsed(url, (content) => yaml.load(content)),
  ".yml": (url) => parsed(url, (content) => yaml.load(content)),
};
for (const extension of Object.keys(PROPERTIES)) {
  READERS[extension] = (url) => parsed(url, (content) => properties.parse(content, PROPERTIES[extension]));
}
for (const extension of [".dif", ".ods", ".xls", ".xlsb", ".xlsm", ".xlsx", ".xml", ".html"]) {
  READERS[extension] = excel;
}

/** Local path or http(s) URL; upstream reads anything it does not know as JSON. */
export function getData(dataUrl: string, options: ParseOptions): Promise<Loaded> {
  if (!isRemote(dataUrl) && !SUPPORTED.test(path.basename(dataUrl))) {
    return Promise.resolve(loaded([], [`${dataUrl} is not a supported data file for Data Preview!`]));
  }
  return (READERS[path.extname(path.basename(dataUrl))] ?? json)(dataUrl, options);
}

/** What `saveData` would not write, with the reason for the user. */
export class NotSaved extends Error {}

const BOOK_TYPES: Record<string, xlsx.BookType> = {
  ".html": "html",
  ".ods": "ods",
  ".xml": "xlml",
  ".xlsb": "xlsb",
  ".xlsx": "xlsx",
};

/** The file's content for what the page posted: text, rows, or Arrow's bytes. */
function serialize(extension: string, fileData: unknown, tableName: string): string | Buffer | undefined {
  switch (extension) {
    case ".arr":
    case ".arrow":
    case ".parq":
    case ".parquet":
      return Buffer.from(fileData as number[]);
    case ".avro":
      // Upstream's Avro provider writes nothing, and the page offers no Avro.
      return undefined;
    case ".csv":
    case ".tsv":
    case ".txt":
    case ".tab":
      return fileData as string;
    case ".md":
      return csvToMarkdownTable(fileData as string);
    case ".hjson":
      return hjson.stringify(fileData);
    case ".json5":
      return JSON5.stringify(fileData, null, 2);
    case ".yaml":
    case ".yml":
      return yaml.dump(fileData, { skipInvalid: true });
    case ".env":
    case ".ini":
    case ".properties": {
      const rows = fileData as Record<string, unknown>[];
      if (!(rows.length > 0 && Object.hasOwn(rows[0], "key") && Object.hasOwn(rows[0], "value"))) {
        throw new NotSaved(
          "Data loaded in Preview is not a Properties collection. Use other data formats to Save this data.",
        );
      }
      // A value's line breaks become continuation lines.
      return rows.map((row) => `${row.key}=${row.value}`.replace(/\n/g, "\\\n") + "\n").join("");
    }
    case ".dif":
    case ".ods":
    case ".xls":
    case ".xlsb":
    case ".xlsm":
    case ".xlsx":
    case ".xml":
    case ".html": {
      const workbook = xlsx.utils.book_new();
      xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet(fileData as object[]), tableName);
      // Upstream asked for a string for html and xml, but compared the
      // extension without its dot, so every type went out as a buffer.
      return xlsx.write(workbook, { type: "buffer", compression: true, bookType: BOOK_TYPES[extension] ?? "xlsb" });
    }
    default:
      return JSON.stringify(fileData, null, 2);
  }
}

/** Writes what the page posted to `filePath`, in the format its extension names; false when there was nothing to write. */
export async function saveData(filePath: string, fileData: unknown, tableName: string): Promise<boolean> {
  const content = serialize(path.extname(filePath), fileData, tableName);
  if (content === undefined || content.length === 0) return false;
  await fs.writeFile(filePath, content);
  return true;
}
