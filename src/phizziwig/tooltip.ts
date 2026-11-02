// Phorge's tooltips for the buttons this editor adds.
//
// Phorge's own buttons get their tooltips from JX.Tooltip, which reads
// the text from Javelin's data store; an extension can not put data there.
// This builds the same markup as JX.Tooltip.show(), so Phorge's CSS
// styles it the same, and positions it the same way.
//
// Derived from Phabricator (Copyright Phacility, Inc., Apache License 2.0;
// see licenses/Phabricator-LICENSE.txt and Phabricator-NOTICE.txt), changed.

let current: HTMLElement | null = null;
let lastHidden = 0;

function hide(): void {
  if (current) {
    current.remove();
    current = null;
    lastHidden = Date.now();
  }
}

type Align = "N" | "E" | "S" | "W";

/** Page position of the tip for an alignment, see JX.Tooltip._proposePosition(). */
function propose(align: Align, t: DOMRect, n: DOMRect): { left: number; top: number } {
  const x = t.left + window.scrollX;
  const y = t.top + window.scrollY;
  switch (align) {
    case "N":
      return { left: Math.trunc(x - (n.width - t.width) / 2), top: Math.trunc(y - n.height) };
    case "E":
      return { left: Math.trunc(x + t.width), top: Math.trunc(y - (n.height - t.height) / 2) };
    case "S":
      return { left: Math.trunc(x - (n.width - t.width) / 2), top: Math.trunc(y + t.height + 5) };
    case "W":
      return { left: Math.trunc(x - n.width - 5), top: Math.trunc(y - (n.height - t.height) / 2) };
  }
}

/**
 * Like JX.Tooltip._getSmartPosition(): above the target, else the first of
 * below, right and left that keeps the tip 16px inside the window.
 */
function place(target: HTMLElement, node: HTMLElement): { left: number; top: number; align: Align } {
  const t = target.getBoundingClientRect();
  const n = node.getBoundingClientRect();
  const margin = 16;
  const fits = ({ left, top }: { left: number; top: number }) =>
    left >= window.scrollX + margin &&
    top >= window.scrollY + margin &&
    left + n.width <= window.scrollX + window.innerWidth - margin &&
    top + n.height <= window.scrollY + window.innerHeight - margin;
  for (const align of ["N", "S", "E", "W"] as const) {
    const position = propose(align, t, n);
    if (fits(position)) {
      return { ...position, align };
    }
  }
  return { ...propose("N", t, n), align: "N" };
}

function show(target: HTMLElement, text: string): void {
  hide();
  const node = document.createElement("div");
  node.className = "jx-tooltip-container";
  node.style.maxWidth = "160px";
  const inner = document.createElement("div");
  inner.className = "jx-tooltip-inner";
  const tip = document.createElement("div");
  tip.className = "jx-tooltip";
  tip.textContent = text;
  const anchor = document.createElement("div");
  anchor.className = "jx-tooltip-anchor";
  inner.append(tip, anchor);
  node.append(inner);
  // Measure offscreen first, like JX.Tooltip.
  node.style.left = "-10000px";
  document.body.append(node);

  const { left, top, align } = place(target, node);
  node.style.left = `${left}px`;
  node.style.top = `${top}px`;
  node.classList.add(`jx-tooltip-align-${align}`);
  // Fade in unless a tip was shown just before, like JX.Tooltip.
  if (Date.now() - lastHidden >= 500) {
    node.classList.add("jx-tooltip-appear");
  }
  current = node;
}

/**
 * Shows Phorge's tooltip with the text when the mouse is over the
 * element. Returns a function that removes it again.
 */
export function addTooltip(element: HTMLElement, text: string): () => void {
  element.setAttribute("aria-label", text);
  // The label may change later, e.g. with the mode a button toggles.
  const over = () => show(element, element.getAttribute("aria-label") ?? text);
  element.addEventListener("mouseover", over);
  element.addEventListener("mouseout", hide);
  // Like Phorge: clicking or typing hides the tip.
  element.addEventListener("mouseup", hide);
  return () => {
    element.removeEventListener("mouseover", over);
    element.removeEventListener("mouseout", hide);
    element.removeEventListener("mouseup", hide);
    hide();
  };
}

document.addEventListener("keydown", hide, true);
