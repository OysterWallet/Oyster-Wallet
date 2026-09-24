import { Transaction } from "@scure/btc-signer";
import { hex } from "@scure/base";
import { describe, it, expect } from "vitest";
import { accountFromSeed, type DerivedAddress } from "../src/derivation.js";
import type { Utxo } from "../src/indexer/blockbook.js";
import { PEARL_TESTNET2 } from "../src/network.js";
import { signPlan } from "../src/tx/build.js";
import { applyFreezePolicy, FREEZE_AT_OR_BELOW, outpoint } from "../src/tx/freeze.js";
import { planSpend, SpendError } from "../src/tx/select.js";

const net = PEARL_TESTNET2;
const acct = accountFromSeed(new Uint8Array(64).fill(7), net);
const a0 = acct.deriveAddress({ index: 0 });
const a1 = acct.deriveAddress({ index: 1 });
const change0 = acct.deriveAddress({ index: 0, change: true });
const owned = new Map<string, DerivedAddress>([a0, a1, change0].map((d) => [d.address, d]));
const RECIPIENT = "tprl1pmw509tys3kulusq5an6sy687evtmjd45hehluh9knn46n2v2gdpscgc7mf";
const PRL = 100_000_000n;

let n = 0;
const utxo = (value: bigint, extra: Partial<Utxo> = {}): Utxo => ({
  txid: (++n).toString(16).padStart(64, "0"),
  vout: 0,
  address: a0.address,
  value,
  confirmations: 10,
  height: 100,
  coinbase: false,
  immature: false,
  ...extra,
});

describe("freeze policy", () => {
  it("freezes small outputs by default and labels postage values", () => {
    const [ins, small, big] = applyFreezePolicy([utxo(546n), utxo(50_000n), utxo(5n * PRL)], new Set());
    expect(ins).toMatchObject({ frozen: true, freezeReason: "inscription" });
    expect(small).toMatchObject({ frozen: true, freezeReason: "small-output" });
    expect(big!.frozen).toBe(false);
  });

  it("honours an explicit per-outpoint unfreeze and nothing broader", () => {
    const a = utxo(546n);
    const b = utxo(546n);
    const [ua, ub] = applyFreezePolicy([a, b], new Set([outpoint(a)]));
    expect(ua!.frozen).toBe(false);
    expect(ub!.frozen).toBe(true);
  });

  it("never freezes coinbase outputs", () => {
    expect(applyFreezePolicy([utxo(546n, { coinbase: true })], new Set())[0]!.frozen).toBe(false);
  });
});

describe("planSpend", () => {
  const base = { to: RECIPIENT, changeAddress: change0.address, net, feeRate: 2 };

  it("never selects frozen, immature or unconfirmed outputs, and reports them", () => {
    const utxos = applyFreezePolicy(
      [
        utxo(546n),
        utxo(100n * PRL, { coinbase: true, immature: true, confirmations: 5 }),
        utxo(50n * PRL, { confirmations: 0 }),
        utxo(3n * PRL),
      ],
      new Set(),
    );
    const plan = planSpend({ ...base, utxos, amount: 1n * PRL });
    expect(plan.inputs.map((i) => i.value)).toEqual([3n * PRL]);
    expect(plan.excluded).toEqual({ frozen: 1, immature: 1, unconfirmed: 1 });
  });

  it("spends our own unconfirmed change, but never someone else's unconfirmed coins", () => {
    const utxos = applyFreezePolicy(
      [utxo(3n * PRL, { confirmations: 0, trusted: true }), utxo(9n * PRL, { confirmations: 0 })],
      new Set(),
    );
    const plan = planSpend({ ...base, utxos, amount: 1n * PRL });
    expect(plan.inputs.map((i) => i.value)).toEqual([3n * PRL]);
    expect(plan.excluded.unconfirmed).toBe(1);
  });

  it("explains an insufficient balance in terms of what is locked where", () => {
    const utxos = applyFreezePolicy(
      [utxo(1n * PRL), utxo(100n * PRL, { coinbase: true, immature: true, confirmations: 5 })],
      new Set(),
    );
    try {
      planSpend({ ...base, utxos, amount: 50n * PRL });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SpendError);
      expect((e as SpendError).detail).toMatchObject({ spendable: 1n * PRL, immature: 100n * PRL });
    }
  });

  it("goes largest-first and balances inputs = outputs + fee exactly", () => {
    const utxos = applyFreezePolicy([utxo(1n * PRL), utxo(4n * PRL), utxo(2n * PRL)], new Set());
    const plan = planSpend({ ...base, utxos, amount: 5n * PRL });
    expect(plan.inputs.map((i) => i.value)).toEqual([4n * PRL, 2n * PRL]);
    const inTotal = plan.inputs.reduce((s, u) => s + u.value, 0n);
    expect(inTotal).toBe(plan.amount + plan.change!.value + plan.fee);
    expect(plan.fee).toBe(BigInt(Math.ceil(plan.vsize * 2)));
  });

  it("folds change that would be frozen into the fee instead", () => {
    const utxos = applyFreezePolicy([utxo(1n * PRL)], new Set());
    // Leave ~50,000 grains over: under the freeze threshold.
    const plan = planSpend({ ...base, feeRate: 1, utxos, amount: 1n * PRL - 50_000n });
    expect(plan.change).toBeUndefined();
    expect(plan.fee).toBe(50_000n);
    expect(plan.fee).toBeLessThanOrEqual(FREEZE_AT_OR_BELOW + 200n);
  });

  it("max sends everything spendable minus the fee, with no change", () => {
    const utxos = applyFreezePolicy([utxo(1n * PRL), utxo(2n * PRL), utxo(546n)], new Set());
    const plan = planSpend({ ...base, utxos, max: true });
    expect(plan.change).toBeUndefined();
    expect(plan.amount + plan.fee).toBe(3n * PRL);
    expect(plan.excluded.frozen).toBe(1);
  });

  it("rejects dust amounts and absurd fee rates", () => {
    const utxos = applyFreezePolicy([utxo(1n * PRL)], new Set());
    expect(() => planSpend({ ...base, utxos, amount: 100n })).toThrow(/dust/);
    expect(() => planSpend({ ...base, utxos, amount: PRL / 2n, feeRate: 0.5 })).toThrow(/fee rate/);
    expect(() => planSpend({ ...base, utxos, amount: PRL / 2n, feeRate: 100_000 })).toThrow(/fee rate/);
  });
});

describe("signPlan", () => {
  it("produces a finalized key-path spend matching the plan", () => {
    const utxos = applyFreezePolicy(
      [utxo(2n * PRL), utxo(1n * PRL, { address: a1.address })],
      new Set(),
    );
    const plan = planSpend({
      utxos, to: RECIPIENT, amount: 25n * PRL / 10n, changeAddress: change0.address, net, feeRate: 3,
    });
    const signed = signPlan(plan, acct, owned, net);

    const tx = Transaction.fromRaw(hex.decode(signed.hex));
    expect(tx.id).toBe(signed.txid);
    expect(tx.inputsLength).toBe(2);
    for (let i = 0; i < tx.inputsLength; i++) {
      const w = tx.getInput(i).finalScriptWitness!;
      expect(w).toHaveLength(1); // key path: a single 64-byte Schnorr signature
      expect(w[0]).toHaveLength(64);
      expect(tx.getInput(i).sequence).toBe(0xfffffffd);
    }
    expect(tx.getOutput(0).amount).toBe(plan.amount);
    expect(signed.vsize).toBeLessThanOrEqual(plan.vsize);
  });

  it("refuses to sign an input the account does not own", () => {
    const stranger = accountFromSeed(new Uint8Array(64).fill(9), net).deriveAddress({ index: 0 });
    const utxos = applyFreezePolicy([utxo(2n * PRL, { address: stranger.address })], new Set());
    const plan = planSpend({ utxos, to: RECIPIENT, amount: PRL, changeAddress: change0.address, net, feeRate: 1 });
    expect(() => signPlan(plan, acct, owned, net)).toThrow(/does not own/);
  });

  it("fails before broadcast if the derivation map points at the wrong key", () => {
    const utxos = applyFreezePolicy([utxo(2n * PRL)], new Set());
    const plan = planSpend({ utxos, to: RECIPIENT, amount: PRL, changeAddress: change0.address, net, feeRate: 1 });
    const lying = new Map(owned);
    lying.set(a0.address, a1); // claims a0 is at index 1
    expect(() => signPlan(plan, acct, lying, net)).toThrow();
  });
});

describe("coin control", () => {
  const plan = (utxos: Utxo[], only: string[], amount: bigint | "max" = 1n * PRL) =>
    planSpend({
      utxos: applyFreezePolicy(utxos, new Set()),
      to: RECIPIENT,
      ...(amount === "max" ? { max: true } : { amount }),
      feeRate: 2,
      changeAddress: change0.address,
      net,
      only,
    });

  it("spends exactly the coins chosen, and no others", () => {
    const coins = [utxo(5n * PRL), utxo(3n * PRL), utxo(9n * PRL)];
    const pick = [outpoint(coins[1]!), outpoint(coins[2]!)];
    const p = plan(coins, pick);
    expect(p.inputs.map(outpoint).sort()).toEqual(pick.sort());
    expect(p.change!.value).toBe(3n * PRL + 9n * PRL - 1n * PRL - p.fee);
  });

  it("sends only the chosen coins on a Max send", () => {
    const coins = [utxo(5n * PRL), utxo(3n * PRL)];
    const p = plan(coins, [outpoint(coins[0]!)], "max");
    expect(p.inputs).toHaveLength(1);
    expect(p.amount).toBe(5n * PRL - p.fee);
  });

  it("refuses when the chosen coins do not cover it, rather than adding one", () => {
    const coins = [utxo(5n * PRL), utxo(3n * PRL)];
    expect(() => planSpend({
      utxos: applyFreezePolicy(coins, new Set()),
      to: RECIPIENT, amount: 4n * PRL, feeRate: 2, changeAddress: change0.address, net,
      only: [outpoint(coins[1]!)],
    })).toThrow(SpendError);
  });

  it("will not quietly spend a protected coin just because it was picked", () => {
    const coins = [utxo(5n * PRL), utxo(50_000n)];
    expect(() => plan(coins, [outpoint(coins[1]!)])).toThrow(/cannot be spent/i);
  });
});
