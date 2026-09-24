import { Transaction } from "@scure/btc-signer";
import { hex } from "@scure/base";
import { describe, it, expect } from "vitest";
import { accountFromSeed, type DerivedAddress } from "../../src/derivation.js";
import { COINBASE_MATURITY, type IndexerTx, type Utxo } from "../../src/indexer/blockbook.js";
import { PEARL_REGTEST } from "../../src/network.js";
import { signPlan } from "../../src/tx/build.js";
import { planBump } from "../../src/tx/bump.js";
import { applyFreezePolicy } from "../../src/tx/freeze.js";
import { planSpend } from "../../src/tx/select.js";

/**
 * PHASE 2 EXIT, against a real pearld: our signatures and our coinbase-
 * maturity rule, judged by Pearl's own consensus code rather than by us.
 *
 * Needs the regtest node from scripts/regtest-node.sh: pearld --regtest,
 * RPC 127.0.0.1:44990 (v/v), 101+ blocks mined to index 0 of the 0x42 seed.
 * Skips itself when that node is not running.
 */

const RPC = "http://127.0.0.1:44990";
const net = PEARL_REGTEST;
const acct = accountFromSeed(new Uint8Array(64).fill(0x42), net);
const miner = acct.deriveAddress({ index: 0 });
const owned = new Map<string, DerivedAddress>(
  [miner, acct.deriveAddress({ index: 1 }), acct.deriveAddress({ index: 0, change: true })].map((d) => [
    d.address,
    d,
  ]),
);

async function rpc<T = unknown>(method: string, ...params: unknown[]): Promise<T> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { authorization: `Basic ${btoa("v:v")}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "1.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result: T; error: { message: string } | null };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

const nodeUp = await rpc<number>("getblockcount").then(
  (h) => h > COINBASE_MATURITY,
  () => false,
);

/** Coinbase outputs paying `miner` at the given heights, exact amounts from raw hex. */
async function coinbaseUtxos(heights: number[], tip: number): Promise<Utxo[]> {
  const out: Utxo[] = [];
  for (const height of heights) {
    const block = await rpc<{ rawtx: { hex: string; txid: string }[] }>(
      "getblock",
      await rpc<string>("getblockhash", height),
      2,
    );
    const cb = Transaction.fromRaw(hex.decode(block.rawtx[0]!.hex), { allowUnknownOutputs: true });
    const confirmations = tip - height + 1;
    out.push({
      txid: block.rawtx[0]!.txid,
      vout: 0,
      address: miner.address,
      value: cb.getOutput(0).amount!,
      height,
      confirmations,
      coinbase: true,
      immature: confirmations < COINBASE_MATURITY,
    });
  }
  return out;
}

describe.skipIf(!nodeUp)("regtest end to end", () => {
  it("pearld accepts, mines and confirms a transaction we built and signed", async () => {
    const tip = await rpc<number>("getblockcount");
    // First mature coinbase still unspent; earlier runs spent the lower ones.
    let height = 1;
    while ((await rpc<unknown>("gettxout", (await coinbaseUtxos([height], tip))[0]!.txid, 0)) === null) height++;
    const [mature] = await coinbaseUtxos([height], tip);
    expect(mature!.immature).toBe(false);

    const to = acct.deriveAddress({ index: 1 }).address;
    const plan = planSpend({
      utxos: applyFreezePolicy([mature!], new Set()),
      to,
      amount: 100n * 100_000_000n,
      changeAddress: acct.deriveAddress({ index: 0, change: true }).address,
      net,
      feeRate: 2,
    });
    const signed = signPlan(plan, acct, owned, net);

    const [check] = await rpc<{ allowed: boolean; "reject-reason"?: string }[]>(
      "testmempoolaccept",
      [signed.hex],
      0.1, // max fee rate in PRL/kvB; pearld requires it
    );
    console.log(`testmempoolaccept: ${JSON.stringify(check)}`);
    expect(check!.allowed).toBe(true);

    const txid = await rpc<string>("sendrawtransaction", signed.hex);
    expect(txid).toBe(signed.txid);
    const [blockHash] = await rpc<string[]>("generate", 1);

    // No txindex on this node, so confirm by finding the tx in the new block.
    const block = await rpc<{ height: number; tx: string[] }>("getblock", blockHash, 1);
    console.log(
      `confirmed ${txid} in block ${block.height}: ${signed.vsize} vB, fee ${signed.fee} grains, ` +
        `spent coinbase from height ${height}`,
    );
    expect(block.tx).toContain(txid);
    // And the recipient output now exists in the UTXO set.
    expect(await rpc("gettxout", txid, 0)).not.toBeNull();
  });

  it("the node rejects a young coinbase exactly where we mark it immature", async () => {
    const tip = await rpc<number>("getblockcount");
    // Next block is tip+1; a coinbase at tip-98 would have 99 confirmations.
    const [young] = await coinbaseUtxos([tip - 98], tip);
    expect(young!.immature).toBe(true);

    // Force our own guard off to see what the chain itself says.
    const forced = { ...young!, immature: false };
    const plan = planSpend({
      utxos: applyFreezePolicy([forced], new Set()),
      to: acct.deriveAddress({ index: 1 }).address,
      amount: 100_000_000n,
      changeAddress: acct.deriveAddress({ index: 0, change: true }).address,
      net,
      feeRate: 2,
    });
    const [check] = await rpc<{ allowed: boolean; "reject-reason"?: string }[]>(
      "testmempoolaccept",
      [signPlan(plan, acct, owned, net).hex],
      0.1,
    );
    console.log(`immature coinbase: ${check!["reject-reason"]}`);
    // pearld omits `allowed` when false (Go omitempty).
    expect(check!.allowed).not.toBe(true);
    expect(check!["reject-reason"]).toMatch(/maturity/);
  });
  it("pearld accepts a Speed up replacement and evicts the original (phase 4)", async () => {
    const tip = await rpc<number>("getblockcount");
    let height = 1;
    while ((await rpc<unknown>("gettxout", (await coinbaseUtxos([height], tip))[0]!.txid, 0)) === null) height++;
    const [coin] = await coinbaseUtxos([height], tip);
    const to = acct.deriveAddress({ index: 1 }).address;
    const change = acct.deriveAddress({ index: 0, change: true }).address;

    // A deliberately cheap send, the kind that gets stuck.
    const plan = planSpend({ utxos: applyFreezePolicy([coin!], new Set()), to, amount: 50n * 100_000_000n, changeAddress: change, net, feeRate: 1 });
    const slow = signPlan(plan, acct, owned, net);
    expect(await rpc<string>("sendrawtransaction", slow.hex)).toBe(slow.txid);

    // Present it the way the indexer would, then plan and sign the bump.
    // `to` is ours here too, so drop it from `owned` for the shape check.
    const ownedNoRecipient = new Map(owned);
    ownedNoRecipient.delete(to);
    const asIndexed: IndexerTx = {
      txid: slow.txid, hex: slow.hex, time: 0, confirmations: 0, fee: slow.fee,
      vin: plan.inputs.map((u) => ({ addresses: [u.address], value: u.value, coinbase: false })),
      vout: [
        { n: 0, addresses: [to], value: plan.amount, spent: false },
        ...(plan.change ? [{ n: 1, addresses: [plan.change.address], value: plan.change.value, spent: false }] : []),
      ],
    };
    const bump = planBump({ tx: asIndexed, owned: ownedNoRecipient, spendable: [], feeRate: 10, changeAddress: change, net });
    const fast = signPlan(bump, acct, owned, net);
    expect(await rpc<string>("sendrawtransaction", fast.hex)).toBe(fast.txid);

    const pool = await rpc<string[]>("getrawmempool");
    console.log(`replaced ${slow.txid.slice(0, 12)} (${slow.fee} grains) with ${fast.txid.slice(0, 12)} (${fast.fee} grains); mempool has new: ${pool.includes(fast.txid)}, old: ${pool.includes(slow.txid)}`);
    expect(pool).toContain(fast.txid);
    expect(pool).not.toContain(slow.txid);

    const [blockHash] = await rpc<string[]>("generate", 1);
    const block = await rpc<{ tx: string[] }>("getblock", blockHash, 1);
    expect(block.tx).toContain(fast.txid);
    expect(block.tx).not.toContain(slow.txid);
  });
});
