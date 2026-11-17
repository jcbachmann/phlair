// Packs the Phorge library, as built (`node build.mjs`), into
// dist/phlair-phorge-<version>.tar.gz with the top directory phlair/ and the
// license in it (docs/PHORGE.md). The files are put together in a folder
// first, so a plain tar packs them, GNU's or BSD's (macOS).

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildVersion } from "./version.mjs";

/** What builds and tests leave in the library's folder, which Phorge does not need. */
const LEFT_OUT = new Set([".phutil_module_cache", "__pycache__"]);

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "dist", `phlair-phorge-${buildVersion().version}.tar.gz`);
const stage = mkdtempSync(join(tmpdir(), "phlair-"));
try {
  cpSync(join(root, "phorge"), join(stage, "phlair"), {
    recursive: true,
    filter: (source) => !LEFT_OUT.has(basename(source)),
  });
  cpSync(join(root, "LICENSE"), join(stage, "phlair", "LICENSE"));
  execFileSync("tar", ["-czf", out, "-C", stage, "phlair"], { stdio: "inherit" });
  console.log(out);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
