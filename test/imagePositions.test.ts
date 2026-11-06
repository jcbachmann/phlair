import { describe, expect, it } from "vitest";
import { imagePositions } from "../src/phizziwig/editor/imagePreview";

const file = (f: string) => ({ html: `<div data-rme-file="${f}"></div>`, file: f });
const macro = (name: string) => ({ html: `<p><img class="phabricator-remarkup-macro" alt="${name}"></p>`, file: null });
const meme = { html: '<p><img src="/meme.png" alt="Macro cat"></p>', file: null };

describe("imagePositions", () => {
  it("takes the n-th embed of a file for its n-th image", () => {
    const sources = [
      { pos: 0, file: "F1" },
      { pos: 10, file: "F2" },
      { pos: 20, file: "F1" },
    ];
    expect(imagePositions([file("F1"), file("F2"), file("F1")], sources, -1)).toEqual([0, 10, 20]);
  });

  it("finds macros by their name and memes in their order", () => {
    const sources = [
      { pos: 0, macro: "hello" },
      { pos: 10, macro: "cat" },
      { pos: 20, meme: true as const },
      { pos: 30, file: "F1" },
    ];
    expect(imagePositions([macro("cat"), meme, file("F1")], sources, -1)).toEqual([10, 20, 30]);
  });

  it("puts an image of no source with the image before it, or else after it, or else at the fallback", () => {
    const sources = [{ pos: 5, file: "F1" }];
    expect(imagePositions([file("F1"), file("F9")], sources, -1)).toEqual([5, 5]);
    expect(imagePositions([file("F9"), file("F1")], sources, -1)).toEqual([5, 5]);
    expect(imagePositions([file("F9")], sources, -1)).toEqual([-1]);
  });
});
