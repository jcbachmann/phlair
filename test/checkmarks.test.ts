import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkmarks, setCheckmark } from "../src/phizziwig/checkmarks";

const fixtures = JSON.parse(readFileSync(new URL("fixtures/checkmarks.json", import.meta.url), "utf8")) as {
  text: string;
  checkboxes: boolean[];
}[];

describe("checkmarks", () => {
  it("finds the checkboxes Phorge renders, in their order and state", () => {
    expect(fixtures.length).toBeGreaterThan(400);
    const wrong = fixtures.filter(({ text, checkboxes }) => {
      const found = checkmarks(text).map((mark) => mark.checked);
      return JSON.stringify(found) !== JSON.stringify(checkboxes);
    });
    expect(wrong.slice(0, 3)).toEqual([]);
  });

  it("changes only the mark of one checkbox", () => {
    const text = "- [ ] one\n> - [X] two\n- [] three";
    expect(setCheckmark(text, 0, true)).toBe("- [x] one\n> - [X] two\n- [] three");
    expect(setCheckmark(text, 1, false)).toBe("- [ ] one\n> - [ ] two\n- [] three");
    expect(setCheckmark(text, 2, true)).toBe("- [ ] one\n> - [X] two\n- [x] three");
    expect(setCheckmark(text, 3, true)).toBeNull();
  });
});
