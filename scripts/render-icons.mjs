// Renders icons/icon-<size>.png: the editor's toggle button while on (src/style.css), a blue square with Font Awesome's
// wand and a soft glow, on a transparent background.
//
// Usage: node scripts/render-icons.mjs [path to fontawesome-webfont.woff2]
// Without a path, the font is taken from the local Phorge (dev/phorge), which ships Font
// Awesome 4.7.

import { chromium } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";

const PHORGE_URL = "http://phorge.localhost:8098";
const SIZES = [16, 32, 48, 96, 128];

async function fetchFont() {
  const html = await (await fetch(PHORGE_URL)).text();
  const css = await (await fetch(new URL(html.match(/\/res\/[^"]*core\.pkg\.css/)[0], PHORGE_URL))).text();
  const font = css.match(/url\(([^)]*fontawesome-webfont\.woff2[^)]*)\)/)[1];
  return Buffer.from(await (await fetch(new URL(font, PHORGE_URL))).arrayBuffer());
}

const font = process.argv[2] ? readFileSync(process.argv[2]) : await fetchFont();

// Chrome's guideline for a 128 px icon: 96 px artwork with 16 px of transparent margin, which here holds the glow. At
// 16 px the glow would only blur the edge, so the square fills the icon.
function layout(size) {
  if (size === 16) {
    return { square: 16, glow: 0 };
  }
  const margin = size / 8;
  // The glow of the button (blur 7 px and 12 px, spread 1 px and 2 px at about 25 px) shrunk to end at the margin.
  return { square: size - 2 * margin, glow: margin / 12 };
}

function page(size) {
  const { square, glow } = layout(size);
  const shadow = glow
    ? `0 0 ${7 * glow}px ${glow}px rgba(52, 152, 219, 0.5), 0 0 ${12 * glow}px ${2 * glow}px rgba(155, 89, 182, 0.18)`
    : "none";
  return `<!doctype html>
<style>
  @font-face {
    font-family: FontAwesome;
    src: url(data:font/woff2;base64,${font.toString("base64")}) format("woff2");
  }
  html, body { margin: 0; background: transparent; }
  .icon { width: ${size}px; height: ${size}px; display: flex; align-items: center; justify-content: center; }
  .button {
    width: ${square}px;
    height: ${square}px;
    border-radius: ${square * 0.12}px;
    background: #3498db;
    box-shadow: ${shadow};
    color: #fff;
    font: ${Math.round(square * 0.62)}px/1 FontAwesome;
    display: flex;
    align-items: center;
    justify-content: center;
  }
</style>
<div class="icon"><div class="button">&#xf0d0;</div></div>`;
}

mkdirSync("icons", { recursive: true });
const browser = await chromium.launch();
try {
  for (const size of SIZES) {
    const tab = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await tab.setContent(page(size));
    if (!(await tab.evaluate(async () => (await document.fonts.load("16px FontAwesome")).length))) {
      throw new Error("Font Awesome did not load");
    }
    await tab.screenshot({ path: `icons/icon-${size}.png`, omitBackground: true });
    await tab.close();
  }
} finally {
  await browser.close();
}
