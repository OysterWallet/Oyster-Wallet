import type { KeyValueStore, Platform } from "../src/platform.js";

/** In-memory Platform with a controllable clock, for tests. */
export function memoryPlatform(start = 1_000_000) {
  const store = (): KeyValueStore & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return {
      data,
      get: async (k) => data.get(k) ?? null,
      set: async (k, v) => void data.set(k, v),
      delete: async (k) => void data.delete(k),
    };
  };
  let now = start;
  let counter = 0;
  const storage = store();
  const session = store();
  const platform: Platform = {
    storage,
    session,
    // Deterministic but distinct bytes; tests only, never for keys that matter.
    random: { bytes: (n) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + ++counter) & 0xff) },
    clock: { now: () => now },
    fetch: async () => {
      throw new Error("no network in unit tests");
    },
  };
  return { platform, storage, session, advance: (ms: number) => void (now += ms) };
}
