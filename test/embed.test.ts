import { describe, expect, it } from "vitest";
import { findEmbeds, formatEmbed, getOption, setOption } from "../src/phizziwig/embed";

describe("findEmbeds", () => {
  it("finds embeds with their options and positions", () => {
    const text = 'See {F1} and {F23, layout=right, float, alt="A, \\"quoted\\" text"} here.';
    const embeds = findEmbeds(text);
    expect(embeds.map((e) => text.slice(e.from, e.to))).toEqual([
      "{F1}",
      '{F23, layout=right, float, alt="A, \\"quoted\\" text"}',
    ]);
    expect(embeds[1].monogram).toBe("F23");
    expect(embeds[1].options).toEqual([
      ["layout", "right"],
      ["float", true],
      ["alt", 'A, "quoted" text'],
    ]);
  });

  it("does not take other objects or braces for file embeds", () => {
    expect(findEmbeds("{T1} {Fx} {F12abc} F12")).toEqual([]);
  });
});

describe("changing embeds", () => {
  const [embed] = findEmbeds("{F5, size=full, layout=left}");

  it("replaces an option in place and appends new ones", () => {
    const changed = setOption(setOption(embed, "layout", "right"), "float", true);
    expect(formatEmbed(changed)).toBe("{F5, size=full, layout=right, float}");
  });

  it("removes options and quotes values that need it", () => {
    const changed = setOption(setOption(embed, "size", null), "alt", "Plot, 2nd try");
    expect(formatEmbed(changed)).toBe('{F5, layout=left, alt="Plot, 2nd try"}');
    expect(getOption(findEmbeds(formatEmbed(changed))[0], "alt")).toBe("Plot, 2nd try");
  });
});
