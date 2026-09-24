import type { AccountKeys, DerivedAddress } from "../derivation.js";
import {
  inBatches,
  LOOKUP_CONCURRENCY,
  type AddressSummary,
  type BlockbookClient,
} from "../indexer/blockbook.js";

/**
 * Gap-limit account discovery, one address at a time.
 *
 * Deliberately never uses /api/v2/xpub/: see the privacy note in
 * indexer/blockbook.ts. The cost is one request per address checked, so a
 * fresh wallet with the default gap costs 40 requests (20 receive, 20 change).
 *
 * Gap limit: BIP-44's 20 is the default. Oyster itself recovers with a window
 * of 250 (seen in its logs as recovery_window=250), so a seed that handed out
 * many unused addresses in the desktop wallet can have funds past 20. Imports
 * of existing oyster seeds should scan with a larger gap.
 */

export const DEFAULT_GAP_LIMIT = 20;
/** Matches oyster's recovery window. Use when importing an existing seed. */
export const OYSTER_RECOVERY_GAP = 250;

/**
 * A known-used address the indexer has not caught up with yet.
 *
 * Zeroes throughout: it contributes nothing to a balance, which is right,
 * because whatever it holds is already counted in the unconfirmed
 * transaction that put it there. It exists so the address is recognised as
 * ours.
 */
const EMPTY_SUMMARY = { address: "", balance: 0n, unconfirmed: 0n, txCount: 0, unconfirmedTxCount: 0 };

export interface ScannedAddress {
  derived: DerivedAddress;
  summary: AddressSummary;
}

export interface AccountScan {
  /** Addresses with at least one transaction, confirmed or not, in index order. */
  used: ScannedAddress[];
  /** First never-used receive index. What the Receive screen shows. */
  nextReceiveIndex: number;
  /** First never-used change index. Where the next change output goes. */
  nextChangeIndex: number;
  confirmed: bigint;
  /** Mempool delta across the account; can be negative. */
  unconfirmed: bigint;
}

export async function scanAccount(
  acct: AccountKeys,
  client: BlockbookClient,
  opts: {
    gapLimit?: number;
    /** Highest used indexes found by an earlier scan. The scan always covers
     *  at least these, so a deep import scan is never forgotten by the
     *  default-gap scans that follow it. */
    knownUsed?: { receive: number; change: number };
  } = {},
): Promise<AccountScan> {
  const gapLimit = opts.gapLimit ?? DEFAULT_GAP_LIMIT;
  if (!Number.isInteger(gapLimit) || gapLimit < 1) throw new Error(`invalid gap limit ${gapLimit}`);

  const [receive, change] = await Promise.all([
    scanChain(acct, client, false, gapLimit, opts.knownUsed?.receive ?? -1),
    scanChain(acct, client, true, gapLimit, opts.knownUsed?.change ?? -1),
  ]);
  const used = [...receive.used, ...change.used];

  /**
   * Addresses we know we used, whatever the indexer says yet.
   *
   * A scan finds an address by asking the indexer whether anything has
   * touched it, which works for money arriving from elsewhere and is a race
   * for change we just created ourselves. Between broadcasting and the
   * indexer reporting the mempool transaction there is a window, usually a
   * second or two, where our own change address looks like a stranger's.
   *
   * That window is not harmless. Change not recognised as ours counts as
   * money leaving, so a send of three out of forty-nine displays as minus
   * forty-nine until the indexer catches up: the whole balance appearing to
   * walk out of the door, which is the single most alarming thing a wallet
   * can show somebody.
   *
   * So the indexer is not asked about these. The wallet wrote the
   * transaction and knows where it put the change.
   */
  for (const [branch, known] of [
    [false, opts.knownUsed?.receive ?? -1],
    [true, opts.knownUsed?.change ?? -1],
  ] as const) {
    for (let index = 0; index <= known; index++) {
      const derived = acct.deriveAddress({ index, change: branch });
      if (used.some((a) => a.derived.address === derived.address)) continue;
      used.push({ derived, summary: EMPTY_SUMMARY });
    }
  }
  return {
    used,
    nextReceiveIndex: receive.next,
    nextChangeIndex: change.next,
    confirmed: used.reduce((s, a) => s + a.summary.balance, 0n),
    unconfirmed: used.reduce((s, a) => s + a.summary.unconfirmed, 0n),
  };
}

async function scanChain(
  acct: AccountKeys,
  client: BlockbookClient,
  change: boolean,
  gapLimit: number,
  floor: number,
): Promise<{ used: ScannedAddress[]; next: number }> {
  const used: ScannedAddress[] = [];
  let lastUsed = -1;
  let index = 0;

  // Keep checking until `gapLimit` consecutive addresses after the last used
  // one have come back empty. Batches may overshoot the gap; that only costs
  // a few extra requests, never a missed address.
  while (index <= floor || index - lastUsed - 1 < gapLimit) {
    const batch = Array.from({ length: LOOKUP_CONCURRENCY }, (_, i) =>
      acct.deriveAddress({ index: index + i, change }),
    );
    const found: ScannedAddress[] = [];
    await inBatches(batch, LOOKUP_CONCURRENCY, async (derived) => {
      const summary = await client.summary(derived.address);
      if (summary.txCount > 0 || summary.unconfirmedTxCount > 0) found.push({ derived, summary });
    });
    for (const a of found) lastUsed = Math.max(lastUsed, a.derived.index);
    used.push(...found);
    index += batch.length;
  }

  used.sort((a, b) => a.derived.index - b.derived.index);
  return { used, next: lastUsed + 1 };
}
