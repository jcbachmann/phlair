import { execFileSync } from "node:child_process";

// The instance the tests run against (dev/phorge), and where its logins are kept.

export const BASE_URL = "http://phorge.localhost:8098";

/** Where the instance serves its files (security.alternate-file-domain), as production does. */
export const FILES_URL = "http://files.localhost:8098";

export const AUTH_FILE = authFile("admin");

/** The login of a user: "admin" for most tests, "alice" for the editor installed in Phorge (seed.php). */
export function authFile(user: "admin" | "alice"): string {
  return `e2e/.auth/${new URL(BASE_URL).host.replace(/\W/g, "_")}${user === "admin" ? "" : `_${user}`}.json`;
}

/** Runs a command in the Phorge container of the instance, e.g. ["bin/config", "set", ...]. */
export function phabricatorExec(command: string[]): string {
  return execFileSync("docker", ["compose", "exec", "-T", "phorge", ...command], {
    cwd: new URL("../dev/phorge", import.meta.url),
    encoding: "utf8",
  });
}
