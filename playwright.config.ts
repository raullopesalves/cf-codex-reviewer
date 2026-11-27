import { defineConfig, devices } from "@playwright/test";

// Smoke test against a running deployment: SMOKE_URL=https://<worker>.workers.dev npm run smoke
export default defineConfig({
  testDir: "smoke",
  timeout: 240_000,
  retries: 0,
  reporter: "list",
  use: { baseURL: process.env.SMOKE_URL ?? "http://localhost:8787", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
});
