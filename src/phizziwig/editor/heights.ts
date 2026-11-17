// Heights of rendered blocks for CodeMirror's estimates of the ones not
// drawn yet (WidgetType.estimatedHeight): without one, it counts a block as
// one line high, and the text jumps when the block is drawn.

import { LruCache } from "../../cache";

/** About the height of a line of rendered text. */
export const LINE_HEIGHT = 20;

const MIN_HEIGHTS = 500;
const heights = new LruCache<string, number>(MIN_HEIGHTS);

/** Keeps the heights of at least twice as many blocks as a text has. */
export function fitHeightsCache(blockCount: number): void {
  heights.capacity = Math.max(heights.capacity, MIN_HEIGHTS, blockCount * 2);
}

/** Remembers the height of a block's DOM once it is laid out, by what it shows. */
export function rememberHeight(key: string, dom: HTMLElement): void {
  requestAnimationFrame(() => {
    if (dom.isConnected && dom.offsetHeight) {
      heights.set(key, dom.offsetHeight);
    }
  });
}

/** The height a block showing this had, or an estimate. */
export function knownHeight(key: string, estimate: number): number {
  return heights.get(key) ?? estimate;
}
