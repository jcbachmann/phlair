// Entry point of the userscript, the browser extension and the script of the
// Phorge library: starts the tools of Phlair.

import { startPhizziwig } from "./phizziwig";
import { startPhuture } from "./phuture";
import { enabledTools, type Tool } from "./tools";

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
  // The library's main menu extension starts it with the tools the user has on.
  JX.behavior("phlair", (config: { tools: Tool[] }) => start(config.tools));
} else {
  void enabledTools().then(start);
}
