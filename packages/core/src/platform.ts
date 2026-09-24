/**
 * The platform seam.
 *
 * Everything in @pearl-wallet/core is written against these interfaces and
 * nothing else. No `chrome.*`, no DOM, no WebCrypto, no Node builtins.
 *
 * That constraint is the whole reason this package exists: the same code has
 * to run inside an MV3 service worker today and inside React Native later.
 * React Native has no SubtleCrypto, which is why crypto comes from @noble
 * (pure JS) rather than `globalThis.crypto.subtle`.
 *
 * Implementations live in the shells:
 *   extension -> chrome.storage.local / chrome.storage.session
 *   mobile    -> MMKV / expo-secure-store
 */

/** Durable key/value storage. Survives restarts. Holds the encrypted vault. */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Everything stored, for backups. Optional: a platform that cannot list
   *  its keys simply backs up less. */
  entries?(): Promise<Record<string, string>>;
}

/**
 * Ephemeral storage for unlock state. Never written to disk.
 * In MV3 this is chrome.storage.session, which survives service worker
 * restarts and is cleared only on browser restart or extension reload; on
 * mobile it is in-memory only. Either way, locking is an explicit delete on
 * an auto-lock timer, never something core assumes the platform does for it.
 */
export type SessionStore = KeyValueStore;

/** CSPRNG. `crypto.getRandomValues` in the extension, expo-crypto on mobile. */
export interface RandomSource {
  bytes(length: number): Uint8Array;
}

/** Injected so tests can freeze time and so nonce generation is testable. */
export interface Clock {
  now(): number;
}

export interface Platform {
  storage: KeyValueStore;
  session: SessionStore;
  random: RandomSource;
  clock: Clock;
  /** Platform fetch. Present on both targets, injected so tests can stub it. */
  fetch: FetchLike;
  /** Browsers that can show the wallet in a side panel. Absent elsewhere,
   *  which is how the setting knows to hide itself. */
  sidePanel?: SidePanel;
  /** Telling the owner something happened while they were not looking. */
  alerts?: Alerts;
}

export interface Alerts {
  /** A system notification. Failure is not an error worth surfacing. */
  notify(title: string, message: string): Promise<void>;
  /** The count on the toolbar icon; empty string clears it. */
  badge(text: string): Promise<void>;
}

/** Opening in a side panel instead of a popup. */
export interface SidePanel {
  apply(enabled: boolean): Promise<void>;
}

/** The slice of WHATWG fetch core relies on. Declared here because core
 *  compiles without DOM or Node lib types; the real fetch on both targets
 *  satisfies it structurally. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;
