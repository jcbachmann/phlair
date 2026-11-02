// The structure of a remarkup list as Phorge renders it, so each item can
// be shown on its own, rendered, in the list it belongs to: its level, the
// tags of the lists around it and its place in them. A port of the item
// grouping, depth and tree building of PhutilRemarkupListBlockRule.
//
// Derived from Phabricator (Copyright Phacility, Inc., Apache License 2.0;
// see licenses/Phabricator-LICENSE.txt and Phabricator-NOTICE.txt), changed.

const START = /^\s*(?:[-*#]+|([1-9][0-9]*)[.)]|\[\D?\])\s+/;
const CONT = /^\s*(?:[-*#]+|[0-9]+[.)]|\[\D?\])\s+/;
const STRIP = /^\s*(?:[-*#]+|[0-9]+[.)])\s*/;
const MARK = /^\s*\[(\D?)\]\s*/;
// Like Phorge's limit, which keeps its recursion in bounds.
const MAX_LEVEL = 12;

export type ListTag = "ul" | "ol";

/** A list around an item: its tag and the item's place in it (phantom items count). */
export interface ListLevel {
  tag: ListTag;
  index: number;
  /** The number the list starts at (only the outermost one can start at another). */
  start: number;
  /** Whether the item at this level is a checklist item, checked or not; null for others and phantoms. */
  mark: boolean | null;
}

export interface ListItem {
  /** Its lines, as indexes of the block's lines: the item's line and the lines continuing it. */
  first: number;
  last: number;
  /** The lists from the outermost to the item's own; the level is their count minus one. */
  path: ListLevel[];
  /** A checklist item: checked or not; null for other items. */
  mark: boolean | null;
  /** Whether the list has checklist items (Phorge then styles all of its lists for them). */
  hasMarks: boolean;
  /** The item alone, as remarkup that renders as a list of only this item. */
  text: string;
}

interface Parsed {
  first: number;
  last: number;
  depth: number;
  style: "#" | "-";
  mark: boolean | null;
  content: string;
}

interface Node {
  item: Parsed | null;
  style: "#" | "-" | null;
  children: Node[];
}

/** The items of a list block, by its lines. Items without text are left out, as Phorge does. */
export function parseList(lines: string[]): ListItem[] {
  // Phorge unindents the item lines by their least indentation first.
  let pattern = START;
  let least = Infinity;
  lines.forEach((line) => {
    if (pattern.test(line)) {
      pattern = CONT;
      least = Math.min(least, /^\s*/.exec(line)![0].length);
    }
  });
  const unindented = lines.map((line) => line);
  pattern = START;
  lines.forEach((line, i) => {
    if (pattern.test(line)) {
      pattern = CONT;
      unindented[i] = line.slice(least === Infinity ? 0 : least);
    }
  });

  // Group the lines into items; the first number of an ordered list is where it starts.
  const groups: [number, number][] = [];
  let startsAt: number | null = null;
  pattern = START;
  unindented.forEach((line, i) => {
    const match = pattern.exec(line);
    if (match) {
      if (startsAt === null && match[1]) {
        startsAt = Number(match[1]);
      }
      pattern = CONT;
      groups.push([i, i]);
    } else if (groups.length) {
      groups[groups.length - 1][1] = i;
    } else {
      groups.push([i, i]);
    }
  });

  const items: Parsed[] = [];
  let hasMarks = false;
  for (const [first, last] of groups) {
    const raw = unindented.slice(first, last + 1).join("\n");
    const text = raw
      .replace(/ *(\n+) */g, "$1")
      .replace(/(?<!\n)\n(?!\n)/g, " ")
      .trimEnd();
    if (!text) {
      continue;
    }
    const repeated = /^\s*([-*#]{2,})/.exec(text);
    const indent = /^(\s+)/.exec(text);
    const depth = repeated ? repeated[1].length - 1 : indent ? indent[1].length : 0;
    const style = /^\s*(?:#|[0-9])/.test(text) ? "#" : "-";
    let content = raw.replace(STRIP, "");
    let mark: boolean | null = null;
    const box = MARK.exec(content);
    if (box) {
      mark = box[1].trim() !== "";
      hasMarks = true;
      content = content.slice(box[0].length);
    }
    // Continued lines without their indentation: indented text means nothing else in an item.
    content = content
      .split("\n")
      .map((line, i) => (i ? line.trimStart() : line))
      .join("\n");
    items.push({ first, last, depth, style, mark, content });
  }

  const tree = buildTree(items, 0, items.length, 0);
  adjustStyles(tree);
  const result: ListItem[] = [];
  const walk = (nodes: Node[], path: ListLevel[]) => {
    const tag: ListTag = nodes[0]?.style === "#" ? "ol" : "ul";
    const start = path.length === 0 ? (startsAt ?? 1) : 1;
    nodes.forEach((node, index) => {
      const own = [...path, { tag, index, start, mark: node.item?.mark ?? null }];
      if (node.item) {
        const { first, last, mark, content } = node.item;
        const box = mark === null ? "" : mark ? "[X] " : "[ ] ";
        result.push({ first, last, path: own, mark, hasMarks, text: `- ${box}${content}` });
      }
      if (node.children.length) {
        walk(node.children, own);
      }
    });
  };
  walk(tree, []);
  return result;
}

/** Phorge's buildTree(): levels from depths, with phantom items where a list starts deeper. */
function buildTree(items: Parsed[], l: number, r: number, level: number): Node[] {
  if (l === r) {
    return [];
  }
  if (level > MAX_LEVEL) {
    return items.slice(l, r).map((item) => ({ item, style: item.style, children: [] }));
  }
  let min = l;
  for (let i = r - 1; i >= l; i--) {
    if (items[i].depth <= items[min].depth) {
      min = i;
    }
  }
  const minDepth = items[min].depth;
  const nodes: Node[] = [];
  if (min !== l) {
    nodes.push({ item: null, style: null, children: buildTree(items, l, min, level + 1) });
  }
  let last = min;
  for (let i = last + 1; i < r; i++) {
    if (items[i].depth === minDepth) {
      nodes.push({ item: items[last], style: items[last].style, children: buildTree(items, last + 1, i, level + 1) });
      last = i;
    }
  }
  nodes.push({ item: items[last], style: items[last].style, children: buildTree(items, last + 1, r, level + 1) });
  return nodes;
}

/** Phantom items take the style of the next item of their list. */
function adjustStyles(nodes: Node[]): void {
  let style: "#" | "-" = "-";
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (nodes[i].style !== null) {
      style = nodes[i].style!;
    } else {
      nodes[i].style = style;
    }
    adjustStyles(nodes[i].children);
  }
}
