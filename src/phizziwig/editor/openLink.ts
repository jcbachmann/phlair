// Links in the editor and its rendered blocks.

/** Links in the editor open with Ctrl+click (Cmd+click); a plain click edits. */
export function openLinkOnModClick(event: MouseEvent): void {
  const link = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
  if (link) {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      window.open(link.href, "_blank", "noopener");
    }
  }
}
