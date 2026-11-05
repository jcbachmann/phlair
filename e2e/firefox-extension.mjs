// Smoke test of the browser extension (dist/extension) in Firefox.
//
// Playwright cannot load extensions into Firefox, so this drives Firefox with
// WebDriver BiDi: it installs the extension temporarily, logs in with the
// session of the Playwright setup (see e2e/env.ts; run "npx playwright test"
// first) and checks that the editor works in a content script.
//
// Usage: node e2e/firefox-extension.mjs [path to firefox]. By default it is
// Playwright's Firefox, the one the other tests use: with Firefox 159, the
// window of a WebDriver BiDi session had no focus (document.hasFocus() was
// false, headless or not), so the editor never got it.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { firefox as playwrightFirefox } from "@playwright/test";

// Like e2e/env.ts, which plain Node can not import.
const BASE = "http://phorge.localhost:8098";
const AUTH_FILE = `e2e/.auth/${new URL(BASE).host.replace(/\W/g, "_")}.json`;
if (!existsSync(AUTH_FILE)) {
  console.error(`No login in ${AUTH_FILE}: run "npx playwright test" first, which logs in.`);
  process.exit(1);
}
// A free port, so runs at the same time do not collide.
const PORT = await new Promise((resolve) => {
  const server = createServer().listen(0, () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});
const firefoxPath = process.argv[2] ?? playwrightFirefox.executablePath();
const profile = mkdtempSync(join(tmpdir(), "rme-firefox-"));
const firefox = spawn(
  firefoxPath,
  ["--headless", "--no-remote", "--profile", profile, `--remote-debugging-port=${PORT}`],
  {
    stdio: "ignore",
  },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  for (let i = 0; i < 100; i++) {
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${PORT}/session`);
      await new Promise((ok, fail) => {
        socket.onopen = ok;
        socket.onerror = fail;
      });
      return socket;
    } catch {
      await sleep(200);
    }
  }
  throw new Error("Firefox did not start its WebDriver BiDi server");
}

const socket = await connect();
let nextId = 1;
const pending = new Map();
socket.onmessage = (message) => {
  const data = JSON.parse(message.data);
  if (process.env.DEBUG && data.method === "log.entryAdded") {
    console.log("log:", data.params.level, data.params.text);
  }
  if (data.id && pending.has(data.id)) {
    pending.get(data.id)(data);
    pending.delete(data.id);
  }
};

async function send(method, params = {}) {
  const id = nextId++;
  const response = await new Promise((ok) => {
    pending.set(id, ok);
    socket.send(JSON.stringify({ id, method, params }));
  });
  if (response.type === "error") {
    throw new Error(`${method}: ${response.error} ${response.message}`);
  }
  return response.result;
}

async function evaluate(context, expression) {
  const result = await send("script.evaluate", {
    expression,
    target: { context },
    awaitPromise: true,
    resultOwnership: "none",
  });
  if (result.type === "exception") {
    throw new Error(result.exceptionDetails.text);
  }
  return result.result.value;
}

async function waitFor(context, expression, description) {
  for (let i = 0; i < 50; i++) {
    if (await evaluate(context, `!!(${expression})`)) {
      return;
    }
    await sleep(200);
  }
  const page = await evaluate(
    context,
    "JSON.stringify({ title: document.title, editors: document.querySelectorAll('.rme-editor').length, blocks: document.querySelectorAll('.rme-block').length, toggles: document.querySelectorAll('.rme-toggle').length })",
  );
  throw new Error(`Timed out waiting for ${description}: ${page}`);
}

async function typeText(context, text) {
  const actions = [...text].flatMap((key) => [
    { type: "keyDown", value: key },
    { type: "keyUp", value: key },
  ]);
  await send("input.performActions", { context, actions: [{ type: "key", id: "keyboard", actions }] });
}

const checks = [];
function check(name, ok) {
  checks.push([name, ok]);
}

try {
  await send("session.new", { capabilities: {} });
  if (process.env.DEBUG) {
    await send("session.subscribe", { events: ["log.entryAdded"] });
  }
  const installed = await send("webExtension.install", {
    extensionData: { type: "path", path: resolve("dist/extension") },
  });
  if (process.env.DEBUG) {
    console.log("installed", installed);
  }

  const state = JSON.parse(readFileSync(AUTH_FILE, "utf8"));
  for (const cookie of state.cookies) {
    await send("storage.setCookie", {
      cookie: {
        name: cookie.name,
        value: { type: "string", value: cookie.value },
        domain: cookie.domain.replace(/^\./, ""),
        path: cookie.path,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: "lax",
      },
    });
  }

  const { contexts } = await send("browsingContext.getTree", {});
  const context = contexts[0].context;
  await send("browsingContext.navigate", { context, url: `${BASE}/phriction/edit/2/`, wait: "complete" });

  await waitFor(context, "document.querySelector('.rme-editor a.phui-tag-view')", "rendered references");
  check("renders blocks with the server (content script fetch with the session)", true);
  check(
    "applies CodeMirror's styles",
    await evaluate(context, "getComputedStyle(document.querySelector('.rme-editor .cm-scroller')).display === 'flex'"),
  );
  check(
    "applies the editor's styles",
    await evaluate(context, "getComputedStyle(document.querySelector('.cm-line.rme-src-note')).paddingLeft === '12px'"),
  );

  // Click the first note and type at its start.
  const box = await evaluate(
    context,
    "(() => { const r = document.querySelector('.cm-line.rme-src-note').getBoundingClientRect(); return `${r.left + 5},${r.top + r.height / 2}`; })()",
  );
  const [x, y] = box.split(",").map((n) => Math.round(Number(n)));
  await send("input.performActions", {
    context,
    actions: [
      {
        type: "pointer",
        id: "mouse",
        actions: [
          { type: "pointerMove", x, y },
          { type: "pointerDown", button: 0 },
          { type: "pointerUp", button: 0 },
        ],
      },
    ],
  });
  await waitFor(context, "document.querySelector('.rme-editor .cm-focused')", "the focus in the editor");
  // "\uE011" is the Home key; "?" opens the shortcut help of the page.
  await typeText(context, "\uE011Hi? ");
  await waitFor(
    context,
    "document.querySelector('textarea.remarkup-assist-textarea').value.includes('Hi? NOTE: This is a note.')",
    "the typed text in the textarea",
  );
  check("edits the source of a clicked block and updates the textarea", true);
} catch (error) {
  check(String(error.message ?? error), false);
} finally {
  socket.close();
  firefox.kill();
  rmSync(profile, { recursive: true, force: true });
}

for (const [name, ok] of checks) {
  console.log(`${ok ? "✓" : "✘"} ${name}`);
}
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
