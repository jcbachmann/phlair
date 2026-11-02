// Takes the screenshots of docs/screenshots (npm run screenshots), against the
// local Phorge like the E2E tests.
import { defineConfig, devices } from "@playwright/test";
import { AUTH_FILE, BASE_URL } from "../e2e/env";

export default defineConfig({
  testDir: ".",
  testMatch: "screenshots.spec.ts",
  globalSetup: "../e2e/global-setup.ts",
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: BASE_URL,
    storageState: AUTH_FILE,
    viewport: { width: 1280, height: 900 },
  },
});
