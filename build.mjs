// Builds the script of the Phorge library (phorge/rsrc/phlair.js, with its
// Celerity map) and, for the Phorge instances in PHLAIR_HOSTS, the
// userscript (dist/phlair.user.js) and the browser extension for Firefox and
// Chrome (dist/extension/). "--dev" adds the local instance of dev/phorge,
// "--extension" fails without PHLAIR_HOSTS, "--watch" rebuilds on changes.
// The instance settings come from the environment, see docs/PACKAGING.md.

import { createHmac } from "node:crypto";
import * as esbuild from "esbuild";
import { appendFileSync, copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const dev = process.argv.includes("--dev");
const updateUrl = process.env.PHLAIR_UPDATE_URL;
// Over http, anyone on the way could replace the script on its next update.
if (updateUrl && !updateUrl.startsWith("https://")) {
  throw new Error(`PHLAIR_UPDATE_URL must be an https:// URL, not "${updateUrl}"`);
}
const geckoId = process.env.PHLAIR_GECKO_ID;

// Phorge instances the userscript and the extension run on, as match patterns
// ("https://phorge.example.com/*"; they cannot contain a port and match every
// port). Userscript managers let users add more in the script settings.
const MATCHES = [
  ...(process.env.PHLAIR_HOSTS ?? "").split(/[\s,]+/).filter(Boolean),
  ...(dev ? ["http://phorge.localhost/*"] : []),
];
for (const pattern of MATCHES) {
  if (!/^https?:\/\/[^/*]+\/\*$/.test(pattern)) {
    throw new Error(`PHLAIR_HOSTS: "${pattern}" is not of the form https://phorge.example.com/*`);
  }
}
const browserBuilds = MATCHES.length > 0;
if (!browserBuilds) {
  if (process.argv.includes("--extension")) {
    throw new Error("Set PHLAIR_HOSTS to the Phorge instances the extension runs on, see docs/PACKAGING.md");
  }
  console.log("PHLAIR_HOSTS is not set: building the Phorge library only.");
}

const ICON_SIZES = [16, 32, 48, 96, 128];

// Licenses that only require their notice to be shipped with the bundle;
// anything else needs a decision before it is bundled.
const ALLOWED_LICENSES = new Set(["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0"]);

const userscriptHeader = `// ==UserScript==
// @name         Phlair
// @namespace    ${pkg.homepage}
// @version      ${pkg.version}
// @description  ${pkg.description}
// @author       J&C Bachmann GmbH
// @license      MIT
// @icon         data:image/png;base64,${readFileSync("icons/icon-48.png").toString("base64")}
${MATCHES.map((m) => `// @match        ${m}`).join("\n")}
${updateUrl ? `// @updateURL    ${updateUrl}\n// @downloadURL  ${updateUrl}\n` : ""}// @grant        GM.xmlHttpRequest
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-idle
// ==/UserScript==
`;

const manifest = {
  manifest_version: 3,
  name: "Phlair",
  version: pkg.version,
  description: pkg.description,
  icons: Object.fromEntries(ICON_SIZES.map((size) => [size, `icons/icon-${size}.png`])),
  // Firefox grants host permissions at install; matches alone need the user's consent.
  host_permissions: MATCHES,
  // The choice of tools (options page).
  permissions: ["storage"],
  options_ui: { page: "options.html" },
  content_scripts: [{ matches: MATCHES, js: ["content.js"], run_at: "document_idle" }],
  browser_specific_settings: {
    gecko: {
      // Firefox needs it to sign the extension, then keeps it forever (docs/PACKAGING.md).
      ...(geckoId ? { id: geckoId } : {}),
      // 140 (the current ESR) is the first version that knows data_collection_permissions.
      strict_min_version: "140.0",
      // Required by AMO; the editor only talks to the Phorge it runs on.
      data_collection_permissions: { required: ["none"] },
    },
    gecko_android: { strict_min_version: "142.0" },
  },
  // The bundle is built for Chrome 120 (see the esbuild target below).
  minimum_chrome_version: "120",
};

// The license texts of the npm packages in the bundle (MIT & co. require their
// notice to be shipped with it) and of the icons' font. Throws for a package
// without a license file or with a license not in ALLOWED_LICENSES.
function thirdPartyNotices(metafile) {
  const dirs = new Set(
    Object.keys(metafile.inputs).map((input) => input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//)?.[1]),
  );
  dirs.delete(undefined);
  const notices = [...dirs].sort().map((dir) => {
    const { name, version, license } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (!ALLOWED_LICENSES.has(license)) {
      throw new Error(`${name} is bundled, but its license "${license}" is not in ALLOWED_LICENSES (build.mjs)`);
    }
    // Apache-2.0 also requires a NOTICE file to be passed on.
    const files = readdirSync(dir).filter((file) => /^(licen[cs]e|notice)/i.test(file));
    if (!files.some((file) => /^licen[cs]e/i.test(file))) {
      throw new Error(`${name} is bundled, but has no license file`);
    }
    const texts = files.map((file) => readFileSync(join(dir, file), "utf8").trim());
    return `${name} ${version} (${license})\n\n${texts.join("\n\n")}`;
  });
  notices.push(
    [
      "Phabricator (Apache-2.0): the block rules of src/phizziwig/blocks.ts, the list",
      "structure of src/phizziwig/list.ts, the autocomplete of",
      "src/phizziwig/editor/autocomplete.ts and the tooltip placement of",
      "src/phizziwig/tooltip.ts are ported from Phorge's PhutilRemarkupEngine,",
      "PhutilRemarkupListBlockRule, PHUIXAutocomplete and JX.Tooltip, and changed",
      "for Phizziwig.",
      "",
      readFileSync("licenses/Phabricator-NOTICE.txt", "utf8").trim(),
      "",
      readFileSync("licenses/Phabricator-LICENSE.txt", "utf8").trim(),
    ].join("\n"),
    `Font Awesome 4.7, in the icons (OFL-1.1)\n\n${readFileSync("icons/FontAwesome-OFL.txt", "utf8").trim()}`,
  );
  const separator = `\n\n${"=".repeat(80)}\n\n`;
  return `Phlair includes the following third-party software.${separator}${notices.join(separator)}\n`;
}

// Writes the notices after every successful build (also on rebuilds in watch mode).
function notices(write) {
  return {
    name: "notices",
    setup(build) {
      build.onEnd((result) => {
        if (result.errors.length === 0) {
          write(thirdPartyNotices(result.metafile));
        }
      });
    },
  };
}

const options = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "iife",
  target: ["firefox140", "chrome120"],
  loader: { ".css": "text" },
  // The notices are taken from the packages' license files instead, see thirdPartyNotices.
  legalComments: "none",
  metafile: true,
  logLevel: "info",
  // Shown in the tooltip of the editor's toggle, to tell which build runs. A
  // release build is the same for the same sources (AMO's source review
  // rebuilds it; Phorge serves an unchanged script under the same URL), so
  // only development builds have the time.
  define: {
    __BUILD__: JSON.stringify(
      dev ? `${pkg.version} dev, ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC` : pkg.version,
    ),
    __TARGET__: JSON.stringify("extension"),
  },
};
const target = (name) => ({ ...options.define, __TARGET__: JSON.stringify(name) });

// Celerity reads what a script provides from its first doc comment, and must
// not minify it again (its minifier is not made for esbuild's output). It
// needs Javelin's "javelin-behavior", which every page of Phorge loads first.
const PHORGE_SCRIPT = "phorge/rsrc/phlair.js";
/**
 * Writes the Celerity map of the library's script, as "bin/celerity map" in
 * Phorge would: hashes with Celerity's fixed HMAC key, so Phorge
 * serves the script under a new URL after each change.
 */
function writeCelerityMap() {
  const hash = (data) => createHmac("sha256", "celerity-resource-data").update(data).digest("hex").slice(0, 8);
  const name = "phlair.js";
  const resource = hash(hash(readFileSync(PHORGE_SCRIPT)) + name);
  mkdirSync("phorge/resources/celerity", { recursive: true });
  writeFileSync(
    "phorge/resources/celerity/map.php",
    `<?php

/**
 * This file is automatically generated by build.mjs, like 'bin/celerity map'.
 *
 * @generated
 */
return array(
  'names' => array(
    '${name}' => '${resource}',
  ),
  'symbols' => array(
    'javelin-behavior-phlair' => '${resource}',
  ),
  'requires' => array(),
  'packages' => array(),
);
`,
  );
}

const celerityHeader = `/**
 * Phlair ${pkg.version}, built by build.mjs: a Javelin behavior, which the
 * library's main menu extension starts with the tools the user has on.
 *
 * @provides javelin-behavior-phlair
 * @do-not-minify
 */
`;

// A fresh directory, so a package never contains files of an older build.
rmSync("dist/extension", { recursive: true, force: true });
rmSync("dist/phlair.user.js", { force: true });
if (browserBuilds) {
  mkdirSync("dist/extension/icons", { recursive: true });
  writeFileSync("dist/extension/manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  copyFileSync("LICENSE", "dist/extension/LICENSE");
  copyFileSync("src/options.html", "dist/extension/options.html");
  for (const size of ICON_SIZES) {
    copyFileSync(`icons/icon-${size}.png`, `dist/extension/icons/icon-${size}.png`);
  }
}

const userscript = "dist/phlair.user.js";
const browserTargets = [
  {
    ...options,
    define: target("userscript"),
    outfile: userscript,
    banner: { js: userscriptHeader },
    plugins: [
      notices((text) =>
        appendFileSync(
          userscript,
          `\n/*\n${text.trimEnd().replaceAll("*/", "* /").replace(/^/gm, " * ").replace(/ +$/gm, "")}\n */\n`,
        ),
      ),
    ],
  },
  {
    ...options,
    outfile: "dist/extension/content.js",
    plugins: [notices((text) => writeFileSync("dist/extension/THIRD_PARTY_LICENSES.txt", text))],
  },
  {
    ...options,
    entryPoints: ["src/options.ts"],
    outfile: "dist/extension/options.js",
    // Its packages are in the notices of content.js.
    metafile: false,
  },
];
const builds = [
  ...(browserBuilds ? browserTargets : []),
  {
    ...options,
    define: target("phorge"),
    outfile: PHORGE_SCRIPT,
    banner: { js: celerityHeader },
    plugins: [
      notices((text) => {
        writeFileSync("phorge/THIRD_PARTY_LICENSES.txt", text);
        writeCelerityMap();
      }),
    ],
  },
];

if (process.argv.includes("--watch")) {
  for (const build of builds) {
    await (await esbuild.context(build)).watch();
  }
} else {
  await Promise.all(builds.map((build) => esbuild.build(build)));
}
