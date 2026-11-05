// The version of a build, from package.json and git, so every build of a commit
// carries the same one without a release: "0.1.0.42" is package.json's version
// with the number of commits up to the built one as a fourth part (browsers and
// userscript managers compare versions as numbers, so it rises with every
// commit on main, and stays below the next release, 0.1.1). The label adds the
// commit and its date ("0.1.0.42 (1a2b3c4, 2026-11-05)"), "-dirty" when the
// working tree has changes. Both depend only on the commit: the same sources
// give the same files (docs/PACKAGING.md). Without git (e.g. sources from
// `git archive`) the version is package.json's alone.
// Run as a script, it prints the version (for file names and CI).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export function buildVersion() {
  const base = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  let info;
  try {
    info = {
      count: git("rev-list", "--count", "HEAD"),
      commit: git("rev-parse", "--short=7", "HEAD"),
      date: new Date(Number(git("show", "-s", "--format=%ct", "HEAD")) * 1000).toISOString().slice(0, 10),
      dirty: git("status", "--porcelain", "--untracked-files=no") !== "",
      shallow: git("rev-parse", "--is-shallow-repository") === "true",
    };
  } catch {
    console.warn(`No git repository: the version is ${base} without a commit.`);
    return { version: base, label: `${base} (no git)` };
  }
  // A shallow clone counts only the commits it has.
  if (info.shallow) {
    throw new Error(
      "The repository is a shallow clone: fetch its whole history (git fetch --unshallow) to number the build.",
    );
  }
  const version = `${base}.${info.count}`;
  return { version, label: `${version} (${info.commit}${info.dirty ? "-dirty" : ""}, ${info.date})` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(buildVersion().version);
}
