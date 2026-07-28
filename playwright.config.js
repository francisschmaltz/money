import { defineConfig } from "@playwright/test";

const demoScenario =
  process.env.DEMO_SCENARIO === "ux-stress"
    ? "ux-stress"
    : "default";
const port = demoScenario === "ux-stress" ? 4174 : 4173;
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
    command: `NODE_ENV=test DEMO_MODE=true DEMO_SCENARIO=${demoScenario} AUTH_MODE=mock DATABASE_URL= HOST=127.0.0.1 PORT=${port} PUBLIC_BASE_URL=${baseURL} node app/index.js`,
    url: `${baseURL}/health/ready`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
