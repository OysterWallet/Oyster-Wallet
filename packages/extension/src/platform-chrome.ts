import { browser, type Browser } from "wxt/browser";
import type { Platform, KeyValueStore } from "@pearl-wallet/core";

/**
 * The extension's implementation of the core platform seam.
 * The React Native shell will provide the same shape over MMKV and
 * expo-secure-store, and @pearl-wallet/core will not know the difference.
 */

function area(store: Browser.storage.StorageArea): KeyValueStore {
  return {
    async get(key) {
      const r = await store.get(key);
      return (r[key] as string | undefined) ?? null;
    },
    async set(key, value) {
      await store.set({ [key]: value });
    },
    async delete(key) {
      await store.remove(key);
    },
    async entries() {
      const all = (await store.get(null)) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(all).filter(([, v]) => typeof v === "string")) as Record<string, string>;
    },
  };
}

/**
 * Clicking the toolbar icon opens either the popup or the side panel, and
 * Chrome decides between them by whether the action has a popup set. Chrome
 * forgets both across restarts, so the service worker applies the stored
 * choice on every start.
 */
const sidePanelApi = (browser as unknown as { sidePanel?: {
  setPanelBehavior(o: { openPanelOnActionClick: boolean }): Promise<void>;
  setOptions(o: { path?: string; enabled?: boolean }): Promise<void>;
} }).sidePanel;

/** Notifications and the toolbar badge. Both are best-effort: a browser with
 *  notifications switched off is not a failure the wallet should report. */
const alerts = {
  async notify(title: string, message: string) {
    try {
      await browser.notifications.create({ type: "basic", iconUrl: browser.runtime.getURL("/icon/128.png"), title, message });
    } catch { /* denied, or unsupported */ }
  },
  async badge(text: string) {
    try {
      await browser.action.setBadgeText({ text });
      await browser.action.setBadgeBackgroundColor({ color: "#1f6f6a" });
    } catch { /* not available */ }
  },
};

export const chromePlatform: Platform = {
  storage: area(browser.storage.local),
  // In memory only, never written to disk, and not readable by content
  // scripts by default. It is NOT cleared when the MV3 service worker is torn
  // down: it survives worker restarts and is cleared only when the browser
  // restarts or the extension reloads. Auto-lock must be an explicit timer
  // that deletes the key, never an assumption that the worker dying wipes it.
  session: area(browser.storage.session),
  random: { bytes: (n) => crypto.getRandomValues(new Uint8Array(n)) },
  clock: { now: () => Date.now() },
  fetch: globalThis.fetch.bind(globalThis),
  alerts,
  ...(sidePanelApi
    ? {
        sidePanel: {
          async apply(enabled: boolean) {
            await browser.action.setPopup({ popup: enabled ? "" : "popup.html" });
            await sidePanelApi.setPanelBehavior({ openPanelOnActionClick: enabled });
            await sidePanelApi.setOptions({ path: "sidepanel.html", enabled: true });
          },
        },
      }
    : {}),
};
