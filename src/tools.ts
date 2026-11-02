// The tools of Phlair, and which of them run in the browser builds.

export type Tool = "phizziwig" | "phuture";

export const TOOLS: Record<Tool, { name: string; description: string; default: boolean }> = {
  phizziwig: {
    name: "Phizziwig",
    description: "Edit remarkup text fields while they look like the rendered preview.",
    default: true,
  },
  phuture: {
    name: "Phuture",
    description: "Snooze tasks, revisions and other items of lists until a day of your choice.",
    default: true,
  },
};

/**
 * The tools the browser builds start: the extension's choices (options page),
 * all of them in the userscript, which is for development. Installed in
 * Phorge, the user's settings decide (see main.ts).
 */
export async function enabledTools(): Promise<Tool[]> {
  const all = Object.keys(TOOLS) as Tool[];
  if (__TARGET__ !== "extension") {
    return all;
  }
  const chosen = await extensionStorage().get(toolDefaults());
  return all.filter((tool) => chosen[tool] === true);
}

/** Every tool with its default, as the extension stores them. */
export function toolDefaults(): Record<Tool, boolean> {
  return Object.fromEntries(Object.entries(TOOLS).map(([tool, { default: on }]) => [tool, on])) as Record<
    Tool,
    boolean
  >;
}

/** The extension's storage: "browser" in Firefox, "chrome" in Chrome, both with promises. */
export function extensionStorage(): ExtensionStorageArea {
  return (globalThis.browser ?? globalThis.chrome)!.storage.local;
}
