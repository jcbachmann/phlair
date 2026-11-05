# Phlair

Phlair is a collection of tools for [Phorge](https://we.phorge.it/):

- **[Phizziwig](#phizziwig)**, a live-preview editor for remarkup fields (wiki pages, task descriptions, comments): the
  text looks like the preview while you edit it.
- **[Phuture](#phuture)** snoozes tasks, revisions and any other item of Phorge's lists until a day of your choice.

They are installed in Phorge as a library, where every user turns each tool on or off ([Install](#install)), and come
as a browser extension and a userscript for development.

## Phizziwig

Phizziwig shows the text looking like Phorge renders it, and only what the cursor is on shows its remarkup source: a
link, a bold word, a list item's checkbox. Like Obsidian's live preview, the text is always the text being edited, so
nothing moves when the cursor moves.

![A wiki page in the editor](docs/screenshots/editor.png)

### Rendering

- **Text is always text.** Paragraphs, headers, lists, quotes, notes and rules show their source, styled like
  Phorge's rendering with the page's own CSS (sizes, fonts and colors read from the page), with their markup hidden:
  - references, people, projects, links and URLs (`T12`, `@alice`, `#docs`, `{T12}`, `[[ page ]]`, `https://…`) show as
    Phorge renders them, each rendered by the server; a click on one puts the cursor at its end, `Ctrl`+click opens it;
  - bold, italic, monospaced, struck through, highlighted and underlined text hides its markers;
  - headers hide their markers unless the cursor is on their line; quotes (also the `>>!` of replies), the word of
    `(NOTE)` notes and rules hide theirs; list items show their bullet, number or checkbox (a click on a bullet or number edits it, on a checkbox checks it, left of them goes to the start of the line);
  - icons, keys and navigation paths (`{icon camera color=red}`, `{key Ctrl K}`, `{nav Home > Settings}`) show as
    Phorge draws them;
  - images, image macros and memes show as rendered, their `{F123}` or `{meme, …}` hidden;
  - anchors (`{anchor #name}`), which Phorge does not show, show as their name with a `#` icon.

  Only what the cursor or the selection touches shows its remarkup; markers before text (a header's `= `, a list
  item's `- [ ] `) show when the cursor is in or before them, and `Home` goes to the start of the text first. A click,
  `Home` or `End` next to formatted text puts the cursor outside of its markers, as the text looks: after `**bold**`,
  not before its closing `**`. A click between two blocks goes to the nearer line. The
  text does not have to match Phorge's rendering to the pixel, but nothing moves when the cursor comes or goes.

- **Rendered blocks.** Code blocks, literal blocks and other blocks show as the server renders them (through the
  endpoint the page's preview uses, many blocks in one request, cached per block), and show their source while the
  cursor is in them, in the same place: a code block keeps room for its "```" lines. Blocks on consecutive lines are
  as far apart as on the page, measured with its CSS. Tables are edited as tables, see below.
- **Moving and selecting** works like in a text field: `↑`/`↓` and `Shift+↑/↓` go row by row (also through wrapped lines)
  and keep the column, also through rendered blocks, and the mouse selects exactly the text it goes over (tables as a whole). While the mouse selects, rendered
  blocks stay rendered, with the selected text highlighted.
- **Blank lines** are as high as a line of text, also between blocks, so nothing moves when the cursor comes near
  them (on the page, the space between blocks is Phorge's, and more blank lines than one are ignored).

  ![Editing a paragraph: only the highlighted word with the cursor shows its remarkup](docs/screenshots/editing.png)

- **The text stays remarkup.** There is no conversion to or from HTML: the stored text is exactly what you type. The
  original textarea stays in the form, hidden, and is kept in sync, so saving, drafts, Phorge's toolbar buttons and
  "Quote" keep working.
- **Any theme:** the editor takes its colors from the page, so it follows Phorge's styles and tools
  like Dark Reader.
- **When the server can not render** a block, the block shows its source (and a text block its images do not show), a
  note says so, and rendering is retried.

### Tables

- **Tables are tables:** they look like Phorge's tables and are edited cell by cell; the cell being edited has the live
  preview of the text, so only what the cursor is on shows its remarkup. Typing in a cell changes only that cell in the text; changing rows or columns aligns the table, with columns
  at most 30 characters wide (a longer cell sticks out instead of widening its column).
- **Table bar:** while the cursor is in a table, a bar next to it (above it when there is no room beside it) inserts and
  deletes rows and columns and toggles the header row. **`+` handles** appear on the left and top borders of the table
  when the mouse is near them and insert a row or column there.
- **Keys:** `Tab`/`Shift+Tab` move between cells (and add a row at the end), `Enter` adds a row (on an empty last row it
  leaves the table), arrow keys move between cells and out of the table, `Alt+↑/↓` move rows, `Alt+Shift+←/→` move
  columns, `Ctrl+Z` undoes, and typing `[[` in a cell adds the closing `]]`. A cell is edited like a line of the text:
  formatting buttons and shortcuts, `Ctrl+K`, the link bubble, a URL pasted over selected text,
  uploads (the upload button, pasting and dropping files), Phorge's autocomplete and the insert menu (with what fits in
  a cell) work in cells.
- **New tables** from the table button: pick the size in a grid, and the table opens for editing with its first header
  cell selected.
- **As text:** the first button of the table bar switches to editing tables as aligned text (with `Tab` between cells)
  and back; the choice is remembered. A table the text cursor is in (e.g. a new one being typed) shows its source.

![Editing a table, with the table bar and a + handle](docs/screenshots/tables.png)

### Links and references

- **Link button and `Ctrl+K`** (also `Ctrl+Shift+K`) open a dialog with the **text** and the **target** of a link or
  reference. The target is searched for, or a URL is taken: wiki pages and tasks with the words in their title, then those
  with them in their text; each open ones before closed (deleted or moved) ones, and wiki pages before tasks; then
  people, projects, repositories and other objects. Selected text is the link's text (and stays highlighted while
  the dialog is open); with the cursor on a link or a reference (`T12`, `@alice`) they change it. Without a text, the
  target alone is written (`T12`, `@alice`, a URL); without a target, the text alone; without either, nothing. `Tab`
  goes between the fields, `Enter` applies.
- With the cursor in a link, a **bubble** offers to open, change or remove it. A URL pasted over selected text links it.
- **Phorge's autocomplete menu** for `@user`, `#project`, `[[ wiki page`, `:emoji` and `((short URL`, with the
  same rules and keys (a port of its `PHUIXAutocomplete`).

![Referencing a task by its title](docs/screenshots/search.png)

### Images and files

- **Upload** by pasting or dropping files. Files over 4 MB go in chunks, like Phorge's own uploads, so the server's
  request size limit does not stop them. A line below the text shows the uploads running (with their progress) and the
  ones that failed. A form submitted meanwhile is sent once the uploads are done (_Don't send_ cancels that), not with
  their placeholders in the text.
- **Images** stay visible while their `{F123}` is edited: above the text if the block starts with the image, as on the
  page, and floating beside it if the image floats.
- **Image menu:** right-clicking an image, its "⋯" button (shown on the image under the mouse), a long press on touch
  screens, or `Shift+F10` (or the menu key) with the cursor on its `{F123}` opens a menu for its size, layout, text
  flow and alternative text.

![The image menu](docs/screenshots/image-menu.png)

### Writing

- **Insert menu:** `/` at the start of a line or after a space lists what can be inserted (headings, also by level as `/h2`, lists, table, note, important and warning boxes, code,
  image, image macro (found by name, with its picture, in a list to scroll through), meme, task or revision card,
  anchor, literal text, icon (found by name; a color word like `red` colors it, `spin` makes it spin), keyboard keys,
  navigation path, ASCII art (`cowsay`, `figlet`), mention, emoji, …), grouped under headings (headings, lists,
  blocks, links, text, images, ASCII art); in a table cell, what fits in a cell; type to filter, arrow keys and `Enter` insert. A `/` in a word or path (`and/or`, `/home`) is just text.

  ![The insert menu](docs/screenshots/insert-menu.png)

- **Toolbar** with more buttons than Phorge's, so nobody needs to know the syntax: heading (click again for smaller
  ones), strikethrough, underline, highlight, checklist, note box (click again for important and warning) and horizontal
  line. It stays at the top of the window while you scroll through a long text. Phorge's own bold, italic,
  monospaced, list, code and quote buttons work like the editor's: a second click undoes the first, and list items get
  no indentation.
- **Keyboard shortcuts:** `Ctrl+B`/`I`/`U`/`E` (bold, italic, underline, monospaced), `Ctrl+Shift+X`/`H`
  (strikethrough, highlight), `Ctrl+Shift+1`–`5` (heading levels), `Ctrl+Shift+7`/`8`/`9` (numbered, bulleted,
  checklist), `Ctrl+K` (link). They are named in the tooltips, also of Phorge's own buttons; `F1`, `Ctrl+/` (where
  `/` needs no Shift) or the keyboard button shows them all; the empty editor says so.
- **Find and replace:** `Ctrl+F` in the editor finds in all of the text (the browser's find only sees the part on the
  screen), in a bar below the toolbar; `Enter`/`F3` go to the next match, `Escape` closes it.
- **Menus by keyboard:** the menus (images, shortcuts, Phuture's) take the focus when they open: the arrow keys,
  `Home` and `End` move in them, `Enter` or `Space` chooses, `Escape` and `Tab` close them. The table button's size
  grid goes by the arrow keys too.
- **Wrapping:** typing `*`, `` ` ``, `{` or `[` over selected text puts the text in bold markers, backticks, braces or
  brackets.
- **Lists** switch kinds: the bulleted and numbered buttons and shortcuts turn the items of the list level the cursor is
  in (up to a blank line, or the selected lines) into that kind, and back into text if they already are; their
  checkboxes stay. The checklist button and shortcut give the item the cursor is in (or the selected ones) a checkbox, or
  take it away, whatever kind of list it is in. List
  items are indented by two spaces, like Phorge's buttons write them (` -`, ` #`, ` - [ ]`): `# item` at the
  start of a line is a header. A list starting at the start of the line moves in as a whole.
- **Lists and quotes** continue on `Enter`; `Enter` on an empty item ends them, leaving its line empty. `Backspace` at
  the start of the text of a quote line removes its `>`. `Enter` at the
  start of the text of a list, quote or header makes room above it. `Tab`/`Shift+Tab` indent list items:
  by two spaces, or in a list nested by repeating markers (`- item`, `-- nested`), by one marker.
  `Home` (Pos1) in a list item goes to the start of its text, after the marker and checkbox; pressed again, to the
  start of the line. `↑`/`↓` land in the text of list items too, not before their markers (from before a marker, before
  the next one).
- **Notes and list items have no line breaks** in remarkup: Phorge shows the lines of a note, and the lines continuing a
  list item, as one line, until a blank line. While edited, such lines are marked with a faint `↪` in the margin; a note
  of more lines than one shows on one line, like in Phorge, while the cursor is not in it.
- **Checklists** can be checked and unchecked by clicking their boxes, also items without a bullet (`[ ] item`).
- **Markdown habits:** `*italic*` becomes `//italic//` as it is typed (except in code, monospaced text and URLs; undo
  brings back the `*`). Markdown links `[text](https://…)` work as they are, Phorge renders them.

![All keyboard shortcuts (F1)](docs/screenshots/shortcuts.png)

### Pasting

- **Formatted text** from web pages, e-mails, Word, LibreOffice, Google Docs and Confluence keeps headings, lists,
  tables, links and formatting as remarkup; cells copied from a spreadsheet become a table.
- **Images of this Phorge** in pasted text (copied from a task or wiki page) are not uploaded again: they become
  references to the same files (`{F12}`), with the size and layout they had.
- **Images in pasted text** (e-mails, web pages such as Wikipedia articles) are uploaded and embedded where they were.
  Installed in Phorge, the server downloads images of other sites (within `security.outbound-blacklist`). The
  userscript can fetch them from any site (Tampermonkey asks once to allow that); the extension from sites that allow it
  (CORS), such as Wikipedia. Images that can not be read (e.g. of a web mail behind its login, or attachments
  of a desktop mail program) become a link or their alternative text.
- **Markdown text** becomes remarkup (headings, emphasis, code blocks, images, tables, reference links), as a Markdown
  parser reads it (`@lezer/markdown`, with GitHub's extensions). Headings only get the leading `=`.
- `Ctrl+Shift+V` pastes plain text, and code blocks always get the plain text; undo right after a converted paste brings
  back the plain text.

### Around the editor

- **Out of the way:** the wand button in the remarkup toolbar switches between the editor and the plain textarea, and the
  choice is remembered per browser. Phorge's preview below the form is hidden while the editor shows the same.
- **In dialogs** (editing a task or comment) the editor keeps the height of the text field and scrolls inside, like
  it; everywhere else it grows with the text.
- **Tablets** get all toolbar buttons (Phorge hides most of them there); the toolbar wraps.
- The wand button's tooltip shows the version of the running build (and the build time of a development build).
- **Feedback:** the speech bubble button opens a new task for feedback on the editor in a new tab, with questions and
  the details that help (version, page, browser); screenshots can be pasted into it. Builds can give these tasks a
  project (`PHLAIR_FEEDBACK_PROJECT`, see [docs/PACKAGING.md](docs/PACKAGING.md)).
- **Pinned comment form** ("Pin Form on Screen"): its text scrolls inside it, so the row of "Add Action..." with the
  submit button (on phones an icon) and the toolbar stay in view; a handle on its top border sets its height (also by
  touch), which is
  remembered per browser.
- **Phones** get one row of essential toolbar buttons; "⋯" has the others. Menus open in the middle of the window
  there, and scroll where they do not fit (elsewhere they open where there is room).
- **Fullscreen:** the editor has the page's background (Phorge's text field is a tint over the page).
- **Actions of a comment** can be removed by their X on phones too (Phorge hides it there).
- **Checkboxes in rendered text** can be clicked: in task descriptions, revision summaries and test plans, wiki pages
  and comments, a click checks or unchecks the box at once, and 5 seconds after the last click the boxes clicked are
  saved, one edit per text (only those boxes change, as the page shows them), if you may edit it. A link followed saves
  them first; when the page is hidden or left otherwise (another tab or app, closing, reloading, where the browser asks
  first), they are saved right away, in a request the browser finishes after the page is gone.
  Quitting the browser at once, or a text over 64 KB, can still lose them: browsers give a closing page no more time.

### Limitations

- Hovercards and the lightbox do not work inside the editor, because the rendered HTML comes without Javelin metadata.
  `Ctrl`+click opens links and images.

## Phuture

Phuture puts a clock next to the actions of every item of Phorge's lists: dashboards, searches, workboards, project
and people lists, commits (audits). Lists of choices, like "Choose Subtype" when creating a task, have none.

- **Snooze** an item until tomorrow, next Monday, in a week, in a month or a picked day. It is hidden on every list
  until that day begins in your time zone, also on a page that stays open over midnight.
- **Undo:** a note after snoozing (or waking up) an item undoes it.
- **Below a list** with snoozed items, a line says how many are hidden and shows them (or hides them again).
- **The clock in the main menu** counts the hidden snoozed items of the page, lists all snoozes (the next to wake up
  first) and shows the snoozed items again (_Show snoozed items_): dimmed, with the days until they wake up on their
  clock (red tomorrow, blue in two weeks or later). Their clock menu says until when they sleep and wakes them up now.
- **Bulk edits** leave hidden snoozed tasks out: Maniphest's _Select All_ selects only the tasks shown.
- **Kept in the browser:** snoozes belong to the browser they were made in. _Export snoozes_ and _Import snoozes…_ in
  the main menu's clock take them to another browser. The snoozes of the old "JCB Phabricator Snooze" plugin are
  taken over on the first visit, and its exports can be imported.

![Snoozed tasks shown, and the snooze menu of a task](docs/screenshots/phuture.png)

## Install

**In Phorge** (for everyone, with a setting per user and tool): see [docs/PHORGE.md](docs/PHORGE.md).
Administrators set the defaults in _Global Default Settings → Phlair_, users choose in _Settings → Phlair_.
Both are off by default.

For development, and for instances without the library, the tools also come as a browser extension and a userscript.
They run on the Phorge instances given when they are built:

```bash
npm ci && PHLAIR_HOSTS="https://phorge.example.com/*" npm run build
```

Releases, signing and the store listings: [docs/PACKAGING.md](docs/PACKAGING.md).

- **Firefox:** `about:debugging` → This Firefox → Load Temporary Add-on → `dist/extension/manifest.json`. A permanent
  install needs the extension signed by Mozilla (unlisted).
- **Chrome:** `chrome://extensions` → Developer mode → Load unpacked → `dist/extension`.
- The extension's **options** choose the tools: both are on until turned off there.
- **Userscript** (Violentmonkey, Tampermonkey): install `dist/phlair.user.js`, which runs all tools; add other
  instances in the script's settings. It asks for `GM.xmlHttpRequest` with `@connect *` to fetch the images of pasted
  text from other sites, which Phorge's CSP keeps from the page.

On an instance with the library installed, the tools it starts for the user take precedence: turn a tool off in
_Settings → Phlair_ to try the extension's or userscript's build of it.

## Development

A local Phorge with demo content runs in Docker:

```bash
cd dev/phorge && docker compose up -d
```

It is at http://phorge.localhost:8098/. Log in with the link of `docker compose exec phorge bin/auth recover admin`. The built files are served at `/rme-dev/`, so the editor can
be tried in any page by adding `<script src="/rme-dev/phlair.user.js">`.

| Command                                     | Does                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------- |
| `npm run build`                             | Release build of the library, and for `PHLAIR_HOSTS` the extension.   |
| `npm run build:dev` / `npm run watch`       | Build that also runs on the local instance (needed by the E2E tests). |
| `npm test`                                  | Unit tests (Vitest).                                                  |
| `npm run e2e`                               | Dev build, Playwright tests in Firefox and Chromium, extension test.  |
| `npm run lint:extension`                    | Mozilla's extension linter (`web-ext lint`).                          |
| `npm run screenshots`                       | Takes the screenshots of this README again (local Phorge).            |
| `npm run check`                             | Formatting, types and unit tests.                                     |
| `node scripts/generate-block-fixtures.mjs`  | Regenerates the block splitting fixtures with the PHP engine.         |
| `node scripts/generate-inline-fixtures.mjs` | Regenerates the inline markup fixtures with the PHP engine.           |

Keep the feature lists and the screenshots current with every change of a feature: `npm run screenshots` takes them
again from the local instance, with `scripts/screenshots.spec.ts`.

### How it works

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
  against the PHP engine on ~5000 texts. Rules of equal priority run in PHP 8's order (PHP 7's sort, in the dev
  container, orders a few differently; the tests use that).
- `renderer.ts` renders blocks in batches: the texts are joined with a separator paragraph and the HTML is split at
  the separators.
  Every block but the last one of the text is followed by a separator, because Phorge renders some blocks
  differently at the end of a text.
- `editor/` holds the CodeMirror 6 extensions:
  - `livePreview.ts`: which blocks show as source and which rendered; `imagePreview.ts`: images beside the text;
    `mouseSelection.ts`: clicking and selecting in rendered blocks; `verticalMotion.ts`: `↑`/`↓`; `focus.ts`: when
    the editor counts as focused (also while its searches, panels and menus are); `heights.ts`: the height estimates of
    blocks not drawn yet; `gaps.ts`: the space between blocks on consecutive lines, measured with the page's CSS;
    `inlineTokens.ts`: the inline markup of each block (`inline.ts`) at its place in the text;
    `sourceStyle.ts`: the styling of the source (with `list.ts`, a port of Phorge's list structure, for list levels and
    numbers);
  - `tableEditor.ts`: tables edited as tables (and whether as tables or as text); `commands.ts`: keyboard commands and the table buttons;
    `tablePicker.ts`: the size grid for new tables;
  - `formatting.ts`, `actions.ts`: formatting commands and buttons, the shortcuts; `slashMenu.ts`: the insert menu;
  - `links.ts`, `picker.ts`: links and the search for pages and tasks; `autocomplete.ts`: Phorge's autocomplete;
  - `popup.ts`: Phorge's autocomplete popup, for the menus above;
  - `inlinePreview.ts`: the markup of the text hidden and its references rendered, except where the cursor is;
  - `upload.ts` (with its panel of uploads), `pasting.ts` (with `paste.ts` and `markdownPaste.ts`), `imageMenu.ts`,
    `markdown.ts`; `openLink.ts`: `Ctrl`+click on links; `host.ts`: the textarea.
- `attach.ts` puts the editor in place of the textarea, keeps both in sync and takes fonts, sizes and colors from
  the page. `phorge.ts` holds everything that talks to the server or knows its page structure.

**Phuture** (`src/phuture/`): `days.ts` counts in days (`YYYY-MM-DD` of the browser's time zone, compared as text, so
no time zone or clock change moves a snooze), `snoozes.ts` keeps them (and takes over the old plugin's), `index.ts`
adds the buttons and menus.

`phorge/` is the library installed in Phorge (PHP): a setting per tool (`PhlairToolSetting`), the loader and
`phizziwig.download`, see [docs/PHORGE.md](docs/PHORGE.md). Its script is the same as the extension's, built for
`__TARGET__` `phorge`.
