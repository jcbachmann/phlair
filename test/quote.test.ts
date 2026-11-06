import { describe, expect, it } from "vitest";
import { outerQuote, QUOTE_LINE, quoteDepth, quoteMarkers, tidyQuoteMarkers } from "../src/phizziwig/syntax";

const markers = (line: string) => QUOTE_LINE.exec(line)![1];

describe("quote lines", () => {
  it("count a level per >, with a space or not, and a reply's >>! as one", () => {
    expect([">  x", "> > x", ">> x", ">>>x", ">>! In T1, @a wrote:", "> >>! In T1, @a wrote:"].map(markers)).toEqual([
      "> ",
      "> > ",
      ">> ",
      ">>>",
      ">>! ",
      "> >>! ",
    ]);
    expect(["> ", "> > ", ">> ", ">>>", ">>! ", "> >>! ", ">"].map(quoteDepth)).toEqual([1, 2, 2, 3, 1, 2, 1]);
    expect(QUOTE_LINE.exec(">> x")![2]).toBe("x");
  });

  it("lose their innermost level, keeping the space before the text", () => {
    expect(["> > ", ">> ", ">>", "> ", ">", ">>! ", "> >>! "].map(outerQuote)).toEqual([
      "> ",
      "> ",
      ">",
      "",
      "",
      "",
      "> ",
    ]);
    expect(quoteMarkers(2)).toBe(">> ");
  });

  it("are tidied as Phorge quotes: levels together, a space before the text, none on a blank line", () => {
    const tidy = (line: string, keepSpace = false) => {
      const [, found, text] = QUOTE_LINE.exec(line)!;
      return tidyQuoteMarkers(found, text, keepSpace) + text;
    };
    expect(
      [">x", "> > x", ">>x", "> >  indented", "> ", "> > ", ">>! In T1:", "> >>!In T1:", ">!x"].map((l) => tidy(l)),
    ).toEqual(["> x", ">> x", ">> x", ">>  indented", ">", ">>", ">>! In T1:", ">>>! In T1:", "> !x"]);
    // Where the cursor is, a blank line keeps its space for the text to come.
    expect([tidy("> ", true), tidy("> > ", true), tidy(">", true), tidy("> >", true)]).toEqual([
      "> ",
      ">> ",
      ">",
      ">>",
    ]);
  });
});
