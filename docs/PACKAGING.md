# Packaging and Release

## Builds

The repository holds no instance: what a build is for comes from the environment.

| Variable            | For                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PHLAIR_HOSTS`      | The Phorge instances the extension and userscript run on, e.g. `https://phorge.example.com/*` (several separated by spaces or commas). Without it, only the Phorge library is built. |
| `PHLAIR_GECKO_ID`   | The Firefox add-on ID, e.g. `phlair@example.com`: needed to sign the extension, see [Firefox](#firefox-unlisted-signed-by-mozilla).                                                  |
| `PHLAIR_UPDATE_URL` | Where the userscript is hosted, see [Userscript](#userscript).                                                                                                                       |

| Command                         | Builds                                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| `npm run build`                 | Release build: the library, and the extension and userscript for `PHLAIR_HOSTS`.   |
| `npm run build:dev`             | Development build: also runs on `http://phorge.localhost/*`.                       |
| `npm run watch`                 | Development build, rebuilt on changes.                                             |
| `npm run e2e`                   | Makes a development build first (`pree2e`), as the tests run against `dev/phorge`. |
| `npm run lint:extension`        | Checks `dist/extension` with Mozilla's add-on linter (`web-ext lint`).             |
| `npm run package`               | Release build, then `dist/phlair-<version>.zip` for AMO and Chrome.                |
| `npm run package:phorge`        | Release build, then `dist/phlair-phorge.tar.gz`, see [PHORGE.md](PHORGE.md).       |
| `npm run sign:firefox`          | Release build, then signs it on AMO as an unlisted add-on (`.xpi` in `dist/`).     |
| `node scripts/render-icons.mjs` | Regenerates `icons/` (see [Icons](#icons)).                                        |

`package` and `sign:firefox` fail without `PHLAIR_HOSTS`. The builds produce `dist/phlair.user.js`, `dist/extension/`
(manifest, `content.js`, the options page, icons, `LICENSE`, `THIRD_PARTY_LICENSES.txt`) and the script of the Phorge
library in `phorge/`. Never ship a development build: it asks for access to the `localhost` hosts. The web-ext
settings (source and artifacts directory, zip name, channel) are in the `webExt` key of `package.json`.

The version comes from `package.json`; AMO and the Chrome Web Store refuse a version they already have. Raise it with
`npm version patch` (or `minor`/`major`): that updates `package.json` and `package-lock.json` together and makes a commit
and a tag for the release. Phizziwig's wand button shows the version of the running build in its tooltip, a
development build also its build time. A release build has no time in it: the same sources give the same files,
which AMO's source review expects, and an unchanged script keeps its URL in Phorge.

## Userscript

`dist/phlair.user.js` is unminified, runs all tools and installs from any URL in Violentmonkey or Tampermonkey. Build
it with `PHLAIR_UPDATE_URL=<URL of the .user.js>` for `@updateURL` and `@downloadURL`, so the userscript managers
update it.

## Firefox (unlisted, signed by Mozilla)

Firefox only installs signed add-ons permanently. An unlisted add-on is signed by AMO without a public listing and is
distributed by whoever signed it.

1. Log in to https://addons.mozilla.org/developers/ and create an API key under _Tools → Manage API Keys_.
2. Choose the add-on ID (`PHLAIR_GECKO_ID`) once: AMO ties it to the account that signs it first, and Firefox treats an
   add-on with another ID as another add-on, so it must never change.
3. Raise the version (`npm version patch`), then run
   `PHLAIR_HOSTS=... PHLAIR_GECKO_ID=... WEB_EXT_API_KEY=<JWT issuer> WEB_EXT_API_SECRET=<JWT secret> npm run sign:firefox`.
   The signed `.xpi` lands in `dist/`.
4. Install it by opening the `.xpi` in Firefox (or _about:addons_ → gear → _Install Add-on From File_), or for everyone
   through the enterprise policy `ExtensionSettings` (`policies.json` or Group Policy):
   `{"<add-on ID>": {"installation_mode": "force_installed", "install_url": "<URL of the .xpi>"}}`.

AMO may review unlisted add-ons after signing. As `content.js` is generated (bundled from TypeScript), reviewers can ask for
the sources: attach them with `npm run sign:firefox -- --upload-source-code <zip>`, e.g. a `git archive --format=zip HEAD`,
and point to the build instructions (`npm ci && npm run build` with the variables above, Node 22 or newer). Automatic
updates would need an `update_url` in the manifest pointing to a hosted `updates.json`; that is not set up.

The manifest declares `data_collection_permissions: none` (required by AMO), which Firefox knows since 140 (Android 142),
hence the minimum versions.

## Chrome Web Store

The zip from `npm run package` is uploaded by hand:

1. Register at the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) (one-time fee),
   preferably with a company Google account or group publisher.
2. _New item_ → upload `dist/phlair-<version>.zip`. Chrome warns about the unknown key
   `browser_specific_settings` (Firefox's); that is harmless.
3. **Store listing:** description, category (Developer Tools or Workflow & Planning), language, the 128 px icon
   (`icons/icon-128.png`, which follows Chrome's 96 px artwork with 16 px margin), at least one screenshot (1280×800 or
   640×400, e.g. a wiki page being edited) and the small promo tile (440×280) if the dashboard asks for it.
   Phlair's sources do not name an instance, so a public listing would need instances chosen by each user (optional host
   permissions), which the extension does not support: list it for your own instances only.
4. **Privacy practices:**
   - Single purpose: "Tools for our Phorge: an editor for its remarkup text fields that shows the rendered preview
     while editing, and snoozing of the items of its lists."
   - Host permission justification: "Runs only on our Phorge (<host>) to replace its remarkup text fields and add
     snooze buttons to its lists. It renders previews and uploads files through that Phorge's own endpoints with the
     user's existing session." The `storage` permission keeps the choice of tools of the options page.
   - Remote code: no (all code is in the package; the HTML from Phorge's preview endpoint is content, not code).
   - Data usage: no user data is collected; requests go to the Phorge the page belongs to and, for images in pasted
     content, to the sites those images come from (without cookies), to upload them to that Phorge; tick the three
     certifications. A privacy policy URL is only required when user data is handled.
5. **Distribution:** visibility _Private_ (only users of the company's Google Workspace domain or listed testers) or
   _Unlisted_ (anyone with the link). Submit for review.

Updates: raise the version, `npm run package`, upload the new zip under _Package_ and submit again.

To install it for everyone in the company: Google Admin console (or the Windows Group Policy `ExtensionInstallForcelist`)
with the item ID from the dashboard, e.g. `<item ID>;https://clients2.google.com/service/update2/crx`. Chrome then
installs and updates it from the store.

## Minification

The extension is shipped unminified, like the userscript. AMO accepts minified code, but since the bundle is generated it
asks for the sources either way, and reviewers read unminified code (with module comments like `// src/renderer.ts`)
directly. The size does not matter for a content script loaded from the installed package: `content.js` is about 900 KB,
the zip about 250 KB. Unminified code also gives readable stack traces in bug reports.

## Linter

`npm run lint:extension` checks the extension as AMO does, so it needs a build with `PHLAIR_GECKO_ID` (AMO requires the
ID; without it the linter reports `ADDON_ID_REQUIRED`); then it passes without errors or warnings. HTML from the server
(the same HTML the page's own preview shows) is parsed with `DOMParser` in `src/phizziwig/html.ts` and inserted as
nodes, not assigned to `innerHTML`, which AMO reviewers flag. Pasted HTML is only parsed there and turned into
remarkup, never inserted.

## Licenses

Phlair is MIT licensed (`LICENSE`, Copyright (c) 2026 J&C Bachmann GmbH).

The bundle contains these npm packages, all under the MIT license (as of version 0.1.0): `@codemirror/commands`,
`@codemirror/language`, `@codemirror/state`, `@codemirror/streamparser`, `@codemirror/view`, `@lezer/common`,
`@lezer/highlight`, `@marijn/find-cluster-break`, `crelt`, `style-mod` and `w3c-keyname`. MIT requires
their copyright and permission notice to be shipped with the code: `build.mjs` takes the packages that end up in the
bundle from esbuild's metafile and writes their license files to `dist/extension/THIRD_PARTY_LICENSES.txt` and into a
comment at the end of the userscript. The build fails if a bundled package has no license file or a license other than
MIT, ISC, BSD-2-Clause, BSD-3-Clause or Apache-2.0 (`ALLOWED_LICENSES`), so a new dependency cannot slip in a license
that needs a decision.

Parts of Phizziwig are ported from Phabricator (Apache License 2.0): the block rules in `src/phizziwig/blocks.ts`, the
list structure in `src/phizziwig/list.ts`, the autocomplete in `src/phizziwig/editor/autocomplete.ts` and the tooltip
placement in `src/phizziwig/tooltip.ts`. Apache-2.0 requires its license and
NOTICE file to be passed on and changed files to say so: the files say so in their header, and `licenses/` holds
Phabricator's `LICENSE` and `NOTICE`, which the build adds to the third-party notices.

The wand in the icons is the "magic" glyph of [Font Awesome 4.7](https://fontawesome.com/v4/) by Dave Gandy, whose font is
under the SIL Open Font License 1.1. The OFL allows using the font in images; the icons contain no font data. It is
credited with the license in `icons/FontAwesome-OFL.txt`, which is part of the third-party notices.

## Icons

`icons/icon-<size>.png` (16, 32, 48, 96, 128 px) show the editor's toggle button while on: the blue of Phorge's
active toolbar button with Font Awesome's wand and the button's glow, on a transparent background. They are used for the
extension (`icons` in the manifest) and, at 48 px as a data URL, for the userscript's `@icon`. To change them, edit and
run `scripts/render-icons.mjs` (Playwright's Chromium); it takes the font from the local Phorge (`dev/phorge`)
or from a `fontawesome-webfont.woff2` given as argument.
