/**
 * window.pearl, the page side. Runs in the page's own JavaScript world, so it
 * holds nothing: every call is posted to the bridge content script, which
 * forwards it to Oyster's background. API mirrors UniSat's.
 */
export default defineContentScript({
  matches: ["http://*/*", "https://*/*"],
  world: "MAIN",
  runAt: "document_start",
  main() {
    if ((window as { pearl?: unknown }).pearl) return; // another Pearl wallet got here first

    const TO_BRIDGE = "oyster:to-bridge";
    const TO_PAGE = "oyster:to-page";
    let seq = 0;
    const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
    const listeners = new Map<string, Set<(data: unknown) => void>>();

    window.addEventListener("message", (e: MessageEvent) => {
      if (e.source !== window || !e.data || e.data.target !== TO_PAGE) return;
      const d = e.data as { id?: number; ok?: boolean; value?: unknown; error?: { code: number; message: string }; event?: string; data?: unknown };
      if (d.event) {
        for (const fn of listeners.get(d.event) ?? []) {
          try { fn(d.data); } catch { /* a listener's problem is not ours */ }
        }
        return;
      }
      const w = d.id !== undefined ? waiting.get(d.id) : undefined;
      if (!w) return;
      waiting.delete(d.id!);
      if (d.ok) w.resolve(d.value);
      else w.reject(Object.assign(new Error(d.error?.message ?? "Oyster error"), { code: d.error?.code ?? -32603 }));
    });

    const call = (method: string, ...params: unknown[]) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        waiting.set(id, { resolve, reject });
        window.postMessage({ target: TO_BRIDGE, id, method, params }, window.location.origin);
      });

    const provider = Object.freeze({
      isOyster: true,
      requestAccounts: () => call("requestAccounts"),
      getAccounts: () => call("getAccounts"),
      getNetwork: () => call("getNetwork"),
      getPublicKey: () => call("getPublicKey"),
      getBalance: () => call("getBalance"),
      /** amount in grains (1 PRL = 100,000,000). */
      sendPRL: (to: string, amount: number | string, options?: { feeRate?: number }) => call("sendPRL", to, amount, options),
      signMessage: (message: string, type?: "bip322-simple") => call("signMessage", message, type),
      signPsbt: (psbtHex: string, options?: unknown) => call("signPsbt", psbtHex, options),
      pushTx: (rawTxHex: string) => call("pushTx", rawTxHex),
      on: (event: string, fn: (data: unknown) => void) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(fn);
      },
      removeListener: (event: string, fn: (data: unknown) => void) => {
        listeners.get(event)?.delete(fn);
      },
    });

    Object.defineProperty(window, "pearl", { value: provider, writable: false, configurable: false });
    window.dispatchEvent(new Event("pearl#initialized"));
  },
});
