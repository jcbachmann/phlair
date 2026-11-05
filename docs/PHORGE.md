# Installing Phlair in Phorge

Phlair comes as a Phorge library (`phorge/` in this repository) that the server loads through
`load-libraries`. It needs no patch: it only uses Phorge's extension points, so it survives Phorge upgrades.

| Part                                    | Class                                | Does                                                                  |
| --------------------------------------- | ------------------------------------ | --------------------------------------------------------------------- |
| A setting per tool (On, Off)            | `PhizziwigSetting`, `PhutureSetting` | Per user; Phorge adds _Default_, which follows the default.           |
| Settings panel, also in global defaults | `PhlairSettingsPanel`                | Users choose in _Settings → Phlair_.                                  |
| Loads the tools                         | `PhlairMainMenuBarExtension`         | Starts `rsrc/phlair.js` on every page with the tools the user has on. |
| The script                              | `PhlairCelerityResources`            | Serves `rsrc/phlair.js` through Celerity (cached, versioned URLs).    |
| Images of pasted text from other sites  | `PhizziwigDownloadConduitAPIMethod`  | `phizziwig.download`: the server downloads and stores the image.      |

A new tool is a new subclass of `PhlairToolSetting`, whose key names the tool in the script (`src/tools.ts`).

## Build

```bash
npm ci && npm run package:phorge
```

This builds `phorge/rsrc/phlair.js` with its Celerity map (`phorge/resources/celerity/map.php`) and the
notices of the bundled packages (`phorge/THIRD_PARTY_LICENSES.txt`), and packs the library with the license into
`dist/phlair-phorge-<version>.tar.gz` (top directory `phlair/`; the version is in the first lines of
`phlair/rsrc/phlair.js`, see [PACKAGING.md](PACKAGING.md#versions)). The class map `phorge/src/__phutil_library_map__.php`
is in the repository; after adding or renaming a PHP class, regenerate it with `arc liberate phorge/src` (or with
the arc of the dev container, see `dev/phorge`).

## Install

1. Unpack the archive on the Phorge server, next to Phorge and `arcanist/`, e.g. to `/srv/phlair`.
2. Add the library to `load-libraries`, keeping the libraries already listed there:
   `bin/config set load-libraries '["/srv/phlair/src"]'`.
3. Restart the web server (PHP's opcode cache) and the daemons (`bin/phd restart`).

Updates: replace the directory and restart the web server. The script's URL contains a hash of its content, so browsers
load the new version right away.

## Who gets what

- **Defaults:** every tool is off, so installing Phlair changes nothing until someone turns a tool on: testers for
  themselves, then the administrator for everyone in _Settings → Global Default Settings → Phlair_.
- **Users** choose per tool in _Settings → Phlair_: _Default (On/Off)_ follows the default, _On_ and _Off_ are their
  own choice. Phizziwig's wand button in the remarkup toolbar switches to the plain text field for the page only.
- **Nobody:** remove the library from `load-libraries`. The stored settings stay and apply again if it is added back.

## Images of pasted text

The page itself can only read images of its own site: Phorge's Content-Security-Policy forbids it other sites. For
the images of pasted e-mails and web pages (e.g. Wikipedia), Phizziwig asks the server through `phizziwig.download`,
which downloads the image like Phorge's image proxy: with `security.outbound-blacklist`, which by default keeps
the server from fetching addresses of private networks, and with Phorge's rate limit for such requests of a user. Images of intranet sites therefore stay links, unless that
setting allows them. Only users who have Phizziwig on can call the method; it stores images only.

## Developers

A development build of the userscript or the browser extension runs next to the installed one; for each tool, whichever
starts first takes the page, and the installed one starts first. To try a development build of a tool on an instance
that has Phlair installed, turn the tool off in _Settings → Phlair_.

The local instance of `dev/phorge` loads the library from the repository (built by `npm run build:dev`). Phizziwig is
off in its Global Default Settings, so the E2E tests inject the userscript, and on for `alice`, whose session
`e2e/phorge.spec.ts` uses to test the installed library. After changing the library's PHP code, reload its web server
(`docker compose exec phorge apachectl -k graceful` in `dev/phorge`), as on a real server: PHP's caches keep the old
code, e.g. a setting's old default.
