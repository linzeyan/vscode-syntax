/**
 * DBML to SQL and back: the two commands matt-meyers.vscode-dbml offered.
 *
 * @dbml/core does the converting; this file names what it accepts and says
 * what went wrong in words a person can act on. It is bundled on its own
 * (`dist/dbml.js`) and loaded when a command runs, because the library is
 * megabytes of SQL parsers and the extension activates on every language poly
 * formats -- nobody should pay for it who never opens a .dbml file.
 *
 * No `vscode` import, so the node test runner can exercise it.
 */
import { exporter, importer } from "@dbml/core";

/**
 * Every dialect the pinned @dbml/core converts, as it spells them.
 *
 * A superset of the extension's (postgres, mysql, mssql out; postgres, mysql
 * in): it was pinned to @dbml/core 2.0.1, and its own source carries a TODO to
 * add mssql import back "when the importer works".
 */
export const TO_SQL = ["postgres", "mysql", "mssql", "oracle"] as const;
export const FROM_SQL = ["postgres", "mysql", "mssql", "snowflake", "oracle"] as const;

export type ToSql = (typeof TO_SQL)[number];
export type FromSql = (typeof FROM_SQL)[number];

export function toSql(dbml: string, dialect: ToSql): string {
  return exporter.export(dbml, dialect);
}

export function toDbml(sql: string, dialect: FromSql): string {
  return importer.import(sql, dialect);
}

/** The file the output goes to by default: same folder, other extension. */
export function outputPath(input: string, to: "sql" | "dbml"): string {
  const from = to === "sql" ? /\.dbml$/i : /\.sql$/i;
  return `${input.replace(from, "")}.${to}`;
}

interface Diag {
  message?: string;
  text?: string;
  location?: { start?: { line?: number; column?: number } };
}

/**
 * One line naming where the input stopped parsing.
 *
 * @dbml/core throws a bare `{ diags }` rather than an Error, so `String(e)`
 * would print `[object Object]`. The exporter calls the text `message`, the
 * importer calls it `text`.
 */
export function describe(error: unknown): string {
  const diags = (error as { diags?: Diag[] } | null)?.diags;
  const first = diags?.[0];
  if (!first) {
    return error instanceof Error ? error.message : String(error);
  }
  const text = first.message ?? first.text ?? "could not be parsed";
  const start = first.location?.start;
  return start?.line ? `line ${start.line}, column ${start.column ?? 1}: ${text}` : text;
}
