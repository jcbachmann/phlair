// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { Rendered } from "../src/phizziwig/phorge";
import { BlockRenderer, type RenderItem } from "../src/phizziwig/renderer";

/** A server that renders each paragraph as <p>, logging what it gets. */
function server(fail: (text: string) => boolean = () => false) {
  const requests: string[] = [];
  const render = async (text: string): Promise<Rendered> => {
    requests.push(text);
    if (fail(text)) {
      throw new Error("500");
    }
    const html = text
      .split(/\n\n+/)
      .map((p) => `<p>${p}</p>`)
      .join("");
    return { html: `<div class="phabricator-remarkup">${html}</div>`, metadata: [], behaviors: {} };
  };
  return { render, requests };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const item = (text: string, last = false): RenderItem => ({ text, last });

describe("BlockRenderer", () => {
  it("renders blocks in one request and caches each", async () => {
    const { render, requests } = server();
    let rendered = 0;
    const renderer = new BlockRenderer(render, () => rendered++);
    renderer.request([item("One"), item("Two")]);
    await settle();
    expect(requests).toHaveLength(1);
    expect(renderer.get(item("One"))).toBe("<p>One</p>");
    expect(renderer.get(item("Two"))).toBe("<p>Two</p>");
    expect(rendered).toBe(1);
    renderer.request([item("One")]);
    await settle();
    expect(requests).toHaveLength(1);
  });

  it("follows every block but the last one of the text with a separator, and renders the last one alone", async () => {
    const { render, requests } = server();
    const renderer = new BlockRenderer(render, () => {});
    renderer.request([item("## Last", true), item("Before")]);
    await settle();
    expect(requests).toHaveLength(2);
    const last = requests.find((text) => text.startsWith("## Last"))!;
    const before = requests.find((text) => text.startsWith("Before"))!;
    expect(last).toBe("## Last");
    expect(before).toMatch(/^Before\n\nRMESEP\w+$/);
    // The same text as last block or not are different blocks.
    expect(renderer.get(item("## Last", true))).toBe("<p>## Last</p>");
    expect(renderer.get(item("## Last"))).toBeUndefined();
    expect(renderer.getOrSimilar(item("## Last"))).toBe("<p>## Last</p>");
  });

  it("renders a failed batch block by block, and does not repeat a single failing block", async () => {
    const { render, requests } = server((text) => text.includes("bad"));
    const renderer = new BlockRenderer(render, () => {});
    renderer.request([item("good"), item("bad")]);
    await settle();
    expect(renderer.get(item("good"))).toBe("<p>good</p>");
    expect(renderer.failures).toBe(1);
    requests.length = 0;
    renderer.retryNow();
    await settle();
    // Alone in its batch: one request, not a second one for the block alone.
    expect(requests).toHaveLength(1);
    renderer.destroy();
  });

  it("forgets failures of texts that are no longer blocks", async () => {
    const { render } = server((text) => text.includes("bad"));
    const renderer = new BlockRenderer(render, () => {});
    renderer.request([item("bad")]);
    await settle();
    expect(renderer.failures).toBe(1);
    renderer.keepFailures([item("fixed")]);
    expect(renderer.failures).toBe(0);
    renderer.destroy();
  });

  it("calls back nothing when a rendering arrives after it was destroyed", async () => {
    let answer = () => {};
    const render = (text: string) =>
      new Promise<Rendered>((resolve) => {
        answer = () => resolve({ html: `<p>${text}</p>`, metadata: [], behaviors: {} });
      });
    let rendered = 0;
    const renderer = new BlockRenderer(render, () => rendered++);
    renderer.request([item("One", true)]);
    await settle();
    renderer.destroy();
    answer();
    await settle();
    expect(rendered).toBe(0);
  });
});
