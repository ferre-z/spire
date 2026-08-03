import type { CSSProperties } from "react";

export const CANVAS_TOKENS = {
  nodeWidth: 212,
  nodeHeight: 112,
  minimapWidth: 148,
  groupPadding: 32,
  groupHeaderHeight: 40,
  collapsedGroupWidth: 212,
  collapsedGroupHeight: 40,
  edgeLabelPaddingBlock: 4,
  edgeLabelPaddingInline: 7,
  edgeLabelRadius: 4,
  motionDurationMs: 120,
  selectionOutlineWidth: 2,
  selectionOutlineOffset: 2,
  handleBorderWidth: 2,
  fitPadding: 0.2,
  minZoom: 0.55,
  maxZoom: 1.6,
  gridGap: 22,
  gridDotSize: 1,
  markerSize: 16,
  edgeWidthIdle: 1.25,
  edgeWidthExecuting: 2,
} as const;

type CanvasCssVariable =
  | "--canvas-node-width"
  | "--canvas-node-height"
  | "--canvas-minimap-width"
  | "--canvas-group-padding"
  | "--canvas-group-header-height"
  | "--canvas-edge-label-padding-block"
  | "--canvas-edge-label-padding-inline"
  | "--canvas-edge-label-radius"
  | "--canvas-motion-duration"
  | "--canvas-selection-outline-width"
  | "--canvas-selection-outline-offset"
  | "--canvas-handle-border-width";

type CanvasCssProperties = CSSProperties
  & Readonly<Record<CanvasCssVariable, string>>;

const pixels = (value: number): string => `${value}px`;

export const CANVAS_CSS_VARIABLES: CanvasCssProperties = {
  "--canvas-node-width": pixels(CANVAS_TOKENS.nodeWidth),
  "--canvas-node-height": pixels(CANVAS_TOKENS.nodeHeight),
  "--canvas-minimap-width": pixels(CANVAS_TOKENS.minimapWidth),
  "--canvas-group-padding": pixels(CANVAS_TOKENS.groupPadding),
  "--canvas-group-header-height": pixels(CANVAS_TOKENS.groupHeaderHeight),
  "--canvas-edge-label-padding-block": pixels(CANVAS_TOKENS.edgeLabelPaddingBlock),
  "--canvas-edge-label-padding-inline": pixels(CANVAS_TOKENS.edgeLabelPaddingInline),
  "--canvas-edge-label-radius": pixels(CANVAS_TOKENS.edgeLabelRadius),
  "--canvas-motion-duration": `${CANVAS_TOKENS.motionDurationMs}ms`,
  "--canvas-selection-outline-width": pixels(CANVAS_TOKENS.selectionOutlineWidth),
  "--canvas-selection-outline-offset": pixels(CANVAS_TOKENS.selectionOutlineOffset),
  "--canvas-handle-border-width": pixels(CANVAS_TOKENS.handleBorderWidth),
};
