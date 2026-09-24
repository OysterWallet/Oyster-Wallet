import { hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import { describe, it, expect } from "vitest";
import { accountFromSeed, type DerivedAddress } from "../src/derivation.js";
import type { IndexerTx, Utxo } from "../src/indexer/blockbook.js";
import { PEARL_TESTNET2 } from "../src/network.js";
import { signPlan } from "../src/tx/build.js";
import { BumpError, planBump, planCancel } from "../src/tx/bump.js";
import { applyFreezePolicy } from "../src/tx/freeze.js";
import { planSpend } from "../src/tx/select.js";

const net = PEARL_TESTNET2;
const acct = accountFromSeed(new Uint8Array(64).fill(11), net);
const a0 = acct.deriveAddress({ index: 0 });
const c0 = acct.deriveAddress({ index: 0, change: true });
const c1 = acct.deriveAddress({ index: 1, change: true });
const owned = new Map<string, DerivedAddress>([a0, c0, c1].map((d) => [d.address, d]));
const RECIPIENT = "tprl1pmw509tys3kulusq5an6sy687evtmjd45hehluh9knn46n2v2gdpscgc7mf";
const PRL = 100_000_000n;

let n = 0;
const utxo = (value: bigint, extra: Partial<Utxo> = {}): Utxo => ({
  txid: (++n).toString(16).padStart(64, "0"), vout: 0, address: a0.address, value,
  confirmations: 10, height: 100, coinbase: false, immature: false, ...extra,
});

/** Sign a real send and present it the way the indexer would. */
function sent(coins: Utxo[], amount: bigint | "max", feeRate: number): IndexerTx {
  const plan = planSpend({
    utxos: applyFreezePolicy(coins, new Set()), to: RECIPIENT,
    ...(amount === "max" ? { max: true } : { amount }), feeRate, changeAddress: c0.address, net,
  });
  const signed = signPlan(plan, acct, owned, net);
  const raw = Transaction.fromRaw(hex.decode(signed.hex));
  return {
    txid: signed.txid, hex: signed.hex, time: 0, confirmations: 0, fee: signed.fee,
    vin: plan.inputs.map((u) => ({ addresses: [u.address], value: u.value, coinbase: false })),
    vout: Array.from({ length: raw.outputsLength }, (_, i) => ({
      n: i,
      addresses: [i === 0 ? RECIPIENT : c0.address],
      value: raw.getOutput(i).amount!,
    })),
  };
}

const bump = (tx: IndexerTx, feeRate: number, spendable: Utxo[] = []) =>
  planBump({ tx, owned, spendable: applyFreezePolicy(spendable, new Set()), feeRate, changeAddress: c1.address, net });

describe("planBump", () => {
  it("keeps the payment exactly and takes the extra fee from change", () => {
    const tx = sent([utxo(5n * PRL)], 1n * PRL, 1);
    const b = bump(tx, 10);
    expect(b.to).toBe(RECIPIENT);
    expect(b.amount).toBe(1n * PRL);
    expect(b.inputs).toHaveLength(1);
    expect(b.fee).toBeGreaterThan(tx.fee);
    expect(b.change!.value).toBe(5n * PRL - 1n * PRL - b.fee);
    // Node rules: strictly higher rate, and old fee + 1 sat/vB of the new size.
    expect(Number(b.fee) / b.vsize).toBeGreaterThan(b.oldFeeRate);
    expect(b.fee).toBeGreaterThanOrEqual(tx.fee + BigInt(b.vsize));
  });

  it("signs into a valid replacement spending the same coins", () => {
    const tx = sent([utxo(5n * PRL)], 1n * PRL, 1);
    const b = bump(tx, 10);
    const signed = signPlan(b, acct, owned, net);
    const orig = Transaction.fromRaw(hex.decode(tx.hex!));
    const repl = Transaction.fromRaw(hex.decode(signed.hex));
    expect(hex.encode(repl.getInput(0).txid!)).toBe(hex.encode(orig.getInput(0).txid!));
    expect(repl.getInput(0).index).toBe(orig.getInput(0).index);
    expect(repl.getInput(0).sequence).toBe(0xfffffffd);
    expect(signed.txid).not.toBe(tx.txid);
  });

  it("adds a confirmed coin when a Max send has no change to take from", () => {
    const tx = sent([utxo(2n * PRL)], "max", 1);
    expect(() => bump(tx, 10)).toThrow(BumpError);
    const b = bump(tx, 10, [utxo(1n * PRL)]);
    expect(b.inputs).toHaveLength(2);
    expect(b.amount).toBe(tx.vout[0]!.value);
    expect(b.change!.address).toBe(c1.address);
  });

  it("refuses a lower or equal rate, a confirmed tx, and one it did not make", () => {
    const tx = sent([utxo(5n * PRL)], 1n * PRL, 5);
    expect(() => bump(tx, 4)).toThrow(/must be above/);
    expect(() => bump({ ...tx, confirmations: 1 }, 20)).toThrow(/already confirmed/);
    const foreign = { ...tx, vin: tx.vin.map((v) => ({ ...v, addresses: [RECIPIENT] })) };
    expect(() => bump(foreign, 20)).toThrow(/does not control/);
    expect(() => planBump({ tx, owned, spendable: [], feeRate: 20, changeAddress: c1.address, net, outputsSpent: true }))
      .toThrow(/already been spent/);
  });
});

const cancel = (tx: IndexerTx, feeRate: number) =>
  planCancel({ tx, owned, spendable: [], feeRate, changeAddress: c1.address, net });

describe("planCancel", () => {
  it("pays everything back to your own address, not the recipient", () => {
    const tx = sent([utxo(5n * PRL)], 1n * PRL, 1);
    const c = cancel(tx, 10);
    expect(c.to).toBe(c0.address); // the original change address is ours
    expect(owned.has(c.to)).toBe(true);
    expect(c.change).toBeUndefined();
    expect(c.amount).toBe(5n * PRL - c.fee);
    expect(c.inputs.map((i) => i.txid)).toEqual(tx.vin.map((_, i) => tx.vin[i] && c.inputs[i]!.txid));
    expect(c.replaces).toBe(tx.txid);
  });

  it("obeys the same replacement rules the node enforces", () => {
    const tx = sent([utxo(5n * PRL)], 1n * PRL, 1);
    const c = cancel(tx, 10);
    expect(Number(c.fee) / c.vsize).toBeGreaterThan(c.oldFeeRate);
    expect(c.fee).toBeGreaterThanOrEqual(tx.fee + BigInt(c.vsize));
    expect(() => cancel(tx, 1)).toThrow(BumpError);
  });

  it("signs into a valid transaction spending the same coins", () => {
    const tx = sent([utxo(5n * PRL), utxo(2n * PRL)], 6n * PRL, 1);
    const c = cancel(tx, 12);
    const signed = signPlan(c, acct, owned, net);
    const raw = Transaction.fromRaw(hex.decode(signed.hex));
    expect(raw.inputsLength).toBe(tx.vin.length);
    expect(raw.outputsLength).toBe(1);
    expect(raw.getOutput(0).amount).toBe(c.amount);
    expect(signed.fee).toBe(c.fee);
  });

  it("refuses when the fee would eat everything, and when it is already confirmed", () => {
    // A coin barely above the freeze floor, then a fee rate that would eat it.
    const tiny = sent([utxo(120_000n)], 110_000n, 1);
    expect(() => cancel(tiny, 2_000)).toThrow(/dust/i);
    const done = { ...sent([utxo(5n * PRL)], 1n * PRL, 1), confirmations: 2 };
    expect(() => cancel(done, 10)).toThrow(BumpError);
  });
});
