// Regenerates test/fixtures/inline.json: remarkup texts and the HTML the real
// PHP engine in the dev container (dev/phorge) renders for each, as a single
// paragraph, for test/inline.test.ts. Run after changing the corpus:
//
//   node scripts/generate-inline-fixtures.mjs
//
// References use only what dev/phorge/seed.php creates (T1, F1, @alice,
// #demo_project, the macro rmecat) and names that never exist (T99999999,
// @nobody, …): the E2E tests create more objects, with numbers no fixture
// may depend on. For the same reason, no word is only digits, so that no
// two parts join into a reference like "T12".

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

// Hand-written cases: each rule, and what tells Phorge's rules apart from
// simpler patterns.
const CASES = [
  // Embeds and references of files and tasks next to each other: the order of their rules matters.
  "{F1}T1 {T1}F1 T1{F1} F1{T1} {F1}{T1} {T1}{F1} {F1, size=full}T1#c {T1}F1#c",
  // Two angle-bracket URIs on a line: each is one.
  "<http://a.example> and <http://b.example>, <http://a.example>x>",
  // A countdown's reference after a file embed: which of their rules runs first decides whether it is an embed.
  "{F1}C1 {F1}P1",
  // Formatting, also across lines and wrongly nested.
  "**bold** //italic// ~~del~~ __under__ !!high!!",
  "**bold\nacross lines**",
  "//italic\nacross\nlines//",
  "!!no highlight\nacross lines!!",
  "**a //b** c//",
  "//a **b// c**",
  "x ~~a **b~~ c** d",
  "**a ~~b** c~~ d",
  "**a !!b** c!! d",
  "!!a **b!! c** d",
  "__a **b__ c** d",
  "**a __b** c__ d",
  "**a //b ~~c** d// e~~",
  "**a //b** c//**d**",
  "**a //b**//",
  "**a //b ~~c** d~~ e//",
  "__//x//__ //__x__//",
  "~~**x**~~ !!//x//!!",
  "!!a!!!! !!!!! !!!a!!",
  "~~a~~~ ~~~a~~ ~~ a~~",
  "__a___ ___a__ __ a__ __a__/ __a__.b __a__. /__a__",
  "https://example.com//x// and a//b// and a://b//",
  "a**b**c a//b//c a~~b~~c a__b__c a!!b!!c",
  "**** ** **a** **",
  "//**x//**",
  // Monospaced text hides everything in it.
  "`**not bold**` ##//not italic//## a`b` `T1` `{F1}`",
  "##across\nlines## `not\nacross`",
  "the `Foo`s and x`y` and `unclosed",
  "`${{{strings.platform.server.name}}}`",
  // Links.
  "[[ /w/x | named ]] [[ /w/x ]] [[ nopage_xyz ]] [[ nopage_xyz | name ]]",
  "[[ https://example.com ]] [[ https://example.com | ex ]] [[ #anchor ]] [[ mailto:a@example.com ]]",
  "[[ tel:123 ]] [[ foo://x ]] [[ / ]] [[ a | ]] [[|x]]",
  "x[[ /w/x ]] [[ /w/x ]]x [[ `code` ]]",
  "[name](https://example.com/x) [name](/w/x) [name](mailto:a@example.com)",
  "[name](nope) [name](tel:1) [n](foo://a) [z](https://a_b.c) x[0][1](y)",
  "[w](https://en.wikipedia.org/wiki/Noun_(disambiguation)) [q]('https://x.y/') [ ](https://example.com/)",
  "[**bold**](https://example.com) [T1](https://example.com)",
  // URLs.
  "http://example.com/a. https://example.com/(a) (see https://example.com/x) https://example.com/x?a=1&b=2!",
  "<https://example.com/a b> <https://example.com/x> <foo://x> {https://example.com}",
  "HTTP://example.com https://a_b.example.com https://-x.example.com ftp://example.com",
  "https://example.com/x//y// **https://example.com/x**",
  "xhttp://example.com a_http://example.com http://example.com?a:b",
  "{F1}http://example.com/x `a`http://example.com/y",
  // References.
  "T1 T99999999 T1#comment (T1) T1. T1, xT1 T1x ÄT1 T1ä T-1 ABC-T1 @T1 #T1",
  "{T1} {T1, layout=x} {T99999999} {F1} {F1, size=full} {F99999999} F1 a{F1} {F1}a",
  "D99999999 P99999999 M99999999/2/ Q1 Q12 {Q1} V2 M1/2/ P1",
  "deadbeef1 acceded 1234567 rXYZ rXYZ1 rXYZabcde R1:abcde R1 rX1#a",
  "#demo_project #demo_project. #nope_xyz #demo_project#x x#demo_project (#demo_project) #a.b.",
  "{#demo_project} {#nope_xyz} {#fff}",
  "@alice @nobody @alice. x@alice mail@alice @@alice Ä@alice @alice.x @Alice",
  "{F1}@alice T1@alice T1 @alice",
  "{PHID-TASK-abcdefghijklmnopqrst} {PHID-X-1} {PHID-}",
  // Image macros: only a line that is only the name.
  "rmecat",
  "a\nrmecat\nb",
  "a\n  rmecat\nb",
  "rmecat b",
  "__init__",
  "a\n__init__\nb",
  // Braces.
  "{icon camera} {icon} {icon camera color=red} {iconic} {key Ctrl K} {key} {nav a > b} {nav}",
  "{key a\\}b} {nav icon=home, name=Home > Settings} {icon {key x}}",
  "{anchor #x} {anchor #Bad} {anchor #a-b} {anchor x} {anchor  #y}",
  "{src a.txt} {source x} {srcx}",
  "{image https://example.com/a.png} {image src=https://example.com/a.png} {image nope} {img https://example.com/b.png}",
  "{meme, src=rmecat, above=a, below=b} {meme,}",
  "@{config:phabricator.base-uri} @{nope} @{article:x|title} x@{nope}",
  ":smile: :nope: :+1: :-1: a:smile: :smile:b (:smile:) :smile::smile:",
  "${{{strings.platform.server.name}}} ${{{nope}}} ${{{a\nb}}}",
  "\u0001 x \u0001 \u0001@alice",
  "${{{**a\nb**}}}",
  "[x](#anchor) [y](mailto:nobody) [z](mailto:a@example.com) [w](/w/x)",
  "x@{config:phabricator.base-uri} x@{config:nope}",
  // PHP's \s is not JavaScript's: a no-break space is no whitespace there.
  "{anchor\u00a0#x} {anchor #x}",
  "a\n\u00a0rmecat\nb",
  "~~\u00a0a~~ __\u00a0a__",
  // Everything at once.
  "**T1 and @alice** //[[ /w/x | link ]]// ~~{F1}~~ __:smile:__ !!`mono`!!",
];

// prettier-ignore
const PARTS = [
  "**", "//", "~~", "__", "!!", "!!!", "`", "##", "[[", "]]", "|", "[", "](", ")", "(", "<", ">", "{", "}", ":", "@",
  "#", "_", "~", "*", "/", "\\", ".", "-", "a", "word", "x y", "Ä", "\u00a0", "T1", "T99999999", "T1#c", "D99999999",
  "F1", "{F1}", "{F1, size=full}", "{T1}", "{T99999999}", "Q1", "@alice", "@nobody", "#demo_project", "#nope_xyz",
  "rmecat", ":smile:", ":nope:", "deadbeef1", "rXYZ1", "{icon camera}", "{key Ctrl K}", "{nav a > b}", "{anchor #x}",
  "{src a.txt}", "{meme, src=rmecat, above=a}", "[[ /w/x | name ]]", "[[ nopage_xyz ]]", "[[ https://example.com ]]",
  "[n](https://example.com/z)", "http://example.com/x", "https://example.com/(a)", "<https://example.com/x>",
  "{https://example.com}", "${{{strings.platform.server.name}}}", "@{nope}", "{image https://example.com/a.png}",
];
// Formatting is rare in random combinations of everything: these make it
// common, nested and crossed.
// prettier-ignore
const FORMATTING = [
  "**", "**", "//", "//", "~~", "~~", "__", "__", "!!", "!!", "`", "##", "a", "b c", "d", "\n", " ", " ", "!", "~",
  "_", "/", "*", ":", "T1", "@alice", "[[ /w/x | n ]]", ":smile:", "http://example.com/x", "{F1}",
];
const SEPARATORS = ["", "", " ", " ", " ", "\n", ", ", ". ", "  "];

// Mulberry32: a small generator whose low bits are random too.
let seed = 7;
function random(n) {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) % n;
}

const texts = [...CASES];
for (let i = 0; i < 3000; i++) {
  let text = "";
  const count = 1 + random(10);
  for (let j = 0; j < count; j++) {
    text += PARTS[random(PARTS.length)] + SEPARATORS[random(SEPARATORS.length)];
  }
  // A paragraph has no blank lines: they would end it.
  texts.push(text.replace(/\n[ \t\u00a0]*(?=\n)/g, ""));
}
for (let i = 0; i < 2000; i++) {
  let text = "";
  const count = 2 + random(14);
  for (let j = 0; j < count; j++) {
    text += FORMATTING[random(FORMATTING.length)];
  }
  texts.push(text.replace(/\n[ \t\u00a0]*(?=\n)/g, ""));
}

const output = execFileSync(
  "docker",
  ["compose", "exec", "-T", "phorge", "php", "/opt/remarkup-editor-test/render-inline.php"],
  {
    cwd: new URL("../dev/phorge", import.meta.url),
    input: JSON.stringify(texts),
    maxBuffer: 1 << 28,
  },
);
writeFileSync(new URL("../test/fixtures/inline.json", import.meta.url), output);
console.log(`Wrote ${JSON.parse(output).length} rendered texts.`);
