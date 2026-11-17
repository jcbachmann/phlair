// Entry point of the userscript, the browser extension and the script of the
// Phorge library: starts the tools of Phlair.

import { startPhizziwig } from "./phizziwig";
import { chooseSharePointFolders } from "./phizziwig/localPaths";
import { chooseOneDripheHosts } from "./phizziwig/sharePointLinks";
import { startPhuture } from "./phuture";
import { chooseOptions, chosenOptions, enabledTools, type Options, type Tool } from "./tools";

const START: Record<Tool, () => void> = { phizziwig: startPhizziwig, phuture: startPhuture };

/**
 * Starts the tools, on Phorge pages only, and each only once: a developer's
 * userscript or extension may run next to the build installed in Phorge,
 * which starts first. The marks are in the DOM, which the extension's
 * content script shares.
 */
function start(tools: Tool[]): void {
  if (!document.querySelector('script[src*="/res/"], link[href*="/res/"]')) {
    return;
  }
  const marks = document.documentElement.dataset;
  for (const tool of tools) {
    if (!marks[tool]) {
      marks[tool] = __TARGET__;
      START[tool]();
    }
  }
}

if (__TARGET__ === "phorge") {
  // The library's main menu extension starts it with the tools the user has on, their options, and the
  // configuration's SharePoint libraries and the hosts of OneDriphe's links.
  JX.behavior(
    "phlair",
    (config: { tools: Tool[]; options?: Partial<Options>; sharePointFolders?: unknown; oneDripheHosts?: unknown }) => {
      chooseOptions(config.options ?? {});
      chooseSharePointFolders(config.sharePointFolders);
      chooseOneDripheHosts(config.oneDripheHosts);
      start(config.tools);
    },
  );
} else {
  void Promise.all([enabledTools(), chosenOptions()]).then(([tools, chosen]) => {
    chooseOptions(chosen);
    start(tools);
  });
}
