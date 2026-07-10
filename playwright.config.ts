import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  use: {
    baseURL: "http://127.0.0.1:4173",
    screenshot: "only-on-failure",
    trace: "on-first-retry"
  },
  webServer: {
    command: "bun run build:v2 && bun run preview -- --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"] }
    },
    {
      name: "desktop-webkit",
      use: { ...devices["Desktop Safari"] }
    },
    {
      name: "mobile-webkit",
      use: {
        ...devices["iPhone 13"],
        viewport: { width: 390, height: 844 }
      }
    }
  ]
});
