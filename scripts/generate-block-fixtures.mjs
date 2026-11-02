// Regenerates test/fixtures/blocks.json: random remarkup documents and
// Phorge's own test inputs, split into blocks by the real PHP engine in
// the dev container (dev/phorge). Run after changing the corpus.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const LINES = [
  "",
  " ",
  "  ",
  "text",
  "more text",
  "0",
  "  indented",
  "   deeper",
  "- item",
  "* item",
  "-",
  "- ",
  "# item",
  "## h",
  "# h",
  "#nospace",
  "1. item",
  "2) item",
  "0. item",
  "[ ] todo",
  "[X] done",
  "  - nested",
  "= H =",
  "== H ==",
  "===== H",
  "======",
  "Title",
  "---",
  "--",
  "***",
  "* * *",
  "___",
  "- - -",
  "```",
  "```lang=py",
  "```code```",
  "code```",
  "  ```",
  "%%%",
  "%%%x%%%",
  "x%%%",
  "%%% y",
  "> q",
  ">",
  "> > nested",
  ">>! In T1, @alice wrote:",
  "NOTE: x",
  "IMPORTANT: y",
  "WARNING: z",
  "(NOTE) x",
  "NOTE:",
  "Note: x",
  "| a | b |",
  "|---|---|",
  "  | c |",
  "|",
  "<table>",
  "<tr><td>x</td></tr>",
  "</table>",
  "cowsay {{{",
  "cowsay(cow=a) {{{ hi }}}",
  "}}}",
  "text }}}",
  "{F1}",
  "T1 and @alice",
];

let seed = 1;
function random(n) {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed % n;
}

const texts = JSON.parse(readFileSync(new URL("../test/fixtures/corpus.json", import.meta.url)));
for (let i = 0; i < 3000; i++) {
  const lines = [];
  const count = 1 + random(12);
  for (let j = 0; j < count; j++) {
    lines.push(LINES[random(LINES.length)]);
  }
  texts.push(lines.join("\n") + (random(2) ? "\n" : ""));
}

const output = execFileSync(
  "docker",
  ["compose", "exec", "-T", "phorge", "php", "/opt/remarkup-editor-test/split-blocks.php"],
  {
    cwd: new URL("../dev/phorge", import.meta.url),
    input: JSON.stringify(texts),
    maxBuffer: 1 << 28,
  },
);
writeFileSync(new URL("../test/fixtures/blocks.json", import.meta.url), output);
console.log(`Wrote ${JSON.parse(output).length} split texts.`);
