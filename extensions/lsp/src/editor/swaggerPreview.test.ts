import * as assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { isSpec, parse, schemaOf, start, stop, update, url } from "./swaggerPreview";

const dir = mkdtempSync(join(tmpdir(), "poly-swagger-"));
const api = join(dir, "api.yaml");
writeFileSync(join(dir, "pet.yaml"), "type: object\nproperties:\n  name:\n    type: string\n");

/** The events a page listening at `address` gets, one at a time. */
function listen(address: string) {
  const received: unknown[] = [];
  const waiting: ((spec: unknown) => void)[] = [];
  const request = http.get(address, (response) => {
    let buffer = "";
    response.setEncoding("utf8").on("data", (chunk: string) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const spec = JSON.parse(buffer.slice("data: ".length, end));
        buffer = buffer.slice(end + 2);
        const next = waiting.shift();
        if (next) next(spec);
        else received.push(spec);
      }
    });
  });
  return {
    next: () => received.length ? Promise.resolve(received.shift()) : new Promise((resolve) => waiting.push(resolve)),
    close: () => request.destroy(),
  };
}

// Hung up at once: an event stream answered where a 404 belongs never ends,
// and would hang the run rather than fail it.
const status = (address: string) =>
  new Promise<number | undefined>((resolve) =>
    http.get(address, (response) => {
      resolve(response.statusCode);
      response.destroy();
    })
  );

// The page and its events are only for the URLs poly hands out: upstream's
// hash of the path is something any page open in the browser can compute.
test("only a previewed file's token gets its spec", async (t) => {
  await start("127.0.0.1", 0);
  t.after(stop);
  await update(api, parse("swagger: '2.0'\ninfo: {title: t, version: '1'}\npaths: {}\n", "yaml"));
  const origin = new URL(url(api)).origin;
  assert.equal(await status(`${origin}/events/${"0".repeat(36)}`), 404);
  assert.equal(await status(`${origin}/node_modules/swagger-ui-dist/package.json`), 404);
  assert.equal(await status(`${origin}/node_modules/swagger-parser/package.json`), 404);
});

test("an open page gets each edit, with the files it refers to pulled in", async (t) => {
  await start("127.0.0.1", 0);
  t.after(stop);
  const spec = (title: string) =>
    parse(
      `swagger: '2.0'\ninfo: {title: ${title}, version: '1'}\npaths: {}\ndefinitions:\n  Pet: {$ref: './pet.yaml'}\n`,
      "yaml",
    );
  await update(api, spec("first"));
  const address = url(api).replace(/\/([^/]+)$/, "/events/$1");
  const page = listen(address);
  t.after(page.close);
  const first = await page.next() as { info: { title: string }; definitions: { Pet: unknown } };
  assert.equal(first.info.title, "first");
  assert.deepEqual(first.definitions.Pet, { type: "object", properties: { name: { type: "string" } } });
  await update(api, spec("second"));
  assert.equal((await page.next() as { info: { title: string } }).info.title, "second");
});

// Mid-edit, a $ref points nowhere far more often than the spec is finished;
// the page still shows the rest rather than going blank.
test("a spec whose $ref does not resolve is sent as it is", async (t) => {
  await start("127.0.0.1", 0);
  t.after(stop);
  const broken = {
    swagger: "2.0",
    info: { title: "t", version: "1" },
    paths: {},
    definitions: { Pet: { $ref: "./nowhere.yaml" } },
  };
  await update(api, broken);
  const page = listen(url(api).replace(/\/([^/]+)$/, "/events/$1"));
  t.after(page.close);
  assert.deepEqual(await page.next(), broken);
});

test("a port in use moves the preview to the next one, and a second start shares the first's", async (t) => {
  const taken = http.createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => taken.once("listening", resolve));
  t.after(() => taken.close());
  const port = (taken.address() as { port: number }).port;
  await Promise.all([start("127.0.0.1", port), start("127.0.0.1", port)]);
  t.after(stop);
  assert.equal(new URL(url(api)).port, String(port + 1));
});

test("specs are told apart the way upstream tells them", async () => {
  assert.equal(schemaOf("swagger: '2.0'"), "swaggerviewer:swagger");
  assert.equal(schemaOf("openapi: 3.1.0"), "swaggerviewer:openapi");
  assert.equal(schemaOf("openapi: 3.2.0"), null);
  assert.equal(schemaOf("name: poly"), null);
  const file = (name: string, text: string) => {
    writeFileSync(join(dir, name), text);
    return join(dir, name);
  };
  assert.equal(await isSpec(file("a.json", "{\"openapi\": \"3.0.3\"}")), true);
  assert.equal(await isSpec(file("b.yml", "swagger: '2.0'")), true);
  assert.equal(await isSpec(file("c.yaml", "openapi: 3.0")), false);
  assert.equal(await isSpec(file("d.json", "{")), false);
  assert.equal(parse("{", "json"), null);
  assert.equal(parse("a: 1", "typescript"), undefined);
  assert.deepEqual(parse("[1]", "plaintext"), [1]);
});
