import { browser } from "wxt/browser";
import { ProviderHub } from "../src/background/provider";
import { toServiceError, WalletService } from "../src/background/service";
import type { Request, Reply } from "../src/messages";
import { chromePlatform } from "../src/platform-chrome";

/**
 * Owns the vault, the unlock state and every network call. Nothing that
 * touches key material lives in the popup: it is destroyed on every close.
 */
export default defineBackground(() => {
  const service = new WalletService(chromePlatform);
  const hub = new ProviderHub(service);

  // Auto-lock does not depend on this alarm (the vault checks idle time on
  // every read), but the alarm makes the lock happen on time even when
  // nobody opens the popup, and drops the in-memory keys with it.
  // Chrome forgets whether the action opens a popup or the side panel when
  // it restarts the worker, so the stored choice is applied on every start.
  void service.applyUiMode().catch(() => {});

  browser.alarms.create("autolock", { periodInMinutes: 1 });
  // Looks for payments that arrived while the popup was closed. Two minutes
  // is well inside a 3-minute block, and it only does anything while the
  // wallet is unlocked.
  browser.alarms.create("watch", { periodInMinutes: 2 });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "autolock") {
      // A popup left open would otherwise keep showing balances until its
      // next call failed. Tell it the moment the lock happens.
      void service
        .enforceAutoLock()
        .then((justLocked) => {
          if (justLocked) void browser.runtime.sendMessage({ type: "event", name: "locked" }).catch(() => {});
        })
        .catch(() => {});
    }
    if (alarm.name === "watch") void service.onWatchTimer().catch(() => {});
  });

  browser.runtime.onMessage.addListener((message: unknown, sender) => {
    if (sender.id !== browser.runtime.id) {
      return Promise.resolve({ ok: false, error: { code: "forbidden", message: "not allowed" } });
    }
    const ownPage = sender.url?.startsWith(browser.runtime.getURL("/")) ?? false;

    // Web pages, through our bridge content script, top frame only. The
    // origin is Chrome's, never the page's claim.
    const m = message as { type?: string; method?: unknown; params?: unknown };
    if (!ownPage && m.type === "oyster-provider" && sender.tab?.id !== undefined && sender.frameId === 0) {
      const origin = sender.origin ?? (sender.url ? new URL(sender.url).origin : "");
      if (!/^https?:\/\//.test(origin) || typeof m.method !== "string") {
        return Promise.resolve({ ok: false, error: { code: 4100, message: "Unsupported origin." } });
      }
      busy(1);
      return hub
        .handle(m.method, Array.isArray(m.params) ? m.params : [], origin, sender.tab.id)
        .finally(() => busy(-1));
    }

    // Everything else: only our own extension pages (popup, approval window).
    if (!ownPage) {
      return Promise.resolve({ ok: false, error: { code: "forbidden", message: "not allowed" } });
    }
    return handle(service, hub, message as Request);
  });
});

/**
 * MV3 stops an idle worker after ~30 s, and waiting on fetches or timers does
 * not count as activity: a 250-address import scan was killed mid-way in
 * testing, leaving the popup waiting forever. Extension API calls do reset
 * the idle timer (Chrome 110+), so ping one while any request is in flight.
 */
let inFlight = 0;
let keepAlive: ReturnType<typeof setInterval> | undefined;
function busy(delta: 1 | -1) {
  inFlight += delta;
  if (inFlight > 0 && !keepAlive) {
    keepAlive = setInterval(() => void browser.runtime.getPlatformInfo(), 20_000);
  } else if (inFlight === 0 && keepAlive) {
    clearInterval(keepAlive);
    keepAlive = undefined;
  }
}

/** Requests that change what a connected site sees. */
const SITE_VISIBLE = new Set(["unlock", "lock", "switchWallet", "addWallet", "removeWallet", "setNetwork", "createVault"]);

async function handle(s: WalletService, hub: ProviderHub, m: Request): Promise<Reply<Request["type"]>> {
  busy(1);
  try {
    const value = await dispatch(s, hub, m);
    if (SITE_VISIBLE.has(m.type)) void hub.broadcastState();
    return { ok: true, value } as Reply<Request["type"]>;
  } catch (e) {
    return { ok: false, error: toServiceError(e) };
  } finally {
    busy(-1);
  }
}

function dispatch(s: WalletService, hub: ProviderHub, m: Request) {
  switch (m.type) {
    case "state": return s.state();
    case "generateMnemonic": return s.generateMnemonic();
    case "validateMnemonic": return s.validateMnemonic(m.mnemonic);
    case "createVault": return s.createVault(m.password, m.mnemonic, m.imported, m.replace);
    case "unlock": return s.unlock(m.password);
    case "lock": return s.lock();
    case "lockState": return s.lockState();
    case "setNetwork": return s.setNetwork(m.network);
    case "walletView": return m.background ? s.walletViewQuietly() : s.walletView(m.refresh);
    case "coins": return s.coins();
    case "exportXpub": return s.exportXpub(m.walletId);
    case "txNotes": return s.txNotes();
    case "txNote": return s.txNote(m.txid, m.note);
    case "historyCsv": return s.historyCsv();
    case "addressBook": return s.addressBook();
    case "saveContact": return s.saveContact(m.address, m.label);
    case "forgetContact": return s.forgetContact(m.address);
    case "validateAddress": return s.validateAddress(m.address);
    case "setWrappedAddress": return s.setWrappedAddress(m.address);
    case "setWrappedInTotal": return s.setWrappedInTotal(m.include);
    case "setUiMode": return s.setUiMode(m.mode);
    case "wrappedBalance": return s.wrappedBalance();
    case "cash": return s.cash();
    case "depth": return s.depth();
    case "marketTrades": return s.marketTrades();
    case "openOrders": return s.openOrders();
    case "orderHistory": return s.orderHistory();
    case "accountTrades": return s.accountTrades();
    case "cancelOrder": return s.cancelOrder(m.id);
    case "myAccount": return s.myAccount();
    case "myOrders": return s.myOrders();
    case "placeOrder": return s.placeOrder(m.side, m.amount, m.price, m.keep === true);
    case "releasePrl": return s.releasePrl();
    case "cancelMyOrder": return s.cancelMyOrder(m.id);
    case "placeSell": return s.placeSell(m.amount);
    case "withdrawInfo": return s.withdrawInfo();
    case "accountHistory": return s.accountHistory();
    case "withdraw": return s.withdraw(m.chain, m.amount);
    case "orderQuote": return s.orderQuote(m.side, { ...(m.amount !== undefined ? { amount: m.amount } : {}), ...(m.spend !== undefined ? { spend: m.spend } : {}) });
    case "feeOptions": return s.feeOptions();
    case "quoteSend": return s.quoteSend(m.args);
    case "maxSpend": return s.maxSpend(m.tier, m.rate);
    case "send": return s.send(m.args);
    case "txStatus": return s.txStatus(m.txid);
    case "quoteSpeedUp": return s.quoteSpeedUp(m.txid);
    case "speedUp": return s.speedUp(m.txid);
    case "quoteCancel": return s.quoteCancel(m.txid);
    case "cancelSend": return s.cancelSend(m.txid);
    case "loadMoreHistory": return s.loadMoreHistory();
    case "protectedCoins": return s.protectedCoins();
    case "setFrozen": return s.setFrozen(m.outpoint, m.frozen);
    case "exportSeed": return s.exportSeed(m.password, m.walletId);
    case "exportBackup": return s.exportBackup(m.password);
    case "importBackup": return s.importBackup(m.file, m.password);
    case "switchWallet": return s.switchWallet(m.id);
    case "addWallet": return s.addWallet(m.args);
    case "updateWallet": return s.updateWallet(m.id, { ...(m.name !== undefined ? { name: m.name } : {}), ...(m.color ? { color: m.color } : {}) });
    case "removeWallet": return s.removeWallet(m.id, m.acknowledgeSeedDeletion);
    case "walletDetails": return s.walletDetails(m.id);
    case "miningView": return s.miningView(m.tzOffsetMinutes, m.refresh);
    case "setMinerMode": return s.setMinerMode(m.enabled);
    case "priceAlerts": return s.priceAlerts();
    case "addPriceAlert": return s.addPriceAlert(m.direction, m.price);
    case "removePriceAlert": return s.removePriceAlert(m.id);
    case "autoSell": return s.autoSell();
    case "setAutoSell": return s.setAutoSell(m.enabled, m.threshold, m.percent);
    case "approvalGet": return hub.getApproval(m.id);
    case "approvalQuote": {
      const r = hub.getApproval(m.id);
      if (r.kind !== "send") throw new Error("not a payment request");
      return s.quoteSiteSend(r.to, BigInt(r.amount), r.feeRate);
    }
    case "approvalResolve": return hub.resolveApproval(m.id, m.approved);
    case "siteAccount": return s.siteAccount();
    case "listSites": return hub.listSites();
    case "price": return s.price();
    case "chart": return s.chart(m.range);
    case "setRelayUrl": return s.setRelayUrl(m.url);
    case "setOperatorKey": return s.setOperatorKey(m.secret);
    case "setCashAddress": return s.setCashAddress(m.chain, m.address);
    case "depositAddress": return s.depositAddress(m.chain);
    case "disconnectSite": return hub.disconnect(m.origin);
    case "setAutoLock": return s.setAutoLock(m.minutes);
    case "setTheme": return s.setTheme(m.theme);
    case "changePassword": return s.changePassword(m.oldPassword, m.newPassword);
  }
}
