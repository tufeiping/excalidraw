import { defineConfig } from "vitest/config";

export default defineConfig({
  base: "/app/",
  test: {
    setupFiles: ["./setupTests.ts"],
    globals: true,
    environment: "jsdom",
    coverage: {
      reporter: ["text", "json-summary", "json", "html", "lcovonly"],
      thresholds: {
        lines: 70,
        branches: 70,
        functions: 68,
        statements: 70,
      },
    },
  },
});
