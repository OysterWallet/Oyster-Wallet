import { describe, expect, it } from "vitest";
import { tellRelayCancelled, tellRelayReplaced, type SellWatcher } from "./relay-notify";

const OLD = "67e3243c43e065531f3d1c0b99fa3df9baa41e0c7404c7303c0c2aa1ebe212a5";
const NEW = "340cdcafbea12494ef7642981444d302035b24df56359c7efa0cf07653547916";

/** A relay that is waiting on `waitingOn`, and records what it was told. */
function watcher(waitingOn?: string) {
  const told: { sellSent: string[]; abandoned: number } = { sellSent: [], abandoned: 0 };
  const w: SellWatcher = {
    me: async () => (waitingOn ? { selling: { txid: waitingOn } } : {}),
    sellSent: async (txid) => {
      told.sellSent.push(txid);
    },
    abandonSell: async () => {
      told.abandoned++;
    },
  };
  return { w, told };
}

/** One that cannot be reached at all. */
const broken: SellWatcher = {
  me: async () => {
    throw new Error("the relay is not answering");
  },
  sellSent: async () => {
    throw new Error("unreachable");
  },
  abandonSell: async () => {
    throw new Error("unreachable");
  },
};

describe("a bump that replaces a sell's payment", () => {
  it("tells the relay which payment is bringing the PRL now", async () => {
    /**
     * The bug this exists for. A bump makes a new transaction and evicts
     * the old one, so a relay still waiting on the original waits for
     * something the chain has never heard of: the PRL arrives under an id
     * it does not recognise, from a change address nobody declared, and
     * the deposit lands belonging to nobody.
     */
    const { w, told } = watcher(OLD);
    expect(await tellRelayReplaced(w, OLD, NEW)).toBe("told");
    expect(told.sellSent).toEqual([NEW]);
  });

  it("says nothing about an ordinary payment", async () => {
    // Most bumps have nothing to do with a sell. Reporting them would ask
    // the relay to point a sell at a payment that is not paying for it.
    const { w, told } = watcher("some-other-payment");
    expect(await tellRelayReplaced(w, OLD, NEW)).toBe("not-ours");
    expect(told.sellSent).toEqual([]);
  });

  it("says nothing when no sell is in progress", async () => {
    const { w, told } = watcher(undefined);
    expect(await tellRelayReplaced(w, OLD, NEW)).toBe("not-ours");
    expect(told.sellSent).toEqual([]);
  });

  it("never throws when the relay cannot be reached", async () => {
    // The bump has already succeeded by the time this runs. Failing here
    // must not turn a completed send into an error on screen.
    await expect(tellRelayReplaced(broken, OLD, NEW)).resolves.toBe("unreachable");
  });

  it("never throws when there is no session at all", async () => {
    await expect(tellRelayReplaced(undefined, OLD, NEW)).resolves.toBe("unreachable");
  });
});

describe("a cancel that kills a sell's payment", () => {
  it("gives up on the sell", async () => {
    /**
     * A cancel pays this wallet instead, so the PRL never reaches the
     * exchange. Left unsaid the relay waits for it for ever, and because
     * only one sell may wait at a time, that locks this wallet out of
     * selling until somebody clears it by hand.
     */
    const { w, told } = watcher(OLD);
    expect(await tellRelayCancelled(w, OLD)).toBe("told");
    expect(told.abandoned).toBe(1);
  });

  it("does not give up on a sell it was not carrying", async () => {
    // Cancelling an unrelated payment must not abandon somebody's sell.
    const { w, told } = watcher("some-other-payment");
    expect(await tellRelayCancelled(w, OLD)).toBe("not-ours");
    expect(told.abandoned).toBe(0);
  });

  it("does nothing when no sell is waiting", async () => {
    const { w, told } = watcher(undefined);
    expect(await tellRelayCancelled(w, OLD)).toBe("not-ours");
    expect(told.abandoned).toBe(0);
  });

  it("never throws when the relay cannot be reached", async () => {
    await expect(tellRelayCancelled(broken, OLD)).resolves.toBe("unreachable");
  });

  it("never throws when there is no session at all", async () => {
    await expect(tellRelayCancelled(undefined, OLD)).resolves.toBe("unreachable");
  });

  it("does not send the sell to the relay as a replacement", async () => {
    // The two are not interchangeable. A cancel means the PRL is never
    // coming, so pointing the sell at the cancelling transaction would
    // leave it waiting on a payment to this wallet.
    const { w, told } = watcher(OLD);
    await tellRelayCancelled(w, OLD);
    expect(told.sellSent).toEqual([]);
  });
});
