import { COINBASE_MATURITY } from "../indexer/blockbook.js";
import type { WalletTx } from "./history.js";

/**
 * Mining statistics for a wallet in miner mode.
 *
 * A payout is any incoming payment (decided 2026-09-19): pool payouts are
 * ordinary transactions, so counting only coinbase outputs would show pool
 * miners nothing. Solo block rewards are still told apart (`blockReward`).
 *
 * Days are local-time calendar days. The caller passes the UTC offset
 * (JS `getTimezoneOffset()`, minutes, positive west of UTC) so the numbers
 * match the user's clock and the tests stay deterministic.
 */

export type PayoutStatus = "confirming" | "maturing" | "confirmed";

export interface Payout {
  txid: string;
  amount: bigint;
  /** Unix seconds; unconfirmed payouts are stamped `nowSec`. */
  time: number;
  confirmations: number;
  blockReward: boolean;
  status: PayoutStatus;
}

export interface DayTotal {
  /** Local midnight, unix seconds. */
  start: number;
  total: bigint;
  count: number;
}

export interface MiningStats {
  today: DayTotal;
  /** Oldest first, today last: seven entries. */
  days: DayTotal[];
  last7: bigint;
  /** last7 / 7, rounded down to whole grains. */
  dailyAverage: bigint;
  /** Newest first. */
  payouts: Payout[];
}

const DAY = 86_400;

export function miningStats(
  txs: readonly WalletTx[],
  opts: { nowSec: number; tzOffsetMinutes: number },
): MiningStats {
  const offset = -opts.tzOffsetMinutes * 60; // seconds to add to UTC for local time
  const localDayStart = (t: number) => Math.floor((t + offset) / DAY) * DAY - offset;
  const todayStart = localDayStart(opts.nowSec);

  const payouts: Payout[] = txs
    .filter((t) => t.direction === "received" && t.net > 0n)
    .map((t) => ({
      txid: t.txid,
      amount: t.net,
      time: t.time > 0 ? t.time : opts.nowSec,
      confirmations: t.confirmations,
      blockReward: t.coinbase,
      status:
        t.confirmations === 0
          ? "confirming"
          : t.coinbase && t.confirmations < COINBASE_MATURITY
            ? "maturing"
            : "confirmed",
    }));
  payouts.sort((a, b) => b.time - a.time);

  const days: DayTotal[] = Array.from({ length: 7 }, (_, i) => ({
    start: todayStart - (6 - i) * DAY,
    total: 0n,
    count: 0,
  }));
  for (const p of payouts) {
    const idx = 6 - Math.round((todayStart - localDayStart(p.time)) / DAY);
    const day = days[idx];
    if (day) {
      day.total += p.amount;
      day.count++;
    }
  }
  const last7 = days.reduce((s, d) => s + d.total, 0n);
  return { today: days[6]!, days, last7, dailyAverage: last7 / 7n, payouts };
}
