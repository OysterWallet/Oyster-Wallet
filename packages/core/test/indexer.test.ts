import { describe, it, expect } from "vitest";
import { accountHistory, toWalletTx } from "../src/account/history.js";
import { scanAccount } from "../src/account/scan.js";
import { accountFromSeed } from "../src/derivation.js";
import { BlockbookClient, BlockbookError, type IndexerTx } from "../src/indexer/blockbook.js";
import { Pacer } from "../src/indexer/pace.js";
import { PEARL_TESTNET2 } from "../src/network.js";
import type { FetchLike } from "../src/platform.js";

/** Stub indexer: routes by path, records every request. */
function stub(route: (path: string) => { status?: number; body: unknown } | undefined) {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    const path = url.slice(`${PEARL_TESTNET2.indexer}/api/v2/`.length);
    calls.push(path);
    const r = route(path) ?? { status: 404, body: { error: "not found" } };
    const status = r.status ?? 200;
    return {
      ok: status < 400,
      status,
      json: async () => {
        if (typeof r.body === "string") throw new SyntaxError("not json");
        return r.body;
      },
      text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)),
    };
  };
  return { client: new BlockbookClient(PEARL_TESTNET2, fetch, { requestsPerSecond: 1e6 }), calls };
}

const emptySummary = (address: string) => ({
  address, balance: "0", unconfirmedBalance: "0", txs: 0, unconfirmedTxs: 0,
});

describe("BlockbookClient", () => {
  it("parses a summary with a negative mempool delta", async () => {
    const { client } = stub(() => ({
      body: { address: "a", balance: "9037208105", unconfirmedBalance: "-100", txs: 1, unconfirmedTxs: 1 },
    }));
    expect(await client.summary("a")).toEqual({
      address: "a", balance: 9037208105n, unconfirmed: -100n, txCount: 1, unconfirmedTxCount: 1,
    });
  });

  it("refuses a pending transaction reported without its amount", async () => {
    const { client, calls } = stub(() => ({ body: { address: "a", balance: "0", txs: 0, unconfirmedTxs: 1 } }));
    await expect(client.summary("a")).rejects.toThrow(/pending balance/);
    expect(calls[0]).toContain("details=tokens");
  });

  it("throws on an {error} body even with HTTP 200", async () => {
    const { client } = stub(() => ({ body: { error: "Invalid address, invalid checksum" } }));
    await expect(client.summary("x")).rejects.toThrow(/invalid checksum/);
  });

  it("refuses to read an HTML page as data", async () => {
    const { client } = stub(() => ({ status: 403, body: "<html>blocked</html>" }));
    await expect(client.summary("x")).rejects.toBeInstanceOf(BlockbookError);
  });

  it("flags young coinbase outputs as immature and mature ones as spendable", async () => {
    const { client, calls } = stub((p) => {
      if (p.startsWith("utxo/")) {
        return {
          body: [
            { txid: "cb_young", vout: 0, value: "500", height: 99946, confirmations: 1 },
            { txid: "cb_old", vout: 0, value: "500", height: 90000, confirmations: 9947 },
            { txid: "payment", vout: 1, value: "700", height: 99940, confirmations: 7 },
            { txid: "mempool", vout: 0, value: "900", height: 0, confirmations: 0 },
          ],
        };
      }
      const coinbase = p === "tx/cb_young";
      return {
        body: {
          txid: p.slice(3), blockHeight: 1, blockTime: 1, confirmations: 1, fees: "0",
          vin: [coinbase ? { coinbase: "03ab" } : { addresses: ["x"], value: "1000" }],
          vout: [],
        },
      };
    });
    const u = Object.fromEntries((await client.utxos("addr")).map((x) => [x.txid, x]));
    expect(u.cb_young).toMatchObject({ coinbase: true, immature: true });
    expect(u.payment).toMatchObject({ coinbase: false, immature: false });
    expect(u.mempool!.height).toBeUndefined();
    // Old outputs are past maturity whatever they are, so no lookup is spent on them.
    expect(calls).not.toContain("tx/cb_old");
  });

  it("retries a rate-limited request with backoff and then succeeds", async () => {
    let n = 0;
    const { client, calls } = stub(() =>
      ++n <= 2 ? { body: { error: "rate limit exceeded" } } : { body: emptySummary("a") },
    );
    const t0 = Date.now();
    expect((await client.summary("a")).txCount).toBe(0);
    expect(calls).toHaveLength(3);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1400); // 500 + 1000 ms
  });

  it("does not retry errors other than rate limiting", async () => {
    const other = stub(() => ({ body: { error: "Invalid address" } }));
    await expect(other.client.summary("x")).rejects.toThrow(/Invalid address/);
    expect(other.calls).toHaveLength(1);
  });

  it("floors fee estimates at the relay minimum and keeps fractions", async () => {
    const rate = (result: string) => stub(() => ({ body: { result } })).client.feeRate();
    expect(await rate("-1")).toBe(1);
    expect(await rate("0")).toBe(1);
    expect(await rate("0.00001006")).toBeCloseTo(1.006);
    expect(await rate("0.0018018")).toBeCloseTo(180.18);
  });
});

describe("Pacer", () => {
  it("lets a burst through, then holds to the rate", async () => {
    const p = new Pacer(20, 5);
    const t0 = Date.now();
    await Promise.all(Array.from({ length: 15 }, () => p.take()));
    // 5 immediately, 10 more at 20/s: about 500 ms.
    const ms = Date.now() - t0;
    expect(ms).toBeGreaterThanOrEqual(450);
    expect(ms).toBeLessThan(1500);
  });
});

describe("scanAccount", () => {
  const acct = accountFromSeed(new Uint8Array(64).fill(3), PEARL_TESTNET2);

  it("finds used addresses across a gap and stops after gapLimit empties", async () => {
    const used = new Map([
      [acct.deriveAddress({ index: 0 }).address, "1000"],
      [acct.deriveAddress({ index: 15 }).address, "2000"],
      [acct.deriveAddress({ index: 2, change: true }).address, "300"],
    ]);
    const { client, calls } = stub((p) => {
      const addr = decodeURIComponent(p.slice("address/".length).split("?")[0]!);
      const bal = used.get(addr);
      return { body: bal ? { ...emptySummary(addr), balance: bal, txs: 1 } : emptySummary(addr) };
    });

    const scan = await scanAccount(acct, client, { gapLimit: 20 });
    expect(scan.used.map((a) => `${a.derived.change ? "c" : "r"}${a.derived.index}`)).toEqual(["r0", "r15", "c2"]);
    expect(scan.nextReceiveIndex).toBe(16);
    expect(scan.nextChangeIndex).toBe(3);
    expect(scan.confirmed).toBe(3300n);
    // Receive must look at least 20 past index 15, change at least 20 past 2.
    const chain = (change: boolean) =>
      new Set([...Array(64).keys()].map((index) => acct.deriveAddress({ index, change }).address));
    const receiveSet = chain(false);
    const changeSet = chain(true);
    const checked = (change: boolean) =>
      calls.filter((c) => (change ? changeSet : receiveSet).has(decodeURIComponent(c.slice(8).split("?")[0]!))).length;
    expect(checked(false)).toBeGreaterThanOrEqual(36);
    expect(checked(true)).toBeGreaterThanOrEqual(23);
  });

  it("scans past a long gap when an earlier deep scan found usage there", async () => {
    const far = acct.deriveAddress({ index: 40 }).address;
    const { client } = stub((p) => {
      const addr = decodeURIComponent(p.slice("address/".length).split("?")[0]!);
      return { body: addr === far ? { ...emptySummary(addr), balance: "9", txs: 1 } : emptySummary(addr) };
    });
    const shallow = await scanAccount(acct, client, { gapLimit: 20 });
    expect(shallow.nextReceiveIndex).toBe(0); // 40 is beyond a 20 gap from nothing
    const remembered = await scanAccount(acct, client, { gapLimit: 20, knownUsed: { receive: 40, change: -1 } });
    expect(remembered.nextReceiveIndex).toBe(41);
    expect(remembered.confirmed).toBe(9n);
  });

  it("owns the change it just sent to, before the indexer has seen it", async () => {
    /**
     * The window between broadcasting and the indexer reporting the mempool
     * transaction. Asked about that address, the indexer says nothing has
     * ever touched it, which is true and useless: the wallet wrote the
     * transaction and put the change there.
     *
     * Left out, the change counts as money leaving, and a send of three out
     * of forty-nine shows as minus forty-nine.
     */
    const { client } = stub((p) => {
      const addr = decodeURIComponent(p.slice("address/".length).split("?")[0]!);
      return { body: emptySummary(addr) };
    });
    const scan = await scanAccount(acct, client, {
      gapLimit: 20,
      knownUsed: { receive: -1, change: 3 },
    });
    const owned = new Set(scan.used.map((a) => a.derived.address));
    for (let index = 0; index <= 3; index++) {
      expect(owned.has(acct.deriveAddress({ index, change: true }).address)).toBe(true);
    }
    // And it claims nothing it does not know it used.
    expect(owned.has(acct.deriveAddress({ index: 4, change: true }).address)).toBe(false);
  });

  it("does not double count an address the indexer did report", async () => {
    // It is both known-used and found, and its balance must be counted once.
    const one = acct.deriveAddress({ index: 1, change: true }).address;
    const { client } = stub((p) => {
      const addr = decodeURIComponent(p.slice("address/".length).split("?")[0]!);
      return { body: addr === one ? { ...emptySummary(addr), balance: "500", txs: 1 } : emptySummary(addr) };
    });
    const scan = await scanAccount(acct, client, { gapLimit: 20, knownUsed: { receive: -1, change: 1 } });
    expect(scan.used.filter((a) => a.derived.address === one)).toHaveLength(1);
    expect(scan.confirmed).toBe(500n);
  });

  it("counts an address with only a mempool transaction as used", async () => {
    const first = acct.deriveAddress({ index: 0 }).address;
    const { client } = stub((p) => {
      const addr = decodeURIComponent(p.slice("address/".length).split("?")[0]!);
      return { body: addr === first ? { ...emptySummary(addr), unconfirmedBalance: "5", unconfirmedTxs: 1 } : emptySummary(addr) };
    });
    const scan = await scanAccount(acct, client, { gapLimit: 5 });
    expect(scan.nextReceiveIndex).toBe(1);
    expect(scan.unconfirmed).toBe(5n);
  });
});

describe("history paging", () => {
  it("follows pages up to maxPages and reports whether it saw everything", async () => {
    const { client, calls } = stub((p) => {
      const page = Number(/page=(\d+)/.exec(p)![1]);
      return { body: { page, totalPages: 3, transactions: [{
        txid: `t${page}`, blockHeight: 10 - page, blockTime: 0, confirmations: 1, fees: "0",
        vin: [{ addresses: ["x"], value: "5" }], vout: [{ n: 0, addresses: ["me1"], value: "5" }],
      }] } };
    });
    const summary = { address: "me1", balance: 0n, unconfirmed: 0n, txCount: 3, unconfirmedTxCount: 0 };
    const scan = {
      used: [{ derived: { address: "me1", path: "", index: 0, change: false, pubkey: new Uint8Array() }, summary }],
      nextReceiveIndex: 1, nextChangeIndex: 0, confirmed: 0n, unconfirmed: 0n,
    };
    const two = await accountHistory(scan, client, { maxPages: 2 });
    expect(two.txs.map((t) => t.txid)).toEqual(["t1", "t2"]);
    expect(two.complete).toBe(false);
    const all = await accountHistory(scan, client, { maxPages: 5 });
    expect(all.txs).toHaveLength(3);
    expect(all.complete).toBe(true);
    expect(calls.filter((c) => c.includes("page=4"))).toHaveLength(0);

    // blockHeight 10 - page, time 0 in the stub: give page 2 an old timestamp.
    const { client: c2, calls: calls2 } = stub((p) => {
      const page = Number(/page=(\d+)/.exec(p)![1]);
      return { body: { page, totalPages: 3, transactions: [{
        txid: `u${page}`, blockHeight: 10 - page, blockTime: page === 2 ? 100 : 5_000, confirmations: 1, fees: "0",
        vin: [{ addresses: ["x"], value: "5" }], vout: [{ n: 0, addresses: ["me1"], value: "5" }],
      }] } };
    });
    const week = await accountHistory(scan, c2, { maxPages: 5, stopBefore: 1_000 });
    expect(week.txs.map((t) => t.txid)).toEqual(["u1", "u2"]); // stops after the page that crossed the line
    expect(calls2.some((c) => c.includes("page=3"))).toBe(false);
  });
});

describe("history", () => {
  const tx = (vin: [string, bigint][], vout: [string, bigint][], fee: bigint, height?: number): IndexerTx => ({
    txid: `t${vin.length}${vout.length}${fee}`,
    ...(height ? { height } : {}),
    time: 0,
    confirmations: height ? 1 : 0,
    fee,
    vin: vin.map(([a, value]) => ({ addresses: [a], value, coinbase: false })),
    vout: vout.map(([a, value], n) => ({ n, addresses: [a], value })),
  });
  const own = new Set(["me1", "me2"]);

  it("nets a payment with change into one sent amount including fee", () => {
    const w = toWalletTx(tx([["me1", 5000n]], [["them", 1000n], ["me2", 3900n]], 100n), own);
    expect(w).toMatchObject({ direction: "sent", net: -1100n });
  });

  it("reports incoming payments as received", () => {
    const w = toWalletTx(tx([["them", 5000n]], [["me1", 4900n]], 100n), own);
    expect(w).toMatchObject({ direction: "received", net: 4900n });
  });

  it("recognises a self-transfer as costing only the fee", () => {
    const w = toWalletTx(tx([["me1", 5000n]], [["me2", 4900n]], 100n), own);
    expect(w).toMatchObject({ direction: "self", net: -100n });
  });

  it("merges a tx seen from two of our addresses into one entry", async () => {
    const shared = tx([["me1", 5000n]], [["them", 1000n], ["me2", 3900n]], 100n, 10);
    const { client } = stub(() => ({
      body: { page: 1, totalPages: 1, transactions: [{
        txid: shared.txid, blockHeight: 10, blockTime: 0, confirmations: 1, fees: "100",
        vin: [{ addresses: ["me1"], value: "5000" }],
        vout: [{ n: 0, addresses: ["them"], value: "1000" }, { n: 1, addresses: ["me2"], value: "3900" }],
      }] },
    }));
    const summary = { balance: 0n, unconfirmed: 0n, txCount: 1, unconfirmedTxCount: 0 };
    const derived = (address: string) => ({ address, path: "", index: 0, change: false, pubkey: new Uint8Array() });
    const h = await accountHistory({
      used: [
        { derived: derived("me1"), summary: { ...summary, address: "me1" } },
        { derived: derived("me2"), summary: { ...summary, address: "me2" } },
      ],
      nextReceiveIndex: 1, nextChangeIndex: 1, confirmed: 0n, unconfirmed: 0n,
    }, client);
    expect(h.txs).toHaveLength(1);
    expect(h.txs[0]).toMatchObject({ direction: "sent", net: -1100n });
    expect(h.complete).toBe(true);
  });
});
