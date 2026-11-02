import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
  define: { __BUILD__: JSON.stringify("test"), __TARGET__: JSON.stringify("userscript") },
});
