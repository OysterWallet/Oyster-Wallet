/**
 * Telling the relay when the payment carrying a sell changes.
 *
 * A sell is two halves that can drift apart. The relay records which
 * transaction is bringing the PRL, and the wallet can then replace that
 * transaction: a fee bump makes a new one and evicts the old, and a cancel
 * pays this wallet instead so the PRL never arrives at all.
 *
 * Neither used to be reported. On 2026-09-23 a bump left the relay waiting
 * on a transaction the chain had never heard of, the PRL arrived under an
 * id it did not recognise from a change address nobody had declared, the
 * deposit landed belonging to nobody, and the sell was never placed. It
 * took a hand-written command to unstick.
 *
 * Kept apart from the service so it can be tested. The service half needs
 * an unlocked vault and real keys; this half is the decision, which is the
 * part that was wrong.
 */

/** What these need from the relay, and nothing more. */
export interface SellWatcher {
  /** The account as the relay sees it, including any sell in progress. */
  me(): Promise<{ selling?: { txid?: string } }>;
  /** Names the payment now bringing the PRL. */
  sellSent(txid: string): Promise<void>;
  /** Gives up on the waiting sell entirely. */
  abandonSell(): Promise<void>;
}

/**
 * What happened, for a caller that wants to know and a test that must.
 *
 * "not-ours" is the ordinary case: most payments have nothing to do with a
 * sell, and saying nothing about them is correct rather than a failure.
 */
export type Told = "told" | "not-ours" | "unreachable";

/**
 * Reports that `oldTxid` has been replaced by `newTxid`.
 *
 * Only when the relay is actually waiting on the one being replaced, so an
 * ordinary bump of an ordinary payment says nothing.
 */
export async function tellRelayReplaced(
  watcher: SellWatcher | undefined,
  oldTxid: string,
  newTxid: string,
): Promise<Told> {
  if (!watcher) return "unreachable";
  try {
    const account = await watcher.me();
    if (account.selling?.txid !== oldTxid) return "not-ours";
    await watcher.sellSent(newTxid);
    return "told";
  } catch {
    // Never fatal. The bump has already happened and succeeded by the time
    // this runs, and failing here must not turn a completed send into an
    // error on screen. The cost is the same manual fix as before.
    return "unreachable";
  }
}

/**
 * Reports that the payment carrying a sell has been cancelled.
 *
 * A cancel pays this wallet instead, so the PRL never reaches the exchange.
 * Left unsaid the relay waits for it for ever, and because only one sell
 * may wait at a time, that locks this wallet out of selling until somebody
 * clears it by hand.
 */
export async function tellRelayCancelled(watcher: SellWatcher | undefined, oldTxid: string): Promise<Told> {
  if (!watcher) return "unreachable";
  try {
    const account = await watcher.me();
    if (account.selling?.txid !== oldTxid) return "not-ours";
    await watcher.abandonSell();
    return "told";
  } catch {
    return "unreachable";
  }
}
