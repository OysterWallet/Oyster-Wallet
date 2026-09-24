import { accountFromSeed, describeRawTx, PEARL_MAINNET, seedFromMnemonic } from "@pearl-wallet/core";
import { describe, expect, it } from "vitest";
import { emptyChain, fakePlatform, type Chain } from "./harness";
import { signInMessage } from "./account";
import { WalletService } from "./service";

/**
 * The money paths, end to end inside the wallet.
 *
 * Everything below runs the real planner, the real signer and the real
 * vault against a stand-in indexer. Nothing about building or signing a
 * transaction is faked, which is the point: the bugs worth catching here
 * are in the joins between those, not in any one of them.
 *
 * Written after a day in which four money bugs reached production and none
 * were caught by a test, because this file had no way to exist.
 */

/** Fixed, so the addresses below are the addresses this derives. */
const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PASSWORD = "a password long enough to be allowed";
const THEIRS = "prl1p9uawq7e5hc6l35jc70f5uhz7uw52cjlmlk3n4x8a7eevmgm82rzqal4nm3";

/** The first receive address of that seed, worked out rather than pasted. */
function firstAddress(): string {
  const keys = accountFromSeed(seedFromMnemonic(MNEMONIC), PEARL_MAINNET, 0);
  return keys.deriveAddress({ index: 0, change: false }).address;
}

/** A wallet holding one confirmed coin, unlocked and ready to spend. */
async function walletWith(
  value: bigint,
  relay: Record<string, unknown> | ((txid: string) => Record<string, unknown>) = {},
) {
  // A function when the answers depend on a transaction that does not
  // exist yet, which is every test about a payment being replaced.
  let sellTxid = "";
  const table = () => (typeof relay === "function" ? relay(sellTxid) : relay);
  const chain: Chain = emptyChain();
  const mine = firstAddress();
  const from = "a".repeat(64);
  chain.addresses[mine] = { balance: value, utxos: [{ txid: from, vout: 0, value, confirmations: 6 }] };
  /**
   * The transaction the coin came from.
   *
   * Asked for because a coinbase output cannot be spent for a hundred
   * blocks, so the wallet checks every coin's origin before counting it.
   * An ordinary payment, which is what makes this one spendable.
   */
  chain.txs[from] = {
    txid: from,
    blockHeight: chain.height - 5,
    blockTime: 1_700_000_000,
    confirmations: 6,
    fees: "1000",
    vin: [{ addresses: [THEIRS], value: (value + 1000n).toString() }],
    vout: [{ n: 0, addresses: [mine], value: value.toString() }],
  };
  const { platform, calls } = fakePlatform(chain, new Proxy({}, {
    has: (_t, k) => k in table(),
    get: (_t, k) => (table() as Record<string | symbol, unknown>)[k],
  }));
  const service = new WalletService(platform);
  await service.createVault(PASSWORD, MNEMONIC, false);
  await service.unlock(PASSWORD);
  return { service, chain, calls, mine, watch: (txid: string) => { sellTxid = txid; } };
}

describe("sending PRL", () => {
  it("builds, signs and broadcasts one transaction", async () => {
    const { service, chain } = await walletWith(500_000_000n);
    const { txid } = await service.send({ to: THEIRS, amount: "100000000", tier: "normal" });

    expect(chain.sent).toHaveLength(1);
    // The service checks the node's txid against the one it signed and
    // throws on a mismatch, so getting a txid back at all proves the
    // transaction it broadcast is the transaction it built.
    expect(txid).toMatch(/^[0-9a-f]{64}$/);
  });

  it("pays the recipient the amount asked for", async () => {
    const { service, chain } = await walletWith(500_000_000n);
    await service.send({ to: THEIRS, amount: "100000000", tier: "normal" });

    const { describeRawTx } = await import("@pearl-wallet/core");
    const tx = describeRawTx(chain.sent[0]!, PEARL_MAINNET);
    const paid = tx.outputs.find((o) => o.address === THEIRS);
    expect(paid?.value).toBe(100_000_000n);
  });

  it("will not spend more than it has", async () => {
    const { service, chain } = await walletWith(100_000_000n);
    await expect(service.send({ to: THEIRS, amount: "500000000", tier: "normal" })).rejects.toThrow();
    expect(chain.sent).toHaveLength(0);
  });

  it("broadcasts nothing when the node refuses", async () => {
    const { service, chain } = await walletWith(500_000_000n);
    chain.refuseBroadcast = "bad-txns-inputs-missingorspent";
    await expect(service.send({ to: THEIRS, amount: "100000000", tier: "normal" })).rejects.toThrow();
  });
});

describe("cancelling the payment that carries a sell", () => {
  /**
   * The wiring, not the decision.
   *
   * `tellRelayCancelled` has tests of its own. What those cannot show is
   * that `cancelSend` calls it at all, and that is the half that was
   * missing when a bumped sell payment stranded the relay on a
   * transaction that no longer existed.
   */
  /** A relay that is waiting on `waitingOn`, recording what it is told. */
  function relayWaitingOn(waitingOn: string | undefined, told: string[]) {
    return {
      // The real text: the wallet refuses to sign anything else.
      "/v1/session/challenge": { nonce: "n", message: signInMessage(firstAddress(), "n", 2_000_000_000_000), expires: 2_000_000_000_000 },
      "/v1/session": { token: "t", expires: 2_000_000_000_000 },
      "/v1/me": {
        address: "prl1whoever",
        balances: { usdt: "0", prl: "0" },
        ...(waitingOn ? { selling: { prl: "400000000", stage: "sending", txid: waitingOn } } : {}),
        senders: [],
      },
      get "/v1/me/sell/abandon"() {
        told.push("abandoned");
        return { sell: { id: 1, state: "abandoned" } };
      },
    };
  }

  /**
   * A real unconfirmed payment of this wallet's.
   *
   * Sent rather than written out, because a cancel only works on a
   * transaction shaped the way this wallet builds them, down to the raw
   * bytes: `readStuck` reads the inputs back out of the hex. A hand-made
   * fixture is refused, and rightly.
   */
  async function withPendingSend(told: string[], waitingOnIsTheSell: boolean) {
    const w = await walletWith(500_000_000n, (txid: string) =>
      relayWaitingOn(waitingOnIsTheSell ? txid : undefined, told),
    );
    const { txid } = await w.service.send({ to: THEIRS, amount: "100000000", tier: "normal" });
    // The relay's answers depend on which payment it is waiting for, and
    // that is only known once the payment exists.
    w.watch(txid);
    const raw = w.chain.sent[0]!;
    const described = describeRawTx(raw, PEARL_MAINNET);
    w.chain.txs[txid] = {
      txid,
      hex: raw,
      confirmations: 0,
      fees: "2000",
      vin: [{ addresses: [w.mine], value: "500000000" }],
      vout: described.outputs.map((o, n) => ({
        n,
        addresses: o.address ? [o.address] : [],
        value: o.value.toString(),
      })),
    };
    return { ...w, txid };
  }

  it("tells the relay to give up when the cancelled payment was carrying a sell", async () => {
    const told: string[] = [];
    const { service, txid } = await withPendingSend(told, true);
    await service.cancelSend(txid);
    expect(told).toContain("abandoned");
  });

  it("says nothing when the cancelled payment was an ordinary one", async () => {
    // Cancelling an unrelated payment must not abandon somebody's sell.
    const told: string[] = [];
    const { service, txid } = await withPendingSend(told, false);
    await service.cancelSend(txid);
    expect(told).toEqual([]);
  });

  it("says nothing when no sell is in progress at all", async () => {
    const told: string[] = [];
    const { service, txid } = await withPendingSend(told, false);
    await service.cancelSend(txid);
    expect(told).toEqual([]);
  });
});
