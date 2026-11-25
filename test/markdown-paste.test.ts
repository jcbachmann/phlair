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

  it("finds no emphasis in project tags and mentions", () => {
    expect(
      markdownToRemarkup(
        lines("# Plan", "", "- For #861_-_texas_-_rhi_-_wartung and @a_b_c: _soon_", "- __Now__ (#x-__y__-z)"),
      ),
    ).toBe(lines("= Plan", "", "- For #861_-_texas_-_rhi_-_wartung and @a_b_c: //soon//", "- **Now** (#x-__y__-z)"));
  });

  it("leaves text that is not Markdown alone", () => {
    expect(markdownToRemarkup(lines("# install the tools", "apt install x"))).toBeNull();
    expect(markdownToRemarkup("Just a sentence with *stars*.")).toBeNull();
  });

  it("leaves remarkup copied from Phorge alone: code options, replies, file embeds", () => {
    for (const text of [
      lines("> ```lang=bash", "> test", "> ```"),
      lines("> - item", "> ```name=x.sh, lang=bash", "> a", "> ```", "> __underlined__"),
      lines("- item", "", "```counterexample", "x", "```", "", "> quote"),
      lines("- item", "  ```LINES=10", "  x", "  ```", "", "> quote"),
      lines(">>! In T1, @alice wrote:", "> - item", "> *not emphasis*"),
      lines("> {F12, size=full}", "> - item", "> *not emphasis*"),
      // A table of links, as pasted in T30775's comments; GFM finds links in it, and emphasis in the tag.
      lines(
        "| SharePoint   | [[https://contoso.sharepoint.com/:f:/r/sites/a/b%20-%20c?d=w62&e=RHI7ge|828 - TEXAS]]",
        "| Phabricator  | #861_-_texas_-_rhi_magnesita_-_wartungsvertrag",
        "| Timetracking | [[https://example.com/de_DE/project_details?project=124|861 - TEXAS - Wartungsvertrag]]",
      ),
    ]) {
      expect(markdownToRemarkup(text), text).toBeNull();
    }
    // Markdown's own fences still get "lang=", also next to remarkup-like text.
    expect(markdownToRemarkup(lines("> - item", "> ```bash", "> x", "> ```", "> [[ wiki/page ]]"))).toBe(
      lines("> - item", "> ```lang=bash", "> x", "> ```", "> [[ wiki/page ]]"),
    );
  });
});

describe("markdownToRemarkup, as Markdown parses the text", () => {
  it("resolves reference links defined in a quote", () => {
    expect(
      markdownToRemarkup(lines("> See the **[docs]**.", ">", "> [docs]: https://example.com/docs", "> More.")),
    ).toBe(lines("> See the **[[ https://example.com/docs | docs ]]**.", ">", "> More."));
  });

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
