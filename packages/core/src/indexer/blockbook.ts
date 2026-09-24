import { parseGrains, parsePrl } from "../amount.js";
import type { PearlNetwork } from "../network.js";
import type { FetchLike } from "../platform.js";
import { Pacer, sleep } from "./pace.js";

/**
 * Trezor Blockbook v2 client.
 *
 * Both Pearl instances were probed on 2026-09-18 and were in sync:
 *   mainnet  bestHeight 115,223
 *   testnet2 bestHeight  99,946
 *
 * Privacy note that constrains the API below: there is an /api/v2/xpub/
 * endpoint that would make account scanning one request. It is not exposed
 * here on purpose. Sending an xpub hands the operator the extended public key
 * for the whole account. Per-address lookups leak one address at a time.
 *
 * Response shapes were taken from live responses, not the docs. Amounts are
 * decimal strings in grains; fee estimates are PRL per kB; errors come back
 * as {"error": "..."}, sometimes with a 200.
 */

/** Consensus: coinbase outputs are unspendable for 100 blocks
 *  (node/chaincfg/params.go CoinbaseMaturity). */
export const COINBASE_MATURITY = 100;

/** Default pace against the public indexers; see pace.ts for the measurement. */
export const DEFAULT_REQUESTS_PER_SECOND = 20;
/** Backoff for a rate-limited request, about 30 s in all, then give up. The
 *  public indexers' limiter is shared with every other client, so it trips
 *  intermittently even at a modest pace; measured recovery is ~5 s. */
const RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15000];

/** Node relay policy: DefaultMinRelayTxFee = 1000 grains/kB
 *  (node/mempool/policy.go:50). Anything lower is not relayed. */
export const MIN_RELAY_SAT_PER_VB = 1;

export interface Utxo {
  txid: string;
  /** The address holding it; tells the signer which key to use. */
  address: string;
  vout: number;
  value: bigint;
  /** Undefined while unconfirmed. */
  height?: number;
  confirmations: number;
  /** True for mining rewards. Blockbook's /utxo does not say, so this is
   *  looked up per transaction for anything younger than maturity. */
  coinbase: boolean;
  /** Coinbase that the chain will not yet let us spend. */
  immature: boolean;
  /** Unconfirmed, but created by this wallet's own transaction (change), so
   *  nobody else can replace it. Set by the caller, not the indexer. */
  trusted?: boolean;
}

export interface AddressSummary {
  address: string;
  balance: bigint;
  /** Mempool delta. Negative while an outgoing payment is unconfirmed. */
  unconfirmed: bigint;
  txCount: number;
  unconfirmedTxCount: number;
}

export interface IndexerTxInput {
  addresses: string[];
  value: bigint;
  coinbase: boolean;
}

export interface IndexerTxOutput {
  n: number;
  addresses: string[];
  value: bigint;
  /** Already spent, possibly by a transaction still in the mempool. */
  spent: boolean;
}

export interface IndexerTx {
  txid: string;
  /** Raw transaction, when the indexer includes it (single-tx lookups do). */
  hex?: string;
  /** Undefined while unconfirmed. */
  height?: number;
  /** Unix seconds. */
  time: number;
  confirmations: number;
  fee: bigint;
  vin: IndexerTxInput[];
  vout: IndexerTxOutput[];
}

export interface TxPage {
  page: number;
  totalPages: number;
  txs: IndexerTx[];
}

export interface IndexerStatus {
  bestHeight: number;
  inSync: boolean;
}

export class BlockbookError extends Error {
  override name = "BlockbookError";
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown>;

export class BlockbookClient {
  private readonly pacer: Pacer;

  constructor(
    private readonly net: PearlNetwork,
    private readonly fetchImpl: FetchLike,
    opts: { requestsPerSecond?: number } = {},
  ) {
    const rps = opts.requestsPerSecond ?? DEFAULT_REQUESTS_PER_SECOND;
    this.pacer = new Pacer(rps, rps);
  }

  /** Paced, and retried with backoff when the indexer says we went too fast. */
  private async get(path: string): Promise<Json> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.getOnce(path);
      } catch (e) {
        const limited =
          e instanceof BlockbookError && (e.status === 429 || /rate limit/i.test(e.message));
        const delay = RETRY_DELAYS_MS[attempt];
        if (!limited || delay === undefined) throw e;
        await sleep(delay);
      }
    }
  }

  private async getOnce(path: string): Promise<Json> {
    await this.pacer.take();
    const res = await this.fetchImpl(`${this.net.indexer}/api/v2/${path}`);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      // A proxy or edge page instead of the API. Never try to read it as data.
      throw new BlockbookError(`indexer returned non-JSON (HTTP ${res.status})`, res.status);
    }
    if (body && typeof body === "object" && "error" in body) {
      const err = (body as Json).error;
      throw new BlockbookError(
        typeof err === "string" ? err : JSON.stringify(err),
        res.status,
      );
    }
    if (!res.ok) throw new BlockbookError(`indexer HTTP ${res.status}`, res.status);
    if (!body || typeof body !== "object") throw new BlockbookError("unexpected indexer response");
    return body as Json;
  }

  async status(): Promise<IndexerStatus> {
    const body = await this.get("");
    const bb = body.blockbook as Json | undefined;
    if (!bb || typeof bb.bestHeight !== "number") {
      throw new BlockbookError("indexer status missing bestHeight");
    }
    return { bestHeight: bb.bestHeight, inSync: bb.inSync === true };
  }

  async summary(address: string): Promise<AddressSummary> {
    // Not details=basic: observed 2026-09-19, basic omits unconfirmedBalance
    // even with a transaction in the mempool, so an incoming payment showed a
    // zero balance. details=tokens includes it and costs nothing extra here,
    // since base-layer PRL addresses carry no token list.
    const b = await this.get(`address/${encodeURIComponent(address)}?details=tokens`);
    const unconfirmedTxCount = num(b.unconfirmedTxs ?? 0);
    if (unconfirmedTxCount > 0 && b.unconfirmedBalance === undefined) {
      throw new BlockbookError("indexer reported mempool activity without a pending balance");
    }
    return {
      address: String(b.address),
      balance: parseGrains(b.balance),
      unconfirmed: parseGrains(b.unconfirmedBalance ?? "0"),
      txCount: num(b.txs),
      unconfirmedTxCount,
    };
  }

  async utxos(address: string): Promise<Utxo[]> {
    const body: unknown = await this.get(`utxo/${encodeURIComponent(address)}`);
    if (!Array.isArray(body)) throw new BlockbookError("unexpected utxo response");

    const utxos = (body as Json[]).map((u): Utxo => {
      const height = num(u.height ?? 0);
      return {
        txid: str(u.txid),
        address,
        vout: num(u.vout),
        value: parseGrains(u.value),
        ...(height > 0 ? { height } : {}),
        confirmations: num(u.confirmations ?? 0),
        coinbase: u.coinbase === true,
        immature: false,
      };
    });

    // Only young outputs can be immature, so only they cost a lookup.
    const young = [
      ...new Set(
        utxos.filter((u) => u.confirmations < COINBASE_MATURITY && !u.coinbase).map((u) => u.txid),
      ),
    ];
    const isCoinbase = new Map<string, boolean>();
    await inBatches(young, LOOKUP_CONCURRENCY, async (txid) => {
      isCoinbase.set(txid, await this.isCoinbase(txid));
    });
    for (const u of utxos) {
      if (isCoinbase.get(u.txid)) u.coinbase = true;
      u.immature = u.coinbase && u.confirmations < COINBASE_MATURITY;
    }
    return utxos;
  }

  async transactions(
    address: string,
    opts: { page?: number; pageSize?: number } = {},
  ): Promise<TxPage> {
    const page = opts.page ?? 1;
    const pageSize = opts.pageSize ?? 25;
    const b = await this.get(
      `address/${encodeURIComponent(address)}?details=txs&page=${page}&pageSize=${pageSize}`,
    );
    const raw = Array.isArray(b.transactions) ? (b.transactions as Json[]) : [];
    return {
      page: num(b.page ?? page),
      totalPages: num(b.totalPages ?? 1),
      txs: raw.map(parseTx),
    };
  }

  async transaction(txid: string): Promise<IndexerTx> {
    return parseTx(await this.get(`tx/${encodeURIComponent(txid)}`));
  }

  /**
   * Fee rate in sat/vB for confirmation within `blocks`, never below the relay
   * floor. Blockbook answers in PRL/kB and returns -1 when the node has no
   * estimate, which is common on a young chain; both land on the floor.
   */
  async feeRate(blocks = 2): Promise<number> {
    let perKb: bigint;
    try {
      const b = await this.get(`estimatefee/${blocks}`);
      perKb = parsePrl(str(b.result));
    } catch (e) {
      if (e instanceof BlockbookError && e.status !== undefined && e.status >= 500) throw e;
      perKb = -1n;
    }
    if (perKb <= 0n) return MIN_RELAY_SAT_PER_VB;
    // Fractional on purpose: rounding 1.006 sat/vB up to 2 doubles the fee.
    // The transaction builder rounds the final fee up, once.
    return Math.max(MIN_RELAY_SAT_PER_VB, Number(perKb) / 1000);
  }

  private async isCoinbase(txid: string): Promise<boolean> {
    const tx = await this.transaction(txid);
    return tx.vin.some((i) => i.coinbase);
  }

  /** Submits a signed transaction. Returns the txid the node reports. */
  async broadcast(rawHex: string): Promise<string> {
    if (!/^[0-9a-f]+$/i.test(rawHex)) throw new BlockbookError("broadcast expects raw hex");
    const res = await this.fetchImpl(`${this.net.indexer}/api/v2/sendtx/`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: rawHex,
    });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new BlockbookError(`indexer returned non-JSON (HTTP ${res.status})`, res.status);
    }
    const b = body as Json;
    if (typeof b.error === "string" || (b.error && typeof b.error === "object")) {
      const msg = typeof b.error === "string" ? b.error : JSON.stringify(b.error);
      throw new BlockbookError(`node rejected the transaction: ${msg}`, res.status);
    }
    return str(b.result);
  }
}

/** Parallel requests per burst. Polite to a public indexer, fast enough for a
 *  mining wallet with a hundred young coinbase outputs. */
export const LOOKUP_CONCURRENCY = 8;

/** Runs `fn` over `items`, at most `size` at a time. */
export async function inBatches<T>(
  items: readonly T[],
  size: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
}

function parseTx(t: Json): IndexerTx {
  const height = num(t.blockHeight ?? 0);
  return {
    txid: str(t.txid),
    ...(typeof t.hex === "string" ? { hex: t.hex } : {}),
    ...(height > 0 ? { height } : {}),
    time: num(t.blockTime ?? 0),
    confirmations: num(t.confirmations ?? 0),
    fee: parseGrains(t.fees ?? "0"),
    vin: arr(t.vin).map((i) => ({
      addresses: strs(i.addresses),
      value: i.value === undefined ? 0n : parseGrains(i.value),
      coinbase: typeof i.coinbase === "string",
    })),
    vout: arr(t.vout).map((o) => ({
      n: num(o.n),
      addresses: strs(o.addresses),
      value: parseGrains(o.value ?? "0"),
      spent: o.spent === true,
    })),
  };
}

function num(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new BlockbookError(`expected a number, got ${JSON.stringify(v)}`);
  }
  return v;
}

function str(v: unknown): string {
  if (typeof v !== "string") throw new BlockbookError(`expected a string, got ${JSON.stringify(v)}`);
  return v;
}

function arr(v: unknown): Json[] {
  return Array.isArray(v) ? (v as Json[]) : [];
}

function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
}
