import type { FetchLike } from "@pearl-wallet/core";
import type { Candle, CashView, ChartRange, ChartView, DepthView, MarketTrade, DepositAddress, OrderQuote, OrdersView, PriceView, TradesView, WrappedView } from "../messages";

/**
 * PRL price and chart, from Oyster's relay.
 *
 * The wallet never calls an exchange or a price site directly: SafeTrade
 * geoblocks several countries (so browsers there would see no prices), and
 * one server asking once is kinder to a public API than every browser asking
 * for itself. The relay says which source a number came from and how old it
 * is, and that travels through to the screen.
 *
 * A missing price is never an error the user has to deal with: the wallet
 * simply shows PRL amounts without their USDT equivalent.
 */

/**
 * Oyster's relay.
 *
 * The name encodes the address (sslip.io resolves it straight back), which
 * is fine while the server is young and has no domain of its own. Before
 * release this becomes a name we own, because encoding the IP means moving
 * the server would break every installed wallet.
 */
export const DEFAULT_RELAY = "https://167-99-2-180.sslip.io";

const PRICE_TTL_MS = 60_000;
const WRAPPED_TTL_MS = 60_000;
// Ten minutes, not an hour: the list barely changes, but when it does the
// owner should not be looking at yesterday's chains because a worker that
// happened to stay alive is still holding them.
const CASH_TTL_MS = 10 * 60_000;
// A book is only worth what it was a moment ago. Short enough to be honest,
// long enough that ten open wallets do not become ten requests a second.
const DEPTH_TTL_MS = 4_000;
const TRADES_TTL_MS = 8_000;
const CHART_TTL_MS = 5 * 60_000;

interface Cached<T> {
  value: T;
  at: number;
}

/**
 * Signs a request to the relay the way the relay verifies it.
 *
 * Method, path and body all go into the signature, not just the nonce, so a
 * signature is only ever good for the request it was made for: one lifted
 * from a listing cannot be replayed as a cancel, and the id on a cancel
 * cannot be swapped afterwards. The secret never leaves this machine.
 *
 * Lives here rather than in core because core has no WebCrypto by design.
 */
async function signRequest(
  secret: string,
  nonce: string,
  method: string,
  path: string,
  body: string,
): Promise<string> {
  const enc = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", enc.encode(body));
  const digest = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${nonce}
${method.toUpperCase()}
${path}
${digest}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class Prices {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private base: string;
  private price?: Cached<PriceView>;
  private charts = new Map<ChartRange, Cached<ChartView>>();
  private wrapped = new Map<string, Cached<WrappedView>>();
  private cashed?: Cached<CashView>;
  private depthed?: Cached<DepthView>;
  private taped?: Cached<MarketTrade[]>;
  private inflight?: Promise<PriceView | undefined>;
  /** Set only when the operator key is configured. Without it the endpoints
   *  that reach the exchange account are refused, which is the correct
   *  outcome for a wallet that is not the operator's. */
  private operatorSecret = "";

  constructor(fetchImpl: FetchLike, now: () => number, base = DEFAULT_RELAY) {
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.base = base;
  }

  setOperatorSecret(secret: string) {
    this.operatorSecret = secret;
  }

  /** Headers for a route the relay guards. The path must carry its query
   *  string, because the relay signs that too. */
  private async signedHeaders(method: string, path: string, body = ""): Promise<Record<string, string>> {
    if (!this.operatorSecret) return {};
    const nonce = String(this.now());
    return {
      "x-oyster-nonce": nonce,
      "x-oyster-signature": await signRequest(this.operatorSecret, nonce, method, path, body),
    };
  }

  setBase(base: string) {
    if (base !== this.base) {
      this.base = base;
      this.price = undefined;
      this.charts.clear();
      this.wrapped.clear();
      this.cashed = undefined;
      this.depthed = undefined;
      this.taped = undefined;
    }
  }

  /** Undefined when the relay cannot be reached: the UI then hides fiat. */
  async get(): Promise<PriceView | undefined> {
    if (this.price && this.now() - this.price.at < PRICE_TTL_MS) return this.price.value;
    this.inflight ??= this.load().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  async chart(range: ChartRange): Promise<ChartView | undefined> {
    const hit = this.charts.get(range);
    if (hit && this.now() - hit.at < CHART_TTL_MS) return hit.value;
    try {
      const body = await this.json<{ range: ChartRange; source: string; points: { t: number; v: number }[]; candles?: Candle[]; changePct: number; asOf: string; stale: boolean }>(
        `/v1/chart?range=${encodeURIComponent(range)}`,
      );
      const value: ChartView = {
        range: body.range,
        source: body.source,
        points: body.points,
        ...(Array.isArray(body.candles) && body.candles.length > 1 ? { candles: body.candles } : {}),
        changePct: body.changePct,
        asOf: body.asOf,
        stale: body.stale,
      };
      this.charts.set(range, { value, at: this.now() });
      return value;
    } catch {
      return hit?.value;
    }
  }

  /** Wrapped PRL at one Ethereum address. Undefined when the relay or every
   *  Ethereum endpoint is unreachable: the screen then says so rather than
   *  showing a zero it has not read. */
  async wrappedBalance(address: string): Promise<WrappedView | undefined> {
    const hit = this.wrapped.get(address);
    if (hit && this.now() - hit.at < WRAPPED_TTL_MS) return hit.value;
    try {
      const value = await this.json<WrappedView>(`/v1/wprl?address=${encodeURIComponent(address)}`);
      if (typeof value.balance !== "string" || typeof value.decimals !== "number") return hit?.value;
      this.wrapped.set(address, { value, at: this.now() });
      return value;
    } catch {
      return hit?.value;
    }
  }

  /** What the exchange takes as a deposit. Changes about never, so an hour
   *  of cache is generous. */
  async cash(): Promise<CashView | undefined> {
    if (this.cashed && this.now() - this.cashed.at < CASH_TTL_MS) return this.cashed.value;
    try {
      // The bucket changes with the cache window, which steps past anything
      // the browser's HTTP cache is still holding from a longer-lived answer.
      const bucket = Math.floor(this.now() / CASH_TTL_MS);
      const value = await this.json<CashView>(`/v1/cash/methods?t=${bucket}`);
      if (!Array.isArray(value.methods)) return this.cashed?.value;
      this.cashed = { value, at: this.now() };
      return value;
    } catch {
      return this.cashed?.value;
    }
  }

  /** The order book. Undefined when the relay or the exchange is unreachable:
   *  a trading screen says so rather than drawing an empty book. */
  async depth(): Promise<DepthView | undefined> {
    if (this.depthed && this.now() - this.depthed.at < DEPTH_TTL_MS) return this.depthed.value;
    try {
      const value = await this.json<DepthView>("/v1/market/depth");
      if (!Array.isArray(value.asks) || !Array.isArray(value.bids)) return this.depthed?.value;
      this.depthed = { value, at: this.now() };
      return value;
    } catch {
      return this.depthed?.value;
    }
  }

  async marketTrades(): Promise<MarketTrade[] | undefined> {
    if (this.taped && this.now() - this.taped.at < TRADES_TTL_MS) return this.taped.value;
    try {
      const body = await this.json<{ trades: MarketTrade[] }>("/v1/market/trades");
      if (!Array.isArray(body.trades)) return this.taped?.value;
      this.taped = { value: body.trades, at: this.now() };
      return body.trades;
    } catch {
      return this.taped?.value;
    }
  }

  /** Never cached: a quote is for a particular size, at this moment. */
  async orderQuote(side: "buy" | "sell", of: { amount?: number; spend?: number }): Promise<OrderQuote | undefined> {
    const q = of.spend !== undefined ? `spend=${encodeURIComponent(of.spend)}` : `amount=${encodeURIComponent(of.amount ?? 0)}`;
    try {
      return await this.json<OrderQuote>(`/v1/market/quote?side=${side}&${q}`);
    } catch {
      return undefined;
    }
  }

  /** Orders waiting on the exchange. Never cached: a filled order that still
   *  showed as open would be worse than a slow screen. */
  async openOrders(): Promise<OrdersView | undefined> {
    try {
      return await this.json<OrdersView>("/v1/orders", true);
    } catch {
      return undefined;
    }
  }

  async orderHistory(): Promise<OrdersView | undefined> {
    try {
      return await this.json<OrdersView>("/v1/orders/history", true);
    } catch {
      return undefined;
    }
  }

  /** Where to send USDT on one chain. Closed until the relay can credit it. */
  async depositAddress(network: string): Promise<DepositAddress> {
    try {
      return await this.json<DepositAddress>(`/v1/cash/address?network=${encodeURIComponent(network)}`);
    } catch (e) {
      return { open: false, why: (e as Error).message };
    }
  }

  /** This account's fills. The only place an execution price exists. */
  async accountTrades(): Promise<TradesView | undefined> {
    try {
      return await this.json<TradesView>("/v1/trades", true);
    } catch {
      return undefined;
    }
  }

  async cancelOrder(id: number): Promise<boolean> {
    const path = `/v1/orders/cancel?id=${encodeURIComponent(id)}`;
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method: "POST",
      headers: await this.signedHeaders("POST", path),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `relay HTTP ${res.status}`);
    }
    return true;
  }

  private async load(): Promise<PriceView | undefined> {
    try {
      const body = await this.json<{ usdPerPrl: number; change24hPct: number; volume24h?: number; source: string; asOf: string; stale: boolean }>("/v1/price");
      if (!Number.isFinite(body.usdPerPrl) || body.usdPerPrl <= 0) return this.price?.value;
      const value: PriceView = {
        usdPerPrl: body.usdPerPrl,
        change24hPct: body.change24hPct,
        ...(Number.isFinite(body.volume24h) ? { volume24h: body.volume24h as number } : {}),
        source: body.source,
        asOf: body.asOf,
        stale: body.stale,
      };
      this.price = { value, at: this.now() };
      return value;
    } catch {
      // Keep showing the last known price rather than blanking the screen.
      return this.price?.value;
    }
  }

  private async json<T>(path: string, guarded = false): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, guarded ? { headers: await this.signedHeaders("GET", path) } : undefined);
    if (!res.ok) throw new Error(`relay HTTP ${res.status}`);
    return (await res.json()) as T;
  }
}

/** USDT value of an amount in grains, or undefined without a price. */
export function fiatOf(grains: bigint, price?: PriceView): number | undefined {
  if (!price) return undefined;
  return (Number(grains) / 1e8) * price.usdPerPrl;
}
