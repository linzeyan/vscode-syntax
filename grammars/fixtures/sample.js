// JavaScript fixture: JSDoc injection, regexp sub-grammar, template literal.
import { readFile } from "node:fs/promises";

/**
 * Count matches of a pattern.
 * @param {string} text - haystack
 * @param {RegExp} [re] - optional needle
 * @returns {Promise<number>}
 */
export async function countMatches(text, re = /\b[a-z]+(?:-\d{2,})?\b/gi) {
  const hits = [...text.matchAll(re)];
  const label = `found ${hits.length} match${hits.length === 1 ? "" : "es"}`;
  console.log(label);
  return hits.length;
}

class Counter extends Map {
  #total = 0n;

  add(key, n = 1) {
    this.#total += BigInt(n);
    this.set(key, (this.get(key) ?? 0) + n);
    return this;
  }

  get total() {
    return this.#total;
  }
}

const config = { retries: 3, timeout: 1_500, tags: ["a", "b"], nested: { on: true } };
const { retries, ...rest } = config;

for (const [k, v] of Object.entries(rest)) {
  if (typeof v === "object" && v !== null) continue;
  console.debug(k, v);
}

try {
  await readFile("missing.txt", "utf8");
} catch (err) {
  throw new Error(`read failed: ${err.message}`, { cause: err });
}

export default new Counter();
