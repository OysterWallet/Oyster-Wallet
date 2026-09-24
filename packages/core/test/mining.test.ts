import { describe, it, expect } from "vitest";
import type { WalletTx } from "../src/account/history.js";
import { miningStats } from "../src/account/mining.js";

const PRL = 100_000_000n;
// Friday 2026-09-18 12:00 UTC.
const NOW = Date.UTC(2026, 8, 18, 12, 0, 0) / 1000;
const H = 3600;

const rx = (net: bigint, time: number, extra: Partial<WalletTx> = {}): WalletTx => ({
  txid: `t${time}`, time, confirmations: 10, net, fee: 0n, direction: "received", coinbase: false, ...extra,
});

describe("miningStats", () => {
  it("buckets payouts into seven local days, today last", () => {
    const s = miningStats(
      [rx(10n * PRL, NOW - 2 * H), rx(5n * PRL, NOW - 26 * H), rx(3n * PRL, NOW - 6 * 24 * H), rx(99n * PRL, NOW - 8 * 24 * H)],
      { nowSec: NOW, tzOffsetMinutes: 0 },
    );
    expect(s.days.map((d) => d.total)).toEqual([3n * PRL, 0n, 0n, 0n, 0n, 5n * PRL, 10n * PRL]);
    expect(s.today).toMatchObject({ total: 10n * PRL, count: 1 });
    expect(s.last7).toBe(18n * PRL); // the 8-day-old payout is outside the window
    expect(s.dailyAverage).toBe((18n * PRL) / 7n);
  });

  it("uses the local calendar day, not UTC", () => {
    // 01:00 UTC Friday is still Thursday evening in New York (UTC-4, offset +240).
    const t = Date.UTC(2026, 8, 18, 1, 0, 0) / 1000;
    const utc = miningStats([rx(PRL, t)], { nowSec: NOW, tzOffsetMinutes: 0 });
    const ny = miningStats([rx(PRL, t)], { nowSec: NOW, tzOffsetMinutes: 240 });
    expect(utc.today.total).toBe(PRL);
    expect(ny.today.total).toBe(0n);
    expect(ny.days[5]!.total).toBe(PRL);
  });

  it("counts only incoming payments, and labels status", () => {
    const s = miningStats(
      [
        rx(2n * PRL, 0, { confirmations: 0 }),
        rx(3n * PRL, NOW - H, { coinbase: true, confirmations: 40 }),
        rx(4n * PRL, NOW - 2 * H, { coinbase: true, confirmations: 150 }),
        { ...rx(-1n * PRL, NOW - H), direction: "sent" },
      ],
      { nowSec: NOW, tzOffsetMinutes: 0 },
    );
    expect(s.payouts.map((p) => [p.status, p.blockReward])).toEqual([
      ["confirming", false],
      ["maturing", true],
      ["confirmed", true],
    ]);
    expect(s.today.total).toBe(9n * PRL);
  });
});
