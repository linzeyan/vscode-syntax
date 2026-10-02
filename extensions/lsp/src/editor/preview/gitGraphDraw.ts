/*!---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * One row of the Git History graph as an SVG: VS Code's Source Control Graph
 * drawing, ported from microsoft/vscode 1.140.0 (commit
 * 07f806f999227108933c2e30515b26eecc1fda74),
 * src/vs/workbench/contrib/scm/browser/scmHistory.ts --
 * renderSCMHistoryItemGraph and renderSCMHistoryGraphPlaceholder. The lanes
 * it draws are gitGraphLayout.ts's. MIT, under the copyright above.
 *
 * What changed in the port: rows are 24px rather than 22px, so the one
 * literal that stood for half a row less the curve's radius (`V 6`) is
 * written as that; the uncommitted changes are drawn as the outgoing changes
 * node is; a root keeps the lanes beside it (see gitGraphLayout.ts), so its
 * own lane is not counted as continuing below it; a row is as wide as its
 * circle too (graphColumnCount).
 */
import {
  asCssVariable,
  getHistoryItemColor,
  getHistoryItemIndex,
  type ISCMHistoryItemGraphNode,
  type ISCMHistoryItemViewModel,
} from "../gitGraphLayout";

export const SWIMLANE_HEIGHT = 24;
// Half a row, as VS Code's 11 is half its 22: the curves are quarter circles
// of this radius, and a circle's centre is this far down.
export const SWIMLANE_WIDTH = SWIMLANE_HEIGHT / 2;
const SWIMLANE_CURVE_RADIUS = 5;
const CIRCLE_RADIUS = 4;
const CIRCLE_STROKE_WIDTH = 2;

function createPath(colorIdentifier: string, strokeWidth = 1): SVGPathElement {
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke-width", `${strokeWidth}px`);
  path.setAttribute("stroke-linecap", "round");
  path.style.stroke = asCssVariable(colorIdentifier);

  return path;
}

function drawCircle(index: number, radius: number, strokeWidth: number, colorIdentifier?: string): SVGCircleElement {
  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  circle.setAttribute("cx", `${SWIMLANE_WIDTH * (index + 1)}`);
  circle.setAttribute("cy", `${SWIMLANE_WIDTH}`);
  circle.setAttribute("r", `${radius}`);

  circle.style.strokeWidth = `${strokeWidth}px`;
  if (colorIdentifier) {
    circle.style.fill = asCssVariable(colorIdentifier);
  }

  return circle;
}

// `radius` is unused in VS Code too (the ring is CIRCLE_RADIUS + 1); kept so
// the call sites match upstream's.
function drawDashedCircle(
  index: number,
  _radius: number,
  strokeWidth: number,
  colorIdentifier: string,
): SVGCircleElement {
  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  circle.setAttribute("cx", `${SWIMLANE_WIDTH * (index + 1)}`);
  circle.setAttribute("cy", `${SWIMLANE_WIDTH}`);
  circle.setAttribute("r", `${CIRCLE_RADIUS + 1}`);

  circle.style.stroke = asCssVariable(colorIdentifier);
  circle.style.strokeWidth = `${strokeWidth}px`;
  circle.style.strokeDasharray = "4,2";

  return circle;
}

function drawVerticalLine(x1: number, y1: number, y2: number, color: string, strokeWidth = 1): SVGPathElement {
  const path = createPath(color, strokeWidth);
  path.setAttribute("d", `M ${x1} ${y1} V ${y2}`);

  return path;
}

function findLastIndex(nodes: ISCMHistoryItemGraphNode[], id: string): number {
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (nodes[i].id === id) {
      return i;
    }
  }

  return -1;
}

/**
 * The lanes a row's drawing spans. VS Code counts the lanes in and out; a
 * root that starts no lane and is on none -- a one-commit orphan branch --
 * sits one past both, and would be cut in half.
 */
export function graphColumnCount(historyItemViewModel: ISCMHistoryItemViewModel): number {
  return Math.max(
    historyItemViewModel.inputSwimlanes.length,
    historyItemViewModel.outputSwimlanes.length,
    getHistoryItemIndex(historyItemViewModel) + 1,
  );
}

export function renderSCMHistoryItemGraph(historyItemViewModel: ISCMHistoryItemViewModel): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("graph");

  const historyItem = historyItemViewModel.historyItem;
  const inputSwimlanes = historyItemViewModel.inputSwimlanes;
  const outputSwimlanes = historyItemViewModel.outputSwimlanes;

  // Find the history item in the input swimlanes
  const inputIndex = inputSwimlanes.findIndex((node) => node.id === historyItem.id);

  // Circle index - use the input swimlane index if present, otherwise add it to the end
  const circleIndex = getHistoryItemIndex(historyItemViewModel);

  // Circle color - use the output swimlane color if present, otherwise the input swimlane color
  const circleColor = getHistoryItemColor(historyItemViewModel);

  let outputSwimlaneIndex = 0;
  for (let index = 0; index < inputSwimlanes.length; index++) {
    const color = inputSwimlanes[index].color;

    // Current commit
    if (inputSwimlanes[index].id === historyItem.id) {
      // Base commit
      if (index !== circleIndex) {
        const d: string[] = [];
        const path = createPath(color);

        // Draw /
        d.push(`M ${SWIMLANE_WIDTH * (index + 1)} 0`);
        d.push(`A ${SWIMLANE_WIDTH} ${SWIMLANE_WIDTH} 0 0 1 ${SWIMLANE_WIDTH * index} ${SWIMLANE_WIDTH}`);

        // Draw -
        d.push(`H ${SWIMLANE_WIDTH * (circleIndex + 1)}`);

        path.setAttribute("d", d.join(" "));
        svg.append(path);
      } else if (historyItem.parentIds.length > 0) {
        outputSwimlaneIndex++;
      }
    } else {
      // Not the current commit
      if (
        outputSwimlaneIndex < outputSwimlanes.length
        && inputSwimlanes[index].id === outputSwimlanes[outputSwimlaneIndex].id
      ) {
        if (index === outputSwimlaneIndex) {
          // Draw |
          const path = drawVerticalLine(SWIMLANE_WIDTH * (index + 1), 0, SWIMLANE_HEIGHT, color);
          svg.append(path);
        } else {
          const d: string[] = [];
          const path = createPath(color);

          // Draw |
          d.push(`M ${SWIMLANE_WIDTH * (index + 1)} 0`);
          d.push(`V ${SWIMLANE_HEIGHT / 2 - SWIMLANE_CURVE_RADIUS}`);

          // Draw /
          d.push(
            `A ${SWIMLANE_CURVE_RADIUS} ${SWIMLANE_CURVE_RADIUS} 0 0 1 ${
              (SWIMLANE_WIDTH * (index + 1)) - SWIMLANE_CURVE_RADIUS
            } ${SWIMLANE_HEIGHT / 2}`,
          );

          // Draw -
          d.push(`H ${(SWIMLANE_WIDTH * (outputSwimlaneIndex + 1)) + SWIMLANE_CURVE_RADIUS}`);

          // Draw /
          d.push(
            `A ${SWIMLANE_CURVE_RADIUS} ${SWIMLANE_CURVE_RADIUS} 0 0 0 ${SWIMLANE_WIDTH * (outputSwimlaneIndex + 1)} ${
              (SWIMLANE_HEIGHT / 2) + SWIMLANE_CURVE_RADIUS
            }`,
          );

          // Draw |
          d.push(`V ${SWIMLANE_HEIGHT}`);

          path.setAttribute("d", d.join(" "));
          svg.append(path);
        }

        outputSwimlaneIndex++;
      }
    }
  }

  // Add remaining parent(s)
  for (let i = 1; i < historyItem.parentIds.length; i++) {
    const parentOutputIndex = findLastIndex(outputSwimlanes, historyItem.parentIds[i]);
    if (parentOutputIndex === -1) {
      continue;
    }

    // Draw -\
    const d: string[] = [];
    const path = createPath(outputSwimlanes[parentOutputIndex].color);

    // Draw \
    d.push(`M ${SWIMLANE_WIDTH * parentOutputIndex} ${SWIMLANE_HEIGHT / 2}`);
    d.push(
      `A ${SWIMLANE_WIDTH} ${SWIMLANE_WIDTH} 0 0 1 ${SWIMLANE_WIDTH * (parentOutputIndex + 1)} ${SWIMLANE_HEIGHT}`,
    );

    // Draw -
    d.push(`M ${SWIMLANE_WIDTH * parentOutputIndex} ${SWIMLANE_HEIGHT / 2}`);
    d.push(`H ${SWIMLANE_WIDTH * (circleIndex + 1)} `);

    path.setAttribute("d", d.join(" "));
    svg.append(path);
  }

  // Draw | to *
  if (inputIndex !== -1) {
    const path = drawVerticalLine(
      SWIMLANE_WIDTH * (circleIndex + 1),
      0,
      SWIMLANE_HEIGHT / 2,
      inputSwimlanes[inputIndex].color,
    );
    svg.append(path);
  }

  // Draw | from *
  if (historyItem.parentIds.length > 0) {
    const path = drawVerticalLine(
      SWIMLANE_WIDTH * (circleIndex + 1),
      SWIMLANE_HEIGHT / 2,
      SWIMLANE_HEIGHT,
      circleColor,
    );
    svg.append(path);
  }

  // Draw *
  if (historyItemViewModel.kind === "HEAD") {
    // HEAD
    const outerCircle = drawCircle(circleIndex, CIRCLE_RADIUS + 3, CIRCLE_STROKE_WIDTH, circleColor);
    svg.append(outerCircle);

    const innerCircle = drawCircle(circleIndex, CIRCLE_STROKE_WIDTH, CIRCLE_RADIUS);
    svg.append(innerCircle);
  } else if (historyItemViewModel.kind === "uncommitted-changes") {
    // Uncommitted changes, drawn as VS Code draws incoming/outgoing changes
    const outerCircle = drawCircle(circleIndex, CIRCLE_RADIUS + 3, CIRCLE_STROKE_WIDTH, circleColor);
    svg.append(outerCircle);

    const innerCircle = drawCircle(circleIndex, CIRCLE_RADIUS + 1, CIRCLE_STROKE_WIDTH + 1);
    svg.append(innerCircle);

    const dashedCircle = drawDashedCircle(circleIndex, CIRCLE_RADIUS + 1, CIRCLE_STROKE_WIDTH - 1, circleColor);
    svg.append(dashedCircle);
  } else {
    if (historyItem.parentIds.length > 1) {
      // Multi-parent node
      const circleOuter = drawCircle(circleIndex, CIRCLE_RADIUS + 2, CIRCLE_STROKE_WIDTH, circleColor);
      svg.append(circleOuter);

      const circleInner = drawCircle(circleIndex, CIRCLE_RADIUS - 1, CIRCLE_STROKE_WIDTH, circleColor);
      svg.append(circleInner);
    } else {
      // Node
      const circle = drawCircle(circleIndex, CIRCLE_RADIUS + 1, CIRCLE_STROKE_WIDTH, circleColor);
      svg.append(circle);
    }
  }

  // Set dimensions
  svg.style.height = `${SWIMLANE_HEIGHT}px`;
  svg.style.width = `${SWIMLANE_WIDTH * (graphColumnCount(historyItemViewModel) + 1)}px`;

  return svg;
}

export function renderSCMHistoryGraphPlaceholder(
  columns: ISCMHistoryItemGraphNode[],
  highlightIndex?: number,
): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.style.height = `${SWIMLANE_HEIGHT}px`;
  svg.style.width = `${SWIMLANE_WIDTH * (columns.length + 1)}px`;

  // Draw |
  for (let index = 0; index < columns.length; index++) {
    const strokeWidth = index === highlightIndex ? 3 : 1;
    const path = drawVerticalLine(SWIMLANE_WIDTH * (index + 1), 0, SWIMLANE_HEIGHT, columns[index].color, strokeWidth);
    svg.append(path);
  }

  return svg;
}
