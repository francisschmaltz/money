import { defineConfig } from "@playwright/test";

const port = 4173;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `NODE_ENV=test DEMO_MODE=true AUTH_MODE=mock DATABASE_URL= HOST=127.0.0.1 PORT=${port} PUBLIC_BASE_URL=${baseURL} node app/index.js`,
    url: `${baseURL}/health/ready`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
