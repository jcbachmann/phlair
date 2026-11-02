import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { firefox, request } from "@playwright/test";
import { authFile, BASE_URL, phabricatorExec } from "./env";

/** Whether the saved session still logs in. */
async function sessionIsValid(user: string, file: string): Promise<boolean> {
  if (!existsSync(file)) {
    return false;
  }
  const context = await request.newContext({ baseURL: BASE_URL, storageState: file });
  try {
    // Logged in, the settings name the user; logged out, it is the login page.
    return (await (await context.get("/settings/")).text()).includes(`/p/${user}/`);
  } finally {
    await context.dispose();
  }
}

/**
 * Logs in as "admin" and "alice" with one-time recovery links and saves the
 * sessions, unless the saved ones are still valid.
 */
export default async function globalSetup(): Promise<void> {
  for (const user of ["admin", "alice"] as const) {
    const file = authFile(user);
    if (!(await sessionIsValid(user, file))) {
      await logIn(user, file);
    }
  }
}

async function logIn(user: string, file: string): Promise<void> {
  const output = phabricatorExec(["bin/auth", "recover", user]);
  const link = /http\S+\/login\/once\/\S+/.exec(output)?.[0];
  if (!link) {
    throw new Error(`No recovery link in: ${output}`);
  }
  mkdirSync("e2e/.auth", { recursive: true });
  const browser = await firefox.launch();
  const page = await browser.newPage();
  await page.goto(link);
  await page.getByRole("button", { name: `Log In (${user})` }).click();
  // Without auth providers, Phorge continues to its auth settings.
  await page.waitForURL((url) => !url.pathname.startsWith("/login/"));
  const state = await page.context().storageState();
  // Firefox reports cookies without SameSite as "None", which Chromium rejects
  // without "Secure". Browsers treat them as "Lax".
  state.cookies = state.cookies.map((cookie) => ({ ...cookie, sameSite: "Lax" }));
  // Written whole, so a run starting meanwhile never reads half a file.
  writeFileSync(`${file}.tmp`, JSON.stringify(state));
  renameSync(`${file}.tmp`, file);
  await browser.close();
}
