import type { Utxo } from "../indexer/blockbook.js";

/**
 * PRC-20 protection, option A from PLAN.md: freeze small outputs by default.
 *
 * Inscriptions ride on ordinary taproot outputs, and output value does not
 * reveal whether one is attached. What value does reveal is intent: nobody
 * pays themselves 0.00000546 PRL by accident. So every output at or below
 * FREEZE_AT_OR_BELOW is kept out of automatic coin selection until the user
 * unfreezes that specific outpoint on the Protected coins screen.
 *
 * The threshold is deliberately generous. At the ~0.82 USDT/PRL shown in the
 * design, 0.001 PRL is under a tenth of a cent, so a false positive costs a
 * user nothing noticeable, while a false negative destroys a token for good.
 */

/** 0.001 PRL. Outputs at or below this are frozen by default. */
export const FREEZE_AT_OR_BELOW = 100_000n;

/** Values commonly used as inscription postage (ord's default, the dust
 *  limits for taproot and P2PKH, and a common round number). Outputs of
 *  exactly these values get the stronger "inscription" label. */
export const POSTAGE_VALUES: ReadonlySet<bigint> = new Set([330n, 546n, 600n, 1_000n, 10_000n]);

export type FreezeReason = "inscription" | "small-output";

export function outpoint(u: Pick<Utxo, "txid" | "vout">): string {
  return `${u.txid}:${u.vout}`;
}

export function freezeReason(u: Pick<Utxo, "value" | "coinbase">): FreezeReason | undefined {
  // Coinbase outputs are created by the block itself, never by a reveal tx.
  if (u.coinbase || u.value > FREEZE_AT_OR_BELOW) return undefined;
  return POSTAGE_VALUES.has(u.value) ? "inscription" : "small-output";
}

export interface ProtectedUtxo extends Utxo {
  frozen: boolean;
  freezeReason?: FreezeReason;
}

/** Marks each output frozen unless the user explicitly unfroze it. */
export function applyFreezePolicy(
  utxos: readonly Utxo[],
  unfrozen: ReadonlySet<string>,
): ProtectedUtxo[] {
  return utxos.map((u) => {
    const reason = freezeReason(u);
    return {
      ...u,
      frozen: reason !== undefined && !unfrozen.has(outpoint(u)),
      ...(reason ? { freezeReason: reason } : {}),
    };
  });
}
