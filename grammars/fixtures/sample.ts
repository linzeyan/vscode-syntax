// TypeScript fixture: type-level syntax, decorators, generics, enums.
import type { Readable } from "node:stream";

export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

export interface Cache<K extends string, V> {
  readonly size: number;
  get(key: K): V | undefined;
  set(key: K, value: V, ttlMs?: number): this;
}

export const enum Level {
  Debug = 0,
  Info = 1,
  Error = 2,
}

type Keys<T> = { [K in keyof T]-?: T[K] extends Function ? never : K }[keyof T];

function assertNever(x: never): never {
  throw new Error(`unexpected: ${String(x)}`);
}

export class MemoryCache<V> implements Cache<string, V> {
  private readonly store = new Map<string, { value: V; expires: number }>();

  constructor(private readonly clock: () => number = () => 0) {}

  get size(): number {
    return this.store.size;
  }

  get(key: string): V | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    return hit.expires > this.clock() ? hit.value : undefined;
  }

  set(key: string, value: V, ttlMs = 60_000): this {
    this.store.set(key, { value, expires: this.clock() + ttlMs });
    return this;
  }
}

/**
 * Read a stream to completion.
 * @param stream - source to drain
 * @returns the concatenated payload as UTF-8
 */
export async function drain(stream: Readable): Promise<Result<string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
  return { ok: true, value: Buffer.concat(chunks).toString("utf8") };
}

export function level(l: Level): string {
  switch (l) {
    case Level.Debug:
      return "debug";
    case Level.Info:
      return "info";
    case Level.Error:
      return "error";
    default:
      return assertNever(l);
  }
}

declare module "node:stream" {
  interface Readable {
    polyTag?: Keys<{ a: string }>;
  }
}
