import { decodeAddress, PEARL_MAINNET, PEARL_TESTNET2 } from "@pearl-wallet/core";
import { browser } from "wxt/browser";
import type { ApprovalRequest, ConnectedSite, NetworkId } from "../messages";
import type { WalletService } from "./service";
import { ServiceError, toServiceError } from "./service";
import { isOysterMessage } from "./account";

/**
 * window.pearl, background side.
 *
 * API shape mirrors UniSat (decided 2026-09-19) so Bitcoin/Ordinals dApp code
 * ports to Pearl with renamed calls. v1 powers: connect, read address and
 * balance, request a PRL payment, sign a message (BIP-322), broadcast a raw
 * transaction. signPsbt is refused until it has its own review screen.
 *
 * The requesting origin always comes from Chrome (sender.origin / sender.url
 * of a top-frame content script), never from anything the page says.
 */

export /** How long an unanswered approval waits before it gives up. */
const APPROVAL_TIMEOUT_MS = 5 * 60_000;

const PROVIDER_ERRORS = {
  userRejected: { code: 4001, message: "The user rejected the request." },
  unauthorized: { code: 4100, message: "This site is not connected to Oyster. Call requestAccounts first." },
  unsupported: { code: 4200, message: "Oyster does not support this method yet." },
  pending: { code: -32002, message: "A request from this site is already waiting for the user." },
  timedOut: { code: 4001, message: "The request timed out waiting for approval." },
  locked: { code: 4100, message: "Oyster is locked." },
} as const;

type ProviderError = { code: number; message: string };
type Result = { ok: true; value: unknown } | { ok: false; error: ProviderError };

/** Omit that keeps each union member's own fields. */
type NewRequest = ApprovalRequest extends infer R ? (R extends ApprovalRequest ? Omit<R, "id"> : never) : never;

interface Pending {
  req: ApprovalRequest;
  windowId?: number;
  timer?: ReturnType<typeof setTimeout>;
  resolve: (r: Result) => void;
}

const SITES_KEY = "connected-sites";
const NETS = { mainnet: PEARL_MAINNET, testnet2: PEARL_TESTNET2 } as const;

export class ProviderHub {
  private readonly pending = new Map<string, Pending>();
  /** Tabs whose bridge has said hello, with the origin Chrome reported. */
  private readonly tabs = new Map<number, string>();

  constructor(private readonly service: WalletService) {
    browser.windows.onRemoved.addListener((windowId) => {
      for (const [id, p] of this.pending) {
        if (p.windowId === windowId) this.finish(id, { ok: false, error: PROVIDER_ERRORS.userRejected });
      }
    });
    browser.tabs.onRemoved.addListener((tabId) => this.tabs.delete(tabId));
  }

  // ---- requests from web pages ---------------------------------------------

  async handle(method: string, params: unknown[], origin: string, tabId: number): Promise<Result> {
    this.tabs.set(tabId, origin);
    try {
      switch (method) {
        case "hello":
          return ok(null);
        case "getNetwork":
          return ok((await this.service.state()).network);
        case "getAccounts":
          return ok((await this.connected(origin)) && (await this.service.isUnlocked()) ? [(await this.service.siteAccount()).address] : []);
        case "requestAccounts":
          return await this.requestAccounts(origin);
        case "getPublicKey":
          await this.requireConnected(origin);
          return ok((await this.service.siteAccount()).publicKey);
        case "getBalance": {
          await this.requireConnected(origin);
          const b = await this.service.siteBalance();
          return ok({ confirmed: num(b.confirmed), unconfirmed: num(b.unconfirmed), total: num(b.confirmed + b.unconfirmed) });
        }
        case "sendPRL":
          return await this.sendPRL(origin, params);
        case "signMessage":
          return await this.signMessage(origin, params);
        case "pushTx": {
          await this.requireConnected(origin);
          const raw = String(params[0] ?? "").trim();
          if (!/^[0-9a-fA-F]+$/.test(raw) || raw.length % 2 !== 0) {
            return err({ code: -32602, message: "pushTx expects raw transaction hex." });
          }
          // Broadcasting lends the site this wallet's node and IP, so the
          // bytes are decoded and shown first. Anything undecodable is
          // refused rather than forwarded blind.
          let tx;
          try {
            tx = await this.service.describeRaw(raw);
          } catch {
            return err({ code: -32602, message: "That does not decode as a Pearl transaction." });
          }
          return this.approve({ kind: "pushTx", origin, rawHex: raw, tx });
        }
        case "signPsbt":
        case "signPsbts":
          return err(PROVIDER_ERRORS.unsupported);
        default:
          return err({ code: 4200, message: `Unknown method ${method}.` });
      }
    } catch (e) {
      if (e && typeof e === "object" && "code" in e && typeof (e as ProviderError).code === "number") return err(e as ProviderError);
      return err({ code: -32603, message: toServiceError(e).message });
    }
  }

  private async requestAccounts(origin: string): Promise<Result> {
    if ((await this.connected(origin)) && (await this.service.isUnlocked())) {
      return ok([(await this.service.siteAccount()).address]);
    }
    const r = await this.approve({ kind: "connect", origin });
    if (!r.ok) return r;
    const account = await this.service.siteAccount();
    const sites = await this.sites();
    sites[origin] = { origin, connectedAt: Date.now() };
    await browser.storage.local.set({ [SITES_KEY]: sites });
    return ok([account.address]);
  }

  private async sendPRL(origin: string, params: unknown[]): Promise<Result> {
    await this.requireConnected(origin);
    const [to, amount, opts] = params as [unknown, unknown, { feeRate?: unknown } | undefined];
    const network = (await this.service.state()).network;
    if (typeof to !== "string") return err({ code: -32602, message: "sendPRL expects a recipient address." });
    try {
      decodeAddress(to, NETS[network]);
    } catch (e) {
      return err({ code: -32602, message: `Invalid recipient: ${(e as Error).message}` });
    }
    const grains = parseGrainsParam(amount);
    if (grains === null || grains <= 0n) return err({ code: -32602, message: "sendPRL expects a positive amount in grains." });
    const feeRate = typeof opts?.feeRate === "number" ? opts.feeRate : undefined;
    const r = await this.approve({
      kind: "send",
      origin,
      to,
      amount: grains.toString(),
      ...(feeRate !== undefined ? { feeRate } : {}),
    });
    return r;
  }

  private async signMessage(origin: string, params: unknown[]): Promise<Result> {
    await this.requireConnected(origin);
    const [message, type] = params as [unknown, unknown];
    if (typeof message !== "string") return err({ code: -32602, message: "signMessage expects a string." });
    if (message.length > 4096) return err({ code: -32602, message: "Message too long (4096 characters at most)." });
    // Oyster's own messages never reach the approval screen from a site.
    if (isOysterMessage(message)) {
      return err({ code: 4100, message: "Oyster does not sign its own messages for websites." });
    }
    // Extension messaging turns undefined array entries into null.
    if (type !== undefined && type !== null && type !== "bip322-simple") {
      return err({ code: 4200, message: "Oyster signs messages with bip322-simple only." });
    }
    return this.approve({ kind: "signMessage", origin, message });
  }

  // ---- approvals ------------------------------------------------------------

  /** Opens the approval window and waits for the user. One per site. */
  private async approve(req: NewRequest): Promise<Result> {
    for (const p of this.pending.values()) {
      if (p.req.origin === req.origin) return err(PROVIDER_ERRORS.pending);
    }
    const id = randomId();
    const full = { ...req, id } as ApprovalRequest;
    // A request that is never answered would otherwise leave the site's
    // promise hanging for as long as the page is open. Five minutes is well
    // past any real decision, and the window is closed with it.
    const done = new Promise<Result>((resolve) => {
      const timer = setTimeout(() => this.finish(id, { ok: false, error: PROVIDER_ERRORS.timedOut }), APPROVAL_TIMEOUT_MS);
      this.pending.set(id, { req: full, resolve, timer });
    });
    const win = await browser.windows.create({
      url: browser.runtime.getURL(`/approve.html?id=${id}`),
      type: "popup",
      width: 360,
      height: 640,
      focused: true,
    });
    const p = this.pending.get(id);
    if (p && win?.id !== undefined) p.windowId = win.id;
    return done;
  }

  /** For the approval page. */
  getApproval(id: string): ApprovalRequest {
    const p = this.pending.get(id);
    if (!p) throw new ServiceError("no-request", "This request has expired or was already answered.");
    return p.req;
  }

  /** The approval page's answer. Approving a send or signature does the work
   *  here, so the page never holds a key or a signed transaction. */
  async resolveApproval(id: string, approved: boolean): Promise<{ result?: unknown }> {
    const p = this.pending.get(id);
    if (!p) throw new ServiceError("no-request", "This request has expired or was already answered.");
    if (!approved) {
      this.finish(id, { ok: false, error: PROVIDER_ERRORS.userRejected });
      return {};
    }
    let value: unknown = null;
    const r = p.req;
    if (r.kind === "send") {
      const rate = r.feeRate ?? (await this.service.feeOptions()).rates.normal;
      value = await this.service.siteSend(r.to, BigInt(r.amount), rate); // throws to the page on failure
    } else if (r.kind === "signMessage") {
      value = (await this.service.siteSignMessage(r.message)).signature;
    } else if (r.kind === "pushTx") {
      value = await this.service.sitePushTx(r.rawHex);
    }
    this.finish(id, { ok: true, value });
    if (p.windowId !== undefined) void browser.windows.remove(p.windowId).catch(() => {});
    return { result: value };
  }

  private finish(id: string, r: Result) {
    const p = this.pending.get(id);
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(r);
  }

  // ---- connected sites --------------------------------------------------------

  async sites(): Promise<Record<string, ConnectedSite>> {
    const got = await browser.storage.local.get(SITES_KEY);
    return (got[SITES_KEY] as Record<string, ConnectedSite> | undefined) ?? {};
  }

  async listSites(): Promise<ConnectedSite[]> {
    return Object.values(await this.sites()).sort((a, b) => b.connectedAt - a.connectedAt);
  }

  async disconnect(origin: string): Promise<ConnectedSite[]> {
    const sites = await this.sites();
    delete sites[origin];
    await browser.storage.local.set({ [SITES_KEY]: sites });
    this.emitTo(origin, "accountsChanged", []);
    return this.listSites();
  }

  private async connected(origin: string): Promise<boolean> {
    return origin in (await this.sites());
  }

  private async requireConnected(origin: string): Promise<void> {
    if (!(await this.connected(origin))) throw PROVIDER_ERRORS.unauthorized;
    if (!(await this.service.isUnlocked())) throw PROVIDER_ERRORS.locked;
  }

  // ---- events -------------------------------------------------------------------

  /** After a wallet switch, lock, unlock or network change. */
  async broadcastState(): Promise<void> {
    const sites = await this.sites();
    const unlocked = await this.service.isUnlocked();
    let accounts: string[] = [];
    let network: NetworkId | undefined;
    try {
      network = (await this.service.state()).network;
      if (unlocked) accounts = [(await this.service.siteAccount()).address];
    } catch {
      accounts = [];
    }
    for (const [tabId, origin] of this.tabs) {
      if (!(origin in sites)) continue;
      this.send(tabId, "accountsChanged", accounts);
      if (network) this.send(tabId, "networkChanged", network);
    }
  }

  private emitTo(origin: string, event: string, data: unknown) {
    for (const [tabId, o] of this.tabs) if (o === origin) this.send(tabId, event, data);
  }

  private send(tabId: number, event: string, data: unknown) {
    void browser.tabs.sendMessage(tabId, { type: "oyster-event", event, data }).catch(() => this.tabs.delete(tabId));
  }
}

function ok(value: unknown): Result {
  return { ok: true, value };
}

function err(error: ProviderError): Result {
  return { ok: false, error };
}

/** UniSat returns satoshi amounts as numbers; so does Oyster while they fit. */
function num(g: bigint): number | string {
  return g <= BigInt(Number.MAX_SAFE_INTEGER) && g >= -BigInt(Number.MAX_SAFE_INTEGER) ? Number(g) : g.toString();
}

function parseGrainsParam(v: unknown): bigint | null {
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === "bigint") return v;
  return null;
}

function randomId(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
