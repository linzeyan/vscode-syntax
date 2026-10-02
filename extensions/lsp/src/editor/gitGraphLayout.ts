/*!---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The Git History graph's lanes and colours: VS Code's own Source Control
 * Graph, ported from microsoft/vscode 1.140.0 (commit
 * 07f806f999227108933c2e30515b26eecc1fda74),
 * src/vs/workbench/contrib/scm/browser/scmHistory.ts -- the swimlanes of
 * toISCMHistoryItemViewModelArray and the scmGraph.* colours. Its drawing is
 * preview/gitGraphDraw.ts. MIT, under the copyright above.
 *
 * Every row has the lanes that enter it from above (inputSwimlanes) and the
 * lanes that leave it below (outputSwimlanes), each a commit some line is
 * heading for and that line's colour; the page draws each row from those two
 * alone. Kept recognisably VS Code's, so what changed is listed here:
 *
 * - The workbench helpers it imports (deepClone, rot, registerColor,
 *   asCssVariable) are written out: a webview has none of them, and an editor
 *   older than the one that registered scmGraph.* has no such variables, so
 *   each carries its registered default as a fallback.
 * - Uncommitted changes take the place of VS Code's outgoing changes node:
 *   its colour, and its kind for the drawing.
 * - The checked-out commit carries a `HEAD` reference in the colour VS Code
 *   gives the current branch, whether or not a branch is checked out.
 * - A root commit keeps the lanes beside it. VS Code drops every lane at a
 *   root, since the graph it shows ends in one; with every branch listed a
 *   root can sit mid-graph -- an orphan branch, or a history merged in with
 *   --allow-unrelated-histories -- and the lanes passing it would stop dead.
 * - Incoming changes, reference sorting and hovers are left out: the page
 *   shows neither an upstream's incoming commits nor VS Code's hovers.
 * - The copyright header opens with `/*!` here and in gitGraphDraw.ts, which
 *   makes it a legal comment: esbuild keeps it in the minified page bundle.
 *
 * Pure, so the page and the unit tests run the same code.
 */
import { UNCOMMITTED } from "./gitGraphProtocol";

export type ColorIdentifier = string;

/** The default each colour is registered with, the fallback for an editor that does not know it. */
const colorDefaults = new Map<ColorIdentifier, string>();
function registerColor(id: ColorIdentifier, defaults: string): ColorIdentifier {
  colorDefaults.set(id, defaults);
  return id;
}

/** How a webview reaches a theme colour: the variable VSCode sets on the page for each one. */
export function asCssVariable(color: ColorIdentifier): string {
  return `var(--vscode-${color.replace(/\./g, "-")}, ${colorDefaults.get(color)})`;
}

/**
 * History item reference colors (local, remote, base)
 */
export const historyItemRefColor = registerColor("scmGraph.historyItemRefColor", "var(--vscode-charts-blue)");

/**
 * History graph color registry
 */
export const colorRegistry: ColorIdentifier[] = [
  registerColor("scmGraph.foreground1", "#FFB000"),
  registerColor("scmGraph.foreground2", "#DC267F"),
  registerColor("scmGraph.foreground3", "#994F00"),
  registerColor("scmGraph.foreground4", "#40B0A6"),
  registerColor("scmGraph.foreground5", "#B66DFF"),
];

export interface ISCMHistoryItem {
  id: string;
  parentIds: string[];
  references?: { id: string }[];
}

export interface ISCMHistoryItemGraphNode {
  /** The commit this lane is heading for. */
  id: string;
  color: ColorIdentifier;
}

export interface ISCMHistoryItemViewModel {
  historyItem: ISCMHistoryItem;
  kind: "HEAD" | "node" | "uncommitted-changes";
  inputSwimlanes: ISCMHistoryItemGraphNode[];
  outputSwimlanes: ISCMHistoryItemGraphNode[];
}

const rot = (index: number, modulo: number) => (modulo + (index % modulo)) % modulo;

function getLabelColorIdentifier(
  historyItem: ISCMHistoryItem,
  colorMap: Map<string, ColorIdentifier | undefined>,
): ColorIdentifier | undefined {
  if (historyItem.id === UNCOMMITTED) {
    return historyItemRefColor;
  } else {
    for (const ref of historyItem.references ?? []) {
      const colorIdentifier = colorMap.get(ref.id);
      if (colorIdentifier !== undefined) {
        return colorIdentifier;
      }
    }
  }

  return undefined;
}

export function toISCMHistoryItemViewModelArray(
  historyItems: ISCMHistoryItem[],
  colorMap = new Map<string, ColorIdentifier | undefined>(),
  currentHistoryItemRevision?: string,
): ISCMHistoryItemViewModel[] {
  let colorIndex = -1;
  const viewModels: ISCMHistoryItemViewModel[] = [];

  for (let index = 0; index < historyItems.length; index++) {
    const historyItem = historyItems[index];

    const kind = historyItem.id === UNCOMMITTED
      ? "uncommitted-changes"
      : historyItem.id === currentHistoryItemRevision
      ? "HEAD"
      : "node";
    const outputSwimlanesFromPreviousItem = viewModels.at(-1)?.outputSwimlanes ?? [];
    const inputSwimlanes = outputSwimlanesFromPreviousItem.map((i) => ({ ...i }));
    const outputSwimlanes: ISCMHistoryItemGraphNode[] = [];

    let firstParentAdded = false;

    // Add first parent to the output (and, for a root, only drop the lanes
    // that end here: see the header)
    for (const node of inputSwimlanes) {
      if (node.id === historyItem.id) {
        if (!firstParentAdded && historyItem.parentIds.length > 0) {
          outputSwimlanes.push({
            id: historyItem.parentIds[0],
            color: getLabelColorIdentifier(historyItem, colorMap) ?? node.color,
          });
          firstParentAdded = true;
        }

        continue;
      }

      outputSwimlanes.push({ ...node });
    }

    // Add unprocessed parent(s) to the output
    for (let i = firstParentAdded ? 1 : 0; i < historyItem.parentIds.length; i++) {
      // Color index (label -> next color)
      let colorIdentifier: string | undefined;

      if (i === 0) {
        colorIdentifier = getLabelColorIdentifier(historyItem, colorMap);
      } else {
        const historyItemParent = historyItems
          .find((h) => h.id === historyItem.parentIds[i]);
        colorIdentifier = historyItemParent ? getLabelColorIdentifier(historyItemParent, colorMap) : undefined;
      }

      if (!colorIdentifier) {
        colorIndex = rot(colorIndex + 1, colorRegistry.length);
        colorIdentifier = colorRegistry[colorIndex];
      }

      outputSwimlanes.push({
        id: historyItem.parentIds[i],
        color: colorIdentifier,
      });
    }

    viewModels.push({
      historyItem,
      kind,
      inputSwimlanes,
      outputSwimlanes,
    });
  }

  return viewModels;
}

export function getHistoryItemIndex(historyItemViewModel: ISCMHistoryItemViewModel): number {
  const historyItem = historyItemViewModel.historyItem;
  const inputSwimlanes = historyItemViewModel.inputSwimlanes;

  // Find the history item in the input swimlanes
  const inputIndex = inputSwimlanes.findIndex((node) => node.id === historyItem.id);

  // Circle index - use the input swimlane index if present, otherwise add it to the end
  return inputIndex !== -1 ? inputIndex : inputSwimlanes.length;
}

/**
 * The colour of a commit's circle, as renderSCMHistoryItemGraph picks it --
 * except that a root's is the lane it ends, since its output lane at that
 * index is now a lane passing beside it.
 */
export function getHistoryItemColor(historyItemViewModel: ISCMHistoryItemViewModel): ColorIdentifier {
  const { inputSwimlanes, outputSwimlanes } = historyItemViewModel;
  const circleIndex = getHistoryItemIndex(historyItemViewModel);

  // Circle color - use the output swimlane color if present, otherwise the input swimlane color
  return circleIndex < outputSwimlanes.length && historyItemViewModel.historyItem.parentIds.length > 0
    ? outputSwimlanes[circleIndex].color
    : circleIndex < inputSwimlanes.length
    ? inputSwimlanes[circleIndex].color
    : historyItemRefColor;
}

/**
 * poly's commits, newest first, as VS Code's history items. In first-parent
 * mode `git log` still names a merge's other parents; those it did not list
 * are left out, or each would hold a lane open to the bottom of the graph.
 */
export function layout(
  commits: readonly { hash: string; parents: string[] }[],
  firstParent: boolean,
  head?: string,
): ISCMHistoryItemViewModel[] {
  const listed = new Set(commits.map((commit) => commit.hash));
  return toISCMHistoryItemViewModelArray(
    commits.map((commit) => ({
      id: commit.hash,
      parentIds: firstParent
        ? commit.parents.filter((parent, index) => index === 0 || listed.has(parent))
        : commit.parents,
      references: commit.hash === head ? [{ id: "HEAD" }] : [],
    })),
    new Map([["HEAD", historyItemRefColor]]),
    head,
  );
}
