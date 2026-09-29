// The packages Data Preview reads with that ship no types of their own.

declare module "hjson" {
  export function parse(text: string): unknown;
  export function stringify(value: unknown): string;
}

declare module "json-spread" {
  function jsonSpread(rows: unknown[]): Record<string, unknown>[];
  export = jsonSpread;
}

declare module "properties" {
  export function parse(text: string, options: { sections?: boolean; comments?: string[] } | null): unknown;
}
