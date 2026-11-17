# Development

Needs Node 22 or newer, and Docker for the local Phorge.

## Local Phorge

A local Phorge with demo content runs in Docker:

```bash
cd dev/phorge && docker compose up -d
```

It is at http://phorge.localhost:8098/. Log in with the link of `docker compose exec phorge bin/auth recover admin`
(or `alice`). The built files are served at `/rme-dev/`, so the editor can be tried in any page by adding
`<script src="/rme-dev/phlair.user.js">`. The instance loads the library from `phorge/` of the repository, see
[PHORGE.md](PHORGE.md#developers).

## Commands

| Command                                     | Does                                                                   |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| `npm run build`                             | Release build of the library, and for `PHLAIR_HOSTS` the extension.    |
| `npm run build:dev` / `npm run watch`       | Build that also runs on the local instance (needed by the E2E tests).  |
| `npm run check`                             | Formatting, types and unit tests (`npm run format` formats).           |
| `npm test`                                  | Unit tests (Vitest).                                                   |
| `npm run e2e`                               | Dev build, Playwright tests in Firefox and Chromium, extension test.   |
| `npm run test:linux`                        | Tests of OneDriphe for Linux (Python).                                 |
| `npm run test:windows`                      | Tests of OneDriphe for Windows, in a PowerShell container.             |
| `npm run lint:extension`                    | Mozilla's extension linter (`web-ext lint`).                           |
| `npm run screenshots`                       | Takes the screenshots of the docs again (local Phorge).                |
| `node scripts/generate-block-fixtures.mjs`  | Regenerates the block splitting fixtures with the PHP engine.          |
| `node scripts/generate-inline-fixtures.mjs` | Regenerates the inline markup fixtures with the PHP engine.            |
| `npm run package`, `npm run package:phorge` | Release packages of the extension and the library, see [PACKAGING.md]. |

[PACKAGING.md]: PACKAGING.md

GitHub Actions (`.github/workflows/check.yml`) runs on every push: `npm run check` and the extension linter (on two
Node versions), the library's PHP syntax (on several PHP versions), OneDriphe's tests on Windows and Linux, and the E2E
tests against a fresh Phorge of `dev/phorge`; the report of a failed run is attached to it as `playwright-report`.

Keep the feature lists ([PHIZZIWIG.md](PHIZZIWIG.md), [PHUTURE.md](PHUTURE.md)) and the screenshots current with every
change of a feature: `npm run screenshots` takes them again from the local instance, with
`scripts/screenshots.spec.ts`.

## How it works

`src/main.ts` starts the tools, each once per page: the one installed in Phorge first, else the extension's or the
userscript's (`data-phizziwig` / `data-phuture` on the root element say which runs). Installed in Phorge, the library's
main menu extension starts it as the Javelin behavior `phlair` with the tools the user has on; the extension reads its
options (`src/tools.ts`, `src/options.ts`). `src/dropdown.ts` (Phorge's dropdown menus) and `src/storage.ts` are
shared.

**Phizziwig** (`src/phizziwig/`):

- `blocks.ts` splits the text into top-level blocks exactly like `PhutilRemarkupEngine` (a port of the block rules).
  `test/blocks.test.ts` checks it against the PHP engine on ~3000 texts.
- `inline.ts` finds the inline markup of a block like Phorge's inline rules (a port of the rules, in their order):
  formatting (also across lines), links, references, mentions, embeds, icons, emoji. `test/inline.test.ts` checks it
  against the PHP engine on ~5000 texts. Rules of equal priority run in the order they are registered in, as PHP 8
  sorts them (the library is made and tested for PHP 8.4, which the dev container runs).
- `renderer.ts` renders blocks in batches: the texts are joined with a separator paragraph and the HTML is split at
  the separators. Every block but the last one of the text is followed by a separator, because Phorge renders some
  blocks differently at the end of a text.
- `sharepoint.ts` reads SharePoint and OneDrive URLs (kind of file, name, site, desktop app); `sharePointLinks.ts`
  shows such links in rendered text, with a menu of the ways to open them, one of them
  [OneDriphe](../phorge/onedriphe/README.md)'s; `localPaths.ts` makes SharePoint URLs of pasted local paths.
- `editor/` holds the CodeMirror 6 extensions:
  - `livePreview.ts`: which blocks show as source and which rendered; `imagePreview.ts`: images beside the text;
    `mouseSelection.ts`: clicking and selecting in rendered blocks; `verticalMotion.ts`: `↑`/`↓`; `focus.ts`: when
    the editor counts as focused (also while its searches, panels and menus are); `heights.ts`: the height estimates of
    blocks not drawn yet; `gaps.ts`: the space between blocks on consecutive lines, measured with the page's CSS;
    `inlineTokens.ts`: the inline markup of each block (`inline.ts`) at its place in the text;
    `sourceStyle.ts`: the styling of the source (with `list.ts`, a port of Phorge's list structure, for list levels and
    numbers);
  - `tableEditor.ts`: tables edited as tables (and whether as tables or as text); `commands.ts`: keyboard commands and
    the table buttons; `tablePicker.ts`: the size grid for new tables;
  - `formatting.ts`, `actions.ts`: formatting commands and buttons, the shortcuts; `slashMenu.ts`: the insert menu;
  - `links.ts`, `picker.ts`: links and the search for pages and tasks; `autocomplete.ts`: Phorge's autocomplete;
  - `popup.ts`: Phorge's autocomplete popup, for the menus above;
  - `inlinePreview.ts`: the markup of the text hidden and its references rendered, except where the cursor is;
  - `upload.ts` (with its panel of uploads), `pasting.ts` (with `paste.ts` and `markdownPaste.ts`), `imageMenu.ts`,
    `markdown.ts`; `openLink.ts`: `Ctrl`+click on links; `host.ts`: the textarea.
- `attach.ts` puts the editor in place of the textarea, keeps both in sync and takes fonts, sizes and colors from
  the page. `phorge.ts` holds everything that talks to the server or knows its page structure.

**Phuture** (`src/phuture/`): `days.ts` counts in days (`YYYY-MM-DD` of the browser's time zone, compared as text, so
no time zone or clock change moves a snooze), `snoozes.ts` keeps them, `index.ts` adds the buttons and menus.

**The Phorge library** (`phorge/`, PHP) holds the settings, the loader, the server's parts of the tools and
OneDriphe; [PHORGE.md](PHORGE.md) lists its classes. Its script is the same as the extension's, built for
`__TARGET__` `phorge`.

**OneDriphe** (`phorge/onedriphe/`): the helpers for Windows (PowerShell) and Linux (Python), with their own
[README](../phorge/onedriphe/README.md).
