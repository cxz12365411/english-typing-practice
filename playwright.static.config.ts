import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "static-*.spec.ts",
  fullyParallel: true,
  workers: 2,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: "list",
  outputDir: "test-results/static-speech",
  use: {
    baseURL: "http://127.0.0.1:18766",
    channel: process.env.E2E_BROWSER_CHANNEL ?? "chrome",
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  webServer: {
    command: "python3 -m http.server 18766 --bind 127.0.0.1",
    url: "http://127.0.0.1:18766/index.html",
    reuseExistingServer: false,
    timeout: 15_000
  }
});
