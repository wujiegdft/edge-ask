import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          CLOUDFLARE_ACCOUNT_ID: "test-account",
          CLOUDFLARE_API_TOKEN: "test-token-not-a-secret",
        },
      },
    }),
  ],
  test: { restoreMocks: true, unstubGlobals: true },
});
