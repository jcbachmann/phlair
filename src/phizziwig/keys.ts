// Keyboard shortcuts, written like CodeMirror's key names ("Mod-b",
// "Mod-Shift-x"), for places outside of the editor's keymap (table cells) and
// for showing them in tooltips.

const MAC = /Mac|iPhone|iPad/.test(navigator.platform);

/** True if the event is the key, e.g. "Mod-Shift-x" (Mod is Cmd on a Mac, else Ctrl). */
export function matchesKey(event: KeyboardEvent, key: string): boolean {
  const parts = key.split("-");
  const name = parts.pop()!;
  const mod = parts.includes("Mod");
  const shift = parts.includes("Shift");
  const alt = parts.includes("Alt");
  return (
    (MAC ? event.metaKey : event.ctrlKey) === mod &&
    (MAC ? event.ctrlKey : event.metaKey) === false &&
    event.shiftKey === shift &&
    event.altKey === alt &&
    keyMatches(event, name)
  );
}

function keyMatches(event: KeyboardEvent, name: string): boolean {
  // Digits by their key, so they work in every keyboard layout.
  if (/^\d$/.test(name)) {
    return event.code === `Digit${name}`;
  }
  if (event.key.toLowerCase() === name.toLowerCase()) {
    return true;
  }
  // Letters on layouts without Latin letters (e.g. Cyrillic) by their key, like CodeMirror.
  return /^[a-z]$/i.test(name) && !/^[\x20-\x7e]$/.test(event.key) && event.code === `Key${name.toUpperCase()}`;
}

/** How a key is shown, e.g. "Ctrl+Shift+X" or "⌘⇧X". */
export function keyLabel(key: string): string {
  const parts = key.split("-");
  const name = parts.pop()!;
  const shown = name.length === 1 ? name.toUpperCase() : name;
  const labels: Record<string, string> = MAC
    ? { Mod: "⌘", Shift: "⇧", Alt: "⌥" }
    : { Mod: "Ctrl+", Shift: "Shift+", Alt: "Alt+" };
  return parts.map((part) => labels[part]).join("") + shown;
}
