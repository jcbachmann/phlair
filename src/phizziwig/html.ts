// HTML from the server or the clipboard, parsed in a document of its own,
// where nothing loads or runs while it is read. Used instead of assigning
// innerHTML, which extension reviews flag. This is no sanitizer: setHtml()
// puts the nodes into the page, so it is only for the HTML Phorge renders
// (whose escaping and Content-Security-Policy keep scripts out); pasted HTML
// is only read, to turn it into remarkup.

/** Parses HTML (the content of a body) into inert nodes. */
export function parseHtml(html: string): DocumentFragment {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const fragment = doc.createDocumentFragment();
  fragment.append(...Array.from(doc.body.childNodes));
  return fragment;
}

/** Text as HTML. */
export function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

/** Replaces the content of an element of the page with HTML of Phorge. */
export function setHtml(element: Element, html: string): void {
  element.replaceChildren(document.importNode(parseHtml(html), true));
}
