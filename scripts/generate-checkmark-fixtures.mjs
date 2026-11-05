// Regenerates test/fixtures/checkmarks.json: texts with checklists, and
// which checkboxes the PHP engine in the dev container (dev/phorge) renders
// for them. Run after changing the corpus.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const CASES = [
  "- [ ] one\n- [x] two\n- [X] three",
  "[ ] alone\n[x] done",
  "- [] empty\n- [-] dash\n- [1] digit",
  "  - [ ] indented\n    - [x] nested\n  - plain\n  - [ ] last",
  "# [ ] numbered\n# [x] numbered done",
  "1. [ ] one\n2) [x] two",
  "* [ ] star\n** [x] deeper",
  "Text before.\n\n- [ ] item\n\nText after with [ ] brackets.",
  "```\n- [ ] in code\n```\n\n- [x] after code",
  "  - [ ] code?\n\n    - [ ] indented code",
  "> - [ ] quoted\n> - [x] quoted done",
  ">> - [ ] deeper quote\n>> - [x] more",
  ">>! In T1, @alice wrote:\n> - [ ] reply item",
  "> Quote\n>\n> - [ ] after text\n>   - [x] nested in quote",
  "NOTE: - [ ] not a list",
  "| - [ ] cell |\n| - |",
  "- [ ] item\n  continued line\n- [x] next",
  "- item with [ ] later\n- [ ]",
  "- [ ]\n- [x]",
  "%%%- [ ] literal%%%\n\n- [ ] real",
  "lang=txt\n- [ ] code by lang\n\n- [x] real",
  "- [ ] a\n\n\n- [x] b",
  "= Header =\n\n- [ ] under header",
  "- [ ] x\n-[ ] no space\n- [ ]no space after",
];

let seed = 7;
const random = (n) => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return Math.floor((seed / 2147483648) * n);
};
const LINES = [
  "- [ ] a",
  "- [x] b",
  "  - [ ] c",
  "    - [X] d",
  "# [ ] e",
  "> - [ ] f",
  "> - [x] g",
  "",
  "text",
  "```",
  "- plain",
  "[ ] h",
  "  continued",
  ">",
];
const texts = [...CASES];
for (let i = 0; i < 400; i++) {
  const count = 2 + random(8);
  texts.push(Array.from({ length: count }, () => LINES[random(LINES.length)]).join("\n"));
}

const output = execFileSync(
  "docker",
  ["compose", "exec", "-T", "phorge", "php", "/opt/remarkup-editor-test/render-checkboxes.php"],
  { cwd: new URL("../dev/phorge", import.meta.url), input: JSON.stringify(texts), maxBuffer: 1 << 26 },
);
writeFileSync(new URL("../test/fixtures/checkmarks.json", import.meta.url), output);
console.log(`Wrote ${JSON.parse(output).length} texts.`);
