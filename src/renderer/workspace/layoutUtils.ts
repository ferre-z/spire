import type { JsonValue } from "../../shared/workspace";
import { PANE_META, isPaneId } from "./paneIds";

/**
 * Pure helpers over serialized FlexLayout models. These run before a model is
 * handed to FlexLayout, so they only rely on the JSON shape.
 */

type JsonObject = { [key: string]: JsonValue };

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function walkRows(node: JsonValue, visit: (tab: JsonObject) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walkRows(child, visit);
    return;
  }
  if (!isObject(node)) return;
  if (node.type === "tab") {
    visit(node);
    return;
  }
  if (Array.isArray(node.children)) walkRows(node.children, visit);
}

/** Every pane id currently present in the model, including popouts. */
export function collectPaneIds(model: unknown): Set<string> {
  const ids = new Set<string>();
  if (!isObject(model)) return ids;
  if (model.layout !== undefined) {
    walkRows(model.layout, (tab) => {
      if (typeof tab.id === "string") ids.add(tab.id);
    });
  }
  if (isObject(model.popouts)) {
    for (const popout of Object.values(model.popouts)) {
      if (isObject(popout) && popout.layout !== undefined) {
        walkRows(popout.layout, (tab) => {
          if (typeof tab.id === "string") ids.add(tab.id);
        });
      }
    }
  }
  return ids;
}

export type PopoutSanitizeOptions = {
  isWayland: boolean;
};

/**
 * Clamp popout window dimensions to the minimums of the panes they contain,
 * and drop the saved position on Wayland so the compositor picks it (only
 * the size is restored there). Returns a sanitized deep copy.
 */
export function sanitizePopoutRects(
  model: JsonValue,
  options: PopoutSanitizeOptions,
): JsonValue {
  const copy = JSON.parse(JSON.stringify(model)) as JsonValue;
  if (!isObject(copy) || !isObject(copy.popouts)) return copy;
  for (const popout of Object.values(copy.popouts)) {
    if (!isObject(popout) || !isObject(popout.rect)) continue;
    let minWidth = 0;
    let minHeight = 0;
    if (popout.layout !== undefined) {
      walkRows(popout.layout, (tab) => {
        if (isPaneId(tab.id)) {
          const meta = PANE_META[tab.id];
          minWidth = Math.max(minWidth, meta.popoutMinWidth);
          minHeight = Math.max(minHeight, meta.popoutMinHeight);
        }
      });
    }
    const rect = popout.rect;
    if (typeof rect.width === "number") {
      rect.width = Math.max(rect.width, minWidth);
    }
    if (typeof rect.height === "number") {
      rect.height = Math.max(rect.height, minHeight);
    }
    if (options.isWayland) {
      rect.x = 0;
      rect.y = 0;
    }
  }
  return copy;
}
