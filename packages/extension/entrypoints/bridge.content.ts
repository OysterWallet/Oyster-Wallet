import { browser } from "wxt/browser";

/**
 * Relays window.pearl calls between the page and Oyster's background. Runs in
 * the extension's isolated world, top frame only. It forwards method names
 * and parameters and nothing else; the background decides everything,
 * including which site is asking (from Chrome, not from this script).
 */
const METHODS = new Set(["hello",
  "requestAccounts", "getAccounts", "getNetwork", "getPublicKey", "getBalance",
  "sendPRL", "signMessage", "signPsbt", "signPsbts", "pushTx",
]);

export default defineContentScript({
  matches: ["http://*/*", "https://*/*"],
  runAt: "document_start",
  allFrames: false,
  main() {
    const TO_BRIDGE = "oyster:to-bridge";
    const TO_PAGE = "oyster:to-page";
    const origin = window.location.origin;

    window.addEventListener("message", async (e: MessageEvent) => {
      if (e.source !== window || e.origin !== origin || !e.data || e.data.target !== TO_BRIDGE) return;
      const { id, method, params } = e.data as { id: number; method: string; params: unknown[] };
      if (typeof id !== "number" || !METHODS.has(method)) {
        window.postMessage({ target: TO_PAGE, id, ok: false, error: { code: 4200, message: `Unknown method ${String(method)}.` } }, origin);
        return;
      }
      let reply: { ok: boolean; value?: unknown; error?: unknown };
      try {
        reply = await browser.runtime.sendMessage({ type: "oyster-provider", method, params: Array.isArray(params) ? params : [] });
      } catch {
        reply = { ok: false, error: { code: -32603, message: "Oyster is not responding. Try again." } };
      }
      window.postMessage({ target: TO_PAGE, id, ...reply }, origin);
    });

    // Events from Oyster (account or network changed) go straight to the page.
    browser.runtime.onMessage.addListener((m: unknown) => {
      const msg = m as { type?: string; event?: string; data?: unknown };
      if (msg?.type === "oyster-event" && typeof msg.event === "string") {
        window.postMessage({ target: TO_PAGE, event: msg.event, data: msg.data }, origin);
      }
    });

    // Register this tab so it can receive events; also warms the worker.
    void browser.runtime.sendMessage({ type: "oyster-provider", method: "hello", params: [] }).catch(() => {});
  },
});
