import { describe, expect, it } from "vitest";
import { markdownToRemarkup } from "../src/phizziwig/paste";

const lines = (...l: string[]) => l.join("\n");

describe("markdownToRemarkup", () => {
  it("converts a typical Markdown answer", () => {
    const markdown = lines(
      "## Setup",
      "",
      "Install it with *npm* and __check__ the `*.js` files:",
      "",
      "```bash",
      "npm install # not a heading",
      "echo *not italic*",
      "```",
      "",
      "- one",
      "- two with [a link](https://example.com)",
      "",
      "| Name | Value |",
      "|:-----|------:|",
      "| a    | 1     |",
      "",
      "***",
      "![Diagram](https://example.com/d.png)",
    );
    expect(markdownToRemarkup(markdown)).toBe(
      lines(
        "== Setup",
        "",
        "Install it with //npm// and **check** the `*.js` files:",
        "",
        "```lang=bash",
        "npm install # not a heading",
        "echo *not italic*",
        "```",
        "",
        "- one",
        "- two with [a link](https://example.com)",
        "",
        "| Name | Value |",
        "|------|-------|",
        "| a    | 1     |",
        "",
        "---",
        "[[ https://example.com/d.png | Diagram ]]",
      ),
    );
  });

  it("keeps lists, bold and underscores in words", () => {
    expect(markdownToRemarkup(lines("# Title", "* item with **bold** and snake_case_name", "* 2*3*4"))).toBe(
      lines("= Title", "* item with **bold** and snake_case_name", "* 2*3*4"),
    );
  });

  it("leaves text that is not Markdown alone", () => {
    expect(markdownToRemarkup(lines("# install the tools", "apt install x"))).toBeNull();
    expect(markdownToRemarkup("Just a sentence with *stars*.")).toBeNull();
  });
});

describe("markdownToRemarkup, as Markdown parses the text", () => {
  it("converts what a line-by-line reading misses", () => {
    expect(
      markdownToRemarkup(
        lines(
          "Setup",
          "=====",
          "",
          "Use `` a`b `` and *a **b** c* with a [reference][docs] and <https://example.com/x>.",
          "",
          "~~~js",
          "const a = *b*;",
          "~~~",
          "",
          "+ one \\*literal\\*",
          '+ [titled](https://example.com/t "Title")',
          "",
          "[docs]: https://example.com/docs",
        ),
      ),
    ).toBe(
      lines(
        "Setup",
        "=====",
        "",
        "Use ##a`b## and //a **b** c// with a [[ https://example.com/docs | reference ]] and https://example.com/x.",
        "",
        "```lang=js",
        "const a = *b*;",
        "```",
        "",
        "- one *literal*",
        "- [[ https://example.com/t | titled ]]",
      ),
    );
  });

  it("converts the markup inside headings and links, and leaves code alone", () => {
    expect(markdownToRemarkup(lines("### A *b* ###", "", "[**bold** _it_][r]", "", "    *code*", "", "[r]: /x"))).toBe(
      lines("=== A //b//", "", "[[ /x | **bold** //it// ]]", "", "    *code*"),
    );
  });
});

describe("markdownToRemarkup, edge cases", () => {
  it("writes double-backtick code as remarkup's ##, and keeps an escape that would start a line with markup", () => {
    expect(markdownToRemarkup(lines("# T", "", "Run ``make`` now.", "", "\\# not a heading, \\*not\\* *em*"))).toBe(
      lines("= T", "", "Run ##make## now.", "", "\\# not a heading, *not* //em//"),
    );
  });
});
