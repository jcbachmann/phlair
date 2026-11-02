import { defineConfig, devices } from "@playwright/test";
import { AUTH_FILE, BASE_URL } from "./e2e/env";

// Runs against the local Phorge of dev/phorge ("docker compose up -d" there
// first) with the built editor ("npm run build:dev").
export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL: BASE_URL,
    storageState: AUTH_FILE,
    viewport: { width: 1280, height: 900 },
  },
  projects: [
    { name: "firefox", use: { ...devices["Desktop Firefox"], viewport: { width: 1280, height: 900 } } },
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } },
  ],
});
