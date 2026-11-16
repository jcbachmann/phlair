// The extension's options page: which tools run, and their options.

import { extensionStorage, type Option, optionDefaults, OPTIONS, type Tool, toolDefaults, TOOLS } from "./tools";

type Choices = Record<string, { name: string; description: string }>;

async function showChoices(formId: string, choices: Choices, defaults: Record<string, boolean>): Promise<void> {
  const form = document.getElementById(formId)!;
  const chosen = await extensionStorage().get(defaults);
  for (const [key, { name, description }] of Object.entries(choices)) {
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.name = key;
    box.checked = chosen[key] === true;
    box.addEventListener("change", () => void extensionStorage().set({ [key]: box.checked }));
    const title = document.createElement("strong");
    title.textContent = name;
    const text = document.createElement("span");
    text.textContent = description;
    label.append(box, title, text);
    form.append(label);
  }
}

void showChoices("tools", TOOLS satisfies Record<Tool, unknown>, toolDefaults());
void showChoices("options", OPTIONS satisfies Record<Option, unknown>, optionDefaults());
