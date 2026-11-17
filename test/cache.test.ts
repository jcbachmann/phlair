import { describe, expect, it } from "vitest";
import { LruCache } from "../src/cache";

describe("LruCache", () => {
  it("keeps the entries used last: one that is read stays, the one used longest ago goes", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);
    expect(cache.has("b")).toBe(false);
    expect([cache.get("a"), cache.get("c"), cache.size]).toEqual([1, 3, 2]);
    // Set again counts as used.
    cache.set("a", 4);
    cache.set("d", 5);
    expect([cache.has("c"), cache.get("a")]).toEqual([false, 4]);
  });

  it("keeps null values, and a smaller capacity takes effect with the next entry", () => {
    const cache = new LruCache<string, string | null>(3);
    cache.set("none", null);
    expect(cache.get("none")).toBeNull();
    cache.set("x", "1");
    cache.set("y", "2");
    cache.capacity = 1;
    cache.set("z", "3");
    expect([cache.size, cache.get("z")]).toEqual([1, "3"]);
    cache.delete("z");
    expect(cache.size).toBe(0);
  });
});
