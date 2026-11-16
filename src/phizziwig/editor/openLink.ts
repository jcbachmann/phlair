// Links in the editor and its rendered blocks.

import { showOpenWays } from "../sharePointLinks";

/**
 * Links in the editor open with Ctrl+click (Cmd+click); a plain click edits.
 * A SharePoint link with more than one way to open it shows them, as in
 * rendered text.
 */
export function openLinkOnModClick(event: MouseEvent): void {
  const link = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
  if (link) {
    event.preventDefault();
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }
    if (showOpenWays(link)) {
      return;
    }
    if (/^https?:$/.test(link.protocol)) {
      window.open(link.href, "_blank", "noopener");
    } else {
      // An app's link ("mailto:…"): the browser hands it to the app, a tab would stay empty.
      window.location.href = link.href;
    }
  }
}
