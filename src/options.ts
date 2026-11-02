// The extension's options page: which tools run.

import { extensionStorage, type Tool, toolDefaults, TOOLS } from "./tools";

async function showOptions(): Promise<void> {
  const form = document.getElementById("tools")!;
  const chosen = await extensionStorage().get(toolDefaults());
  for (const [tool, { name, description }] of Object.entries(TOOLS) as [Tool, (typeof TOOLS)[Tool]][]) {
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.name = tool;
    box.checked = chosen[tool] === true;
    box.addEventListener("change", () => void extensionStorage().set({ [tool]: box.checked }));
    const title = document.createElement("strong");
    title.textContent = name;
    const text = document.createElement("span");
    text.textContent = description;
    label.append(box, title, text);
    form.append(label);
  }
}

void showOptions();
