import { defineConfig } from "vitest/config";

// Tests that hit the public Pearl indexers. Kept out of the default run so
// `pnpm test` never depends on the network.
export default defineConfig({
  test: {
    include: ["test/live/**/*.live.ts"],
    testTimeout: 60_000,
  },
});
