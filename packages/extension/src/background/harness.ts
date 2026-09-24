import { describeRawTx, PEARL_MAINNET, type Platform } from "@pearl-wallet/core";

/**
 * A wallet service with nothing real behind it.
 *
 * Everything the service talks to is here: storage, the clock, randomness,
 * and the indexer. That last one is the reason this file exists. The money
 * paths all run through `load`, which scans addresses, reads coins and asks
 * what a fee costs, and none of them can be exercised without something on
 * the other end of that.
 *
 * Built after a day in which four money bugs were found in production and
 * none of them by a test, because the file they were in had no way to be
 * tested at all.
 *
 * The indexer is a function from URL to body rather than a mock library:
 * the service does not care how the answer was produced, and a table of
 * URLs reads like the thing it stands in for.
 */

export interface Chain {
  /** Height the indexer reports, which decides confirmations. */
  height: number;
  /** Balance and coins per address. Anything absent is an empty address. */
  addresses: Record<string, { balance: bigint; utxos: { txid: string; vout: number; value: bigint; confirmations: number }[] }>;
  /** Transactions the indexer knows, by txid, as Blockbook returns them. */
  txs: Record<string, unknown>;
  /** Satoshis per byte, for every speed. */
  feeRate: number;
  /** Everything broadcast, newest last, as raw hex. */
  sent: string[];
  /** Made to fail, for the tests that need a broadcast to be refused. */
  refuseBroadcast?: string;
}

export function emptyChain(): Chain {
  return { height: 100_000, addresses: {}, txs: {}, feeRate: 2, sent: [] };
}

/** An in-memory key-value store, which is all the vault needs. */
function store() {
  const map = new Map<string, string>();
  return {
    get: async (k: string) => map.get(k) ?? null,
    set: async (k: string, v: string) => void map.set(k, v),
    delete: async (k: string) => void map.delete(k),
    entries: async () => Object.fromEntries(map),
  };
}

/** What `FetchLike` returns, as much of it as the service reads. */
function reply(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/**
 * The indexer, answering from `chain`.
 *
 * Any address it has not been told about is an empty one. That is not
 * laziness: a scan walks addresses until it finds a run of empty ones, so
 * most of what it asks for must come back empty or it never stops.
 */
function indexer(chain: Chain) {
  return async (url: string, init?: { method?: string; body?: unknown }) => {
    const path = url.split("/api/v2/")[1] ?? "";

    if (path === "") return reply({ blockbook: { bestHeight: chain.height, inSync: true } });

    if (path.startsWith("address/")) {
      const address = decodeURIComponent(path.slice("address/".length).split("?")[0]!);
      const known = chain.addresses[address];
      return reply({
        address,
        balance: (known?.balance ?? 0n).toString(),
        unconfirmedBalance: "0",
        txs: known ? 1 : 0,
        unconfirmedTxs: 0,
      });
    }

    if (path.startsWith("utxo/")) {
      const address = decodeURIComponent(path.slice("utxo/".length));
      const known = chain.addresses[address];
      return reply(
        (known?.utxos ?? []).map((u) => ({
          txid: u.txid,
          vout: u.vout,
          value: u.value.toString(),
          height: u.confirmations > 0 ? chain.height - u.confirmations + 1 : 0,
          confirmations: u.confirmations,
        })),
      );
    }

    if (path.startsWith("tx/")) {
      const txid = decodeURIComponent(path.slice("tx/".length));
      const tx = chain.txs[txid];
      return tx ? reply(tx) : reply({ error: "not found" }, 404);
    }

    if (path.startsWith("estimatefee/")) return reply({ result: (chain.feeRate / 1e5).toFixed(8) });

    if (path.startsWith("sendtx")) {
      const raw = String(init?.body ?? "");
      if (chain.refuseBroadcast) return reply({ error: chain.refuseBroadcast });
      chain.sent.push(raw);
      /**
       * The txid the node would report, worked out from the bytes.
       *
       * The service checks what it broadcast against what it signed and
       * refuses a mismatch, which is the right check and means a stub
       * cannot simply invent one. Deriving it from the transaction is
       * both honest and what a node does.
       */
      return reply({ result: describeRawTx(raw, PEARL_MAINNET).txid });
    }

    throw new Error(`the test indexer was asked for ${path}, which it does not know`);
  };
}

/**
 * A platform, and the relay's answers alongside it.
 *
 * `relay` is a separate table because the relay is a different service
 * with a different shape, and mixing its URLs in with the indexer's made
 * both harder to read.
 */
export function fakePlatform(chain: Chain, relay: Record<string, unknown> = {}) {
  const asIndexer = indexer(chain);
  const calls: { url: string; body?: unknown }[] = [];

  const platform: Platform = {
    storage: store(),
    session: store(),
    random: { bytes: (n: number) => new Uint8Array(n).fill(7) },
    clock: { now: () => 1_700_000_000_000 },
    fetch: (async (url: string, init?: { method?: string; body?: unknown }) => {
      calls.push({ url, ...(init?.body !== undefined ? { body: init.body } : {}) });
      if (url.includes("/api/v2/")) return asIndexer(url, init);

      // The relay. Matched on the path so a test names `/v1/me` rather
      // than repeating whatever host the service was pointed at.
      const path = new URL(url).pathname;
      if (path in relay) return reply(relay[path]);
      return reply({ error: `the test relay was asked for ${path}` }, 404);
    }) as Platform["fetch"],
  };

  return { platform, chain, calls };
}
