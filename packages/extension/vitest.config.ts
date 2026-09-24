import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /**
     * Long, because these tests are not fast and should not be.
     *
     * Loading a wallet scans addresses until it finds a run of empty ones,
     * one request at a time through the same pacer the real thing uses. A
     * test that sends twice does that twice. Making it quick would mean
     * stubbing out the scan, and the scan is part of what is being tested.
     */
    testTimeout: 60_000,
  },
});
