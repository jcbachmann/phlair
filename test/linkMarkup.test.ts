// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { tokenizeInline } from "../src/phizziwig/inline";
import { linkMarkup, linkName, linkTarget } from "../src/phizziwig/linkMarkup";
import { htmlToRemarkup, markdownToRemarkup, sharePointToRemarkup } from "../src/phizziwig/paste";

/** Whether Phorge's rules (as inline.ts ports them) read all of the markup as one link. */
function isOneLink(markup: string): boolean {
  const tokens = tokenizeInline(markup, { sharePoint: true });
  return tokens.length === 1 && tokens[0].kind === "link" && tokens[0].from === 0 && tokens[0].to === markup.length;
}

describe("linkMarkup", () => {
  it("writes a link Phorge reads as one, whatever the name and target have in them", () => {
    expect(linkMarkup("https://example.com/a", "IMG_0814[1].JPG")).toBe(
      "[[ https://example.com/a | IMG_0814(1).JPG ]]",
    );
    expect(linkMarkup("https://example.com/a|b[c]", "a | b")).toBe("[[ https://example.com/a%7Cb%5Bc%5D | a | b ]]");
    expect(linkMarkup("https://example.com/a b", " x\n  y ")).toBe("[[ https://example.com/a%20b | x y ]]");
    expect(linkMarkup("wiki/page/")).toBe("[[ wiki/page/ ]]");
    expect(linkMarkup("wiki/page/", "")).toBe("[[ wiki/page/ ]]");
    for (const [target, name] of [
      ["https://example.com/a", "IMG_0814[1].JPG"],
      ["https://example.com/a", "]] tricky [["],
      ["https://example.com/a|b]]c", "x"],
      ["https://example.com/a", "a | b"],
    ]) {
      expect(isOneLink(linkMarkup(target, name)), `${target} ${name}`).toBe(true);
    }
    // Without: the "]" of the name ends the link.
    expect(isOneLink("[[ https://example.com/a | IMG_0814[1].JPG ]]")).toBe(false);
  });

  it("leaves names and targets without such characters as they are", () => {
    expect(linkName("Budget 2026.xlsx")).toBe("Budget 2026.xlsx");
    expect(linkTarget("https://x.sharepoint.com/sites/P/Shared%20Documents/IMG_0814%5B1%5D.JPG?d=w0&e=WI")).toBe(
      "https://x.sharepoint.com/sites/P/Shared%20Documents/IMG_0814%5B1%5D.JPG?d=w0&e=WI",
    );
  });
});

describe("links the editor writes", () => {
  const PHOTO =
    "https://jcbachmann.sharepoint.com/:i:/r/sites/Firmendaten/Freigegebene%20Dokumente/General/IMG_0814%5B1%5D.JPG?d=w0db081b35c1d43b3859a406f5c8f69b0&csf=1&web=1&e=WIWmTp";

  it("a pasted SharePoint link of a file with brackets in its name", () => {
    const markup = sharePointToRemarkup(PHOTO)!;
    expect(markup).toBe(`[[ ${PHOTO} | IMG_0814(1).JPG ]]`);
    expect(isOneLink(markup)).toBe(true);
  });

  it("pasted HTML links with brackets or a bar in their text or target", () => {
    expect(htmlToRemarkup(`<a href="${PHOTO}">${PHOTO}</a>`)).toBe(`[[ ${PHOTO} | IMG_0814(1).JPG ]]`);
    expect(htmlToRemarkup(`<a href="https://example.com/a">see [1]</a>`)).toBe("[[ https://example.com/a | see (1) ]]");
    expect(htmlToRemarkup(`<a href="https://example.com/a|b">x</a>`)).toBe("[[ https://example.com/a%7Cb | x ]]");
  });

  it("pasted Markdown links and images with brackets in their text", () => {
    // A heading too: Markdown converts where it shows two of its kinds of markup.
    expect(markdownToRemarkup(`# Notes\n\nSee [the \\[1\\] **list**](https://example.com/a "Title").`)).toBe(
      "= Notes\n\nSee [[ https://example.com/a | the (1) **list** ]].",
    );
    expect(markdownToRemarkup("# Notes\n\n![a [b] c](https://example.com/i.png)")).toBe(
      "= Notes\n\n[[ https://example.com/i.png | a (b) c ]]",
    );
  });
});
