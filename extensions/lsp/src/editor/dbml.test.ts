import * as assert from "node:assert/strict";
import { test } from "node:test";

import { describe, FROM_SQL, outputPath, TO_SQL, toDbml, toSql } from "./dbml";

const SCHEMA = [
  "Table users {",
  "  id int [pk]",
  "  name varchar",
  "}",
  "",
  "Table posts {",
  "  id int [pk]",
  "  user_id int [ref: > users.id]",
  "}",
  "",
].join("\n");

test("every dialect the quick pick offers converts", () => {
  // The lists are what the user picks from, so one the library stopped
  // accepting would be a menu item that always fails.
  for (const dialect of TO_SQL) {
    assert.match(toSql(SCHEMA, dialect), /CREATE TABLE/i, dialect);
  }
  for (const dialect of FROM_SQL) {
    assert.match(toDbml("CREATE TABLE users (id int PRIMARY KEY);", dialect), /Table "?users"?/, dialect);
  }
});

test("what To SQL writes, From SQL reads back", () => {
  const sql = toSql(SCHEMA, "postgres");
  const back = toDbml(sql, "postgres");
  assert.match(back, /Table "users"/);
  assert.match(back, /Table "posts"/);
  // The relationship is the part a lossy converter drops first. Compared as
  // the SQL it turns back into, since how the DBML spells it is the library's
  // business: 10.x writes `"users"."id" ?<? "posts"."user_id"`, 2.x `<`.
  assert.match(sql, /FOREIGN KEY \("user_id"\) REFERENCES "users" \("id"\)/);
  assert.equal(toSql(back, "postgres"), sql);
});

test("a DBML error says where, so the file can be fixed", () => {
  let thrown: unknown;
  try {
    toSql("Table users {\n  id int [pk\n}\n", "postgres");
  } catch (error) {
    thrown = error;
  }
  assert.match(describe(thrown), /^line 3, column 1: \S/);
});

test("a SQL error says where too, though the importer names the field differently", () => {
  let thrown: unknown;
  try {
    toDbml("CREATE TABLE users (id int PRIMARY KEY,,);", "postgres");
  } catch (error) {
    thrown = error;
  }
  assert.match(describe(thrown), /^line 1, column \d+: \S/);
});

test("an ordinary error keeps its message rather than becoming [object Object]", () => {
  assert.equal(describe(new Error("boom")), "boom");
  assert.equal(describe("plain"), "plain");
});

test("the output lands beside the input with the other extension", () => {
  assert.equal(outputPath("/w/schema.dbml", "sql"), "/w/schema.sql");
  assert.equal(outputPath("/w/schema.DBML", "sql"), "/w/schema.sql");
  assert.equal(outputPath("/w/dump.sql", "dbml"), "/w/dump.dbml");
  assert.equal(outputPath("/w/untitled", "dbml"), "/w/untitled.dbml");
});
