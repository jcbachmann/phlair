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
