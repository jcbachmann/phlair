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

/** Choices within the tools, off unless chosen: in Phorge the user's settings, in the extension its options page. */
export type Option = "onedriphe";

export const OPTIONS: Record<Option, { name: string; description: string; default: boolean }> = {
  onedriphe: {
    name: "OneDriphe: SharePoint links",
    description:
      "On Windows, a click on a SharePoint link also offers to open it in Explorer, where OneDrive syncs it. Needs " +
      "Phizziwig, and OneDriphe on your computer (its installer is in Phorge's Settings → Phlair).",
    default: false,
  },
};

export type Options = Record<Option, boolean>;

let options: Options = optionDefaults();

/** Whether the user chose an option (see chooseOptions()). */
export function option(name: Option): boolean {
  return options[name];
}

/** Sets the options the tools follow, before they start; the others keep their default. */
export function chooseOptions(chosen: Partial<Options>): void {
  options = { ...optionDefaults(), ...chosen };
}

/**
 * The options of the browser builds: the extension's choices (options page),
 * all of them in the userscript, which is for development. Installed in
 * Phorge, the user's settings decide (see main.ts).
 */
export async function chosenOptions(): Promise<Options> {
  if (__TARGET__ !== "extension") {
    return Object.fromEntries(Object.keys(OPTIONS).map((name) => [name, true])) as Options;
  }
  return (await extensionStorage().get(optionDefaults())) as Options;
}

/** Every option with its default, as the extension stores them. */
export function optionDefaults(): Options {
  return Object.fromEntries(Object.entries(OPTIONS).map(([name, { default: on }]) => [name, on])) as Options;
}

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
