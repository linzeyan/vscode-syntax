/**
 * Picking one refactoring out of everything a language server offers.
 *
 * `editor.action.refactor` already exists and already works. What it does not
 * do is go straight to the one you meant: it opens a menu, the menu's contents
 * differ per language, and the entry you want is worded differently in every
 * server ("Extract into variable", "Extract to constant in enclosing scope",
 * "Extract subexpression to variable"). A keybinding cannot land on any of
 * those, so the gesture is always at least three keystrokes and a read.
 *
 * poly computes no refactoring here. It asks the editor for code actions of a
 * standard kind, decides which of the answers is the one the command's name
 * promised, and applies it. The deciding is this file, and it is the only part
 * worth testing.
 */

/** Which of the two commands is asking. */
export type Refactoring = "extract" | "inline";

/**
 * The standard `CodeActionKind` each command asks the providers for.
 *
 * These are the kinds the LSP specification names, so every server that
 * implements the refactoring at all tags it with one of them -- which is why
 * this works without knowing anything about the language.
 */
export const REFACTOR_KIND: Readonly<Record<Refactoring, string>> = {
  extract: "refactor.extract",
  inline: "refactor.inline",
};

/** As much of `vscode.CodeAction` as the choice below depends on. */
export interface Offered {
  readonly title: string;
  /** `vscode.CodeActionKind.value`; absent is legal and means "unclassified". */
  readonly kind?: string;
}

/**
 * Words that mean "and the thing it extracts to, or inlines, is a variable".
 *
 * Measured across the servers poly proxies plus the built-in TypeScript one:
 * gopls says "Extract variable", rust-analyzer "Extract into variable" and
 * "Inline variable", clangd "Extract subexpression to variable", TypeScript
 * "Extract to constant in enclosing scope". A constant counts -- TypeScript
 * has no other word for a local binding, and someone who asked for a variable
 * and got `const x = ...` got what they asked for.
 */
const VARIABLE = /\b(variable|constant|const|local)\b/i;

/** Sub-kinds that say the same thing the title does, when a server tags them. */
const VARIABLE_KIND = /\.(variable|constant)\b/i;

function aboutAVariable(one: Offered): boolean {
  return VARIABLE.test(one.title) || (one.kind !== undefined && VARIABLE_KIND.test(one.kind));
}

/**
 * The refactorings a "… Variable" command should offer, best first.
 *
 * Two filters, and the second one is the point. The kind filter is what the
 * editor was already asked for, repeated here because a provider may answer
 * with more than it was asked for. The variable filter is what makes the
 * command's name true: `refactor.extract` also covers "Extract function" and
 * "Extract method", and a command called Extract Variable that silently
 * extracts a function is worse than one that does nothing.
 *
 * If nothing mentions a variable, everything of the right kind is returned
 * rather than nothing. A server whose wording this file has never seen should
 * cost the user a menu, not the feature.
 */
export function refactorChoices<T extends Offered>(
  offered: readonly T[],
  want: Refactoring,
): T[] {
  const kind = REFACTOR_KIND[want];
  const ofKind = offered.filter(
    // Prefix, not equality: `refactor.extract.constant` is a `refactor.extract`
    // and the dot is what keeps `refactor.extractive` from being one.
    (one) => one.kind === kind || (one.kind?.startsWith(`${kind}.`) ?? false),
  );
  const variables = ofKind.filter(aboutAVariable);
  return variables.length > 0 ? variables : ofKind;
}
