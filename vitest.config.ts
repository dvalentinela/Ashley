import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            APP_ENV: "test",
            APP_URL: "http://localhost",
            BETTER_AUTH_SECRET: "test-secret-0123456789abcdef0123456789abcdef",
            OPERATOR_EMAILS: "jack@operator.test",
            EMAIL_PROVIDER: "dev",
            AI_PROVIDER: "fake",
            AI_MODEL: "fake-planner-1",
            AI_PRICE_INPUT_USD_PER_MTOK: "1",
            AI_PRICE_OUTPUT_USD_PER_MTOK: "5",
            AI_MONTHLY_BUDGET_USD: "5",
            DISPATCH_IMMEDIATE: "false",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/setup.ts"],
      include: ["test/**/*.test.ts"],
    },
  };
});
