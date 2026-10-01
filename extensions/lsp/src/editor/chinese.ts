/**
 * Simplified and Traditional Chinese, both ways: the four commands
 * cipchk.zh-hans-tt-hant-vscode offered.
 *
 * OpenCC rather than the character table that extension carried, because the
 * conversion is a matter of words as well as of characters: 软件 is 軟件
 * character for character but 軟體 in Taiwan, and only a phrase dictionary
 * knows that. The two pairs keep the extension's split -- the plain pair
 * changes characters, the Taiwan pair rewrites vocabulary as well.
 *
 * Taiwan's character forms in both pairs (裡, 著). OpenCC's own "traditional"
 * writes 裏 and 着, forms nobody writing Traditional Chinese in Taiwan uses, and
 * the extension's plain pair never produced them either.
 *
 * Bundled on its own (`dist/chinese.js`) and loaded when a command runs: the
 * dictionaries are a megabyte, and the extension activates on every language
 * poly formats. No `vscode` import, so the node test runner can exercise it.
 */
// `require` and a type written here, because opencc-js ships ESM typings only,
// which a CommonJS module may not import -- but its `require` entry is a UMD
// build, and that is what esbuild bundles and the test runner loads.
const { Converter } = require("opencc-js") as {
  Converter(options: { from: string; to: string }): (text: string) => string;
};

/** Each conversion, keyed by the command it backs (`poly.<key>`). */
export const CONVERSIONS = {
  toTraditionalChinese: { from: "cn", to: "tw" },
  toSimplifiedChinese: { from: "tw", to: "cn" },
  toTraditionalChineseTaiwan: { from: "cn", to: "twp" },
  toSimplifiedChineseTaiwan: { from: "twp", to: "cn" },
} as const;

export type Conversion = keyof typeof CONVERSIONS;

// Building one parses its dictionaries, so each is built once, when first used.
const converters = new Map<Conversion, (text: string) => string>();

export function convert(conversion: Conversion, text: string): string {
  let converter = converters.get(conversion);
  if (!converter) {
    converter = Converter(CONVERSIONS[conversion]);
    converters.set(conversion, converter);
  }
  return converter(text);
}
