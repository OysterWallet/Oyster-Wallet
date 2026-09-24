import { describe, it, expect } from "vitest";
import { accountHistory } from "../../src/account/history.js";
import { scanAccount } from "../../src/account/scan.js";
import { formatPrl } from "../../src/amount.js";
import { accountFromSeed } from "../../src/derivation.js";
import { BlockbookClient } from "../../src/indexer/blockbook.js";
import { PEARL_TESTNET2 } from "../../src/network.js";
import type { FetchLike } from "../../src/platform.js";

/**
 * PHASE 1 EXIT. Runs against the live testnet2 indexer: `pnpm test:live`.
 *
 * FUNDED is a public testnet2 miner seen in block 99,946's coinbase. It is not
 * ours; it is simply an address guaranteed to have balance, history and young
 * coinbase outputs, which exercises every read path at once.
 */
const FUNDED = "tprl1pmw509tys3kulusq5an6sy687evtmjd45hehluh9knn46n2v2gdpscgc7mf";
const client = new BlockbookClient(PEARL_TESTNET2, globalThis.fetch as unknown as FetchLike);

describe("live testnet2 read path", () => {
  it("indexer is in sync", async () => {
    const s = await client.status();
    console.log(`testnet2 indexer: height ${s.bestHeight}, inSync ${s.inSync}`);
    expect(s.inSync).toBe(true);
  });

  it("reads balance and history for a funded address", async () => {
    const sum = await client.summary(FUNDED);
    console.log(`${FUNDED}\n  balance ${formatPrl(sum.balance)} tPRL, ${sum.txCount} txs`);
    expect(sum.balance).toBeGreaterThan(0n);

    const page = await client.transactions(FUNDED, { pageSize: 5 });
    for (const tx of page.txs) {
      const out = tx.vout.filter((o) => o.addresses.includes(FUNDED)).reduce((s, o) => s + o.value, 0n);
      console.log(`  ${tx.height ?? "mempool"}  ${tx.txid.slice(0, 16)}…  +${formatPrl(out)}`);
    }
    expect(page.txs.length).toBeGreaterThan(0);
  });

  it("marks the miner's newest coinbase outputs immature", async () => {
    const utxos = await client.utxos(FUNDED);
    const immature = utxos.filter((u) => u.immature);
    console.log(`  ${utxos.length} utxos, ${immature.length} immature coinbase`);
    expect(immature.length).toBeGreaterThan(0);
    expect(immature.every((u) => u.coinbase && u.confirmations < 100)).toBe(true);
  });

  it("returns a usable fee rate", async () => {
    const rate = await client.feeRate(2);
    console.log(`  fee rate (2 blocks): ${rate} sat/vB`);
    expect(rate).toBeGreaterThanOrEqual(1);
  });

  it("scans an empty account to index 0 without touching the xpub endpoint", async () => {
    // Fixed dummy seed: no mnemonic, never funded, safe to commit.
    const acct = accountFromSeed(new Uint8Array(64).fill(0x42), PEARL_TESTNET2);
    const scan = await scanAccount(acct, client);
    const history = await accountHistory(scan, client);
    console.log(`  empty account: next receive ${acct.deriveAddress({ index: 0 }).address}`);
    expect(scan.used).toHaveLength(0);
    expect(scan.nextReceiveIndex).toBe(0);
    expect(history.txs).toHaveLength(0);
  });
});
