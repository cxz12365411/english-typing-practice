import { defineConfig } from "@playwright/test";

// Release checks must execute the same bundled files that are deployed. npm run test:e2e
// builds them first; the development server remains available for explicit debugging.
const useDevServer = process.env.E2E_WEB_MODE === "development";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:4173",
    channel: process.env.E2E_BROWSER_CHANNEL ?? "chrome",
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  webServer: [
    {
      command: "node e2e/start-api.mjs",
      url: "http://127.0.0.1:8091/api/healthz",
      reuseExistingServer: false,
      timeout: 120_000
    },
    {
      command: useDevServer
        ? "npm run dev --workspace web -- --host localhost --port 4173"
        : "npm run preview --workspace web -- --host localhost --port 4173",
      url: "http://localhost:4173/login",
      reuseExistingServer: false,
      timeout: 120_000
    }
  ]
});
