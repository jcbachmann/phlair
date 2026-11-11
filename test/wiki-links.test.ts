// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { absoluteWikiLinks } from "../src/phizziwig/checkboxes";

describe("absoluteWikiLinks", () => {
  it("resolves relative links from the page's slug, as Phorge does", () => {
    expect(absoluteWikiLinks("see [[ ./child ]] and [[ ../ ]]", "base/sub/")).toBe(
      "see [[ base/sub/child/ ]] and [[ base/ ]]",
    );
    expect(absoluteWikiLinks("[[ ./a/../b | name ]] [[./c#x]]", "base/sub/")).toBe(
      "[[ base/sub/b/ | name ]] [[base/sub/c/#x]]",
    );
    expect(absoluteWikiLinks("[[ ./top ]]", "/")).toBe("[[ top/ ]]");
    expect(absoluteWikiLinks("[[ other/page ]] [[ https://example.com/./x ]]", "base/")).toBe(
      "[[ other/page ]] [[ https://example.com/./x ]]",
    );
  });
});
