import type { BlockbookClient, IndexerTx } from "../indexer/blockbook.js";
import { inBatches, LOOKUP_CONCURRENCY } from "../indexer/blockbook.js";
import type { AccountScan } from "./scan.js";

/**
 * Account-level transaction history.
 *
 * Blockbook reports history per address, and a payment that spends from one
 * of our addresses and sends change to another shows up under both. Merging
 * by txid and netting inputs against outputs over the whole account is what
 * turns that into "sent 10 PRL" instead of "sent 50, received 40".
 */

export type Direction = "received" | "sent" | "self";

export interface WalletTx {
  txid: string;
  height?: number;
  time: number;
  confirmations: number;
  /** Net change to the account in grains, fee included for our own sends. */
  net: bigint;
  fee: bigint;
  direction: Direction;
  coinbase: boolean;
  /** For sends, the first output that does not pay this account. */
  counterparty?: string;
}

export interface AccountHistory {
  txs: WalletTx[];
  /** False when some address had more history than was fetched. */
  complete: boolean;
}

export async function accountHistory(
  scan: AccountScan,
  client: BlockbookClient,
  opts: {
    pageSize?: number;
    /** Pages to fetch per address. Mining payout addresses can hold
     *  thousands of transactions, so history grows on request, not up front. */
    maxPages?: number;
    /** Stop paging an address once a page reaches back past this time (unix
     *  seconds): enough for a "last 7 days" view without the whole past. */
    stopBefore?: number;
  } = {},
): Promise<AccountHistory> {
  const pageSize = opts.pageSize ?? 25;
  const maxPages = opts.maxPages ?? 1;
  const stopBefore = opts.stopBefore;
  const own = new Set(scan.used.map((a) => a.derived.address));
  const byId = new Map<string, IndexerTx>();
  let complete = true;

  await inBatches(scan.used, LOOKUP_CONCURRENCY, async (a) => {
    for (let page = 1; page <= maxPages; page++) {
      const p = await client.transactions(a.derived.address, { page, pageSize });
      for (const tx of p.txs) byId.set(tx.txid, tx);
      if (page >= p.totalPages) return;
      if (stopBefore !== undefined && p.txs.some((t) => t.time > 0 && t.time < stopBefore)) return;
    }
    complete = false;
  });

  const txs = [...byId.values()].map((tx) => toWalletTx(tx, own));
  txs.sort(newestFirst);
  return { txs, complete };
}

export function toWalletTx(tx: IndexerTx, own: ReadonlySet<string>): WalletTx {
  const mine = (addrs: string[]) => addrs.some((a) => own.has(a));
  const spent = tx.vin.filter((i) => mine(i.addresses)).reduce((s, i) => s + i.value, 0n);
  const received = tx.vout.filter((o) => mine(o.addresses)).reduce((s, o) => s + o.value, 0n);
  const net = received - spent;
  const direction: Direction =
    spent === 0n ? "received" : net + tx.fee === 0n ? "self" : "sent";
  const counterparty =
    direction === "sent" ? tx.vout.find((o) => o.addresses.length > 0 && !mine(o.addresses))?.addresses[0] : undefined;
  return {
    txid: tx.txid,
    ...(tx.height !== undefined ? { height: tx.height } : {}),
    time: tx.time,
    confirmations: tx.confirmations,
    net,
    fee: tx.fee,
    direction,
    coinbase: tx.vin.some((i) => i.coinbase),
    ...(counterparty ? { counterparty } : {}),
  };
}

/** Unconfirmed first, then highest block first, txid as a stable tiebreak. */
function newestFirst(a: WalletTx, b: WalletTx): number {
  const ha = a.height ?? Number.POSITIVE_INFINITY;
  const hb = b.height ?? Number.POSITIVE_INFINITY;
  if (ha !== hb) return hb - ha;
  return a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0;
}
