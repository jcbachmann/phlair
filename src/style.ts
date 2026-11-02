/** Adds a tool's CSS to the page. */
export function addStyle(css: string): void {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
}
