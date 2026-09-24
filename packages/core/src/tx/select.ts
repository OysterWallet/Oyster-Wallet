import { decodeAddress, type AddressType } from "../address.js";
import { MIN_RELAY_SAT_PER_VB } from "../indexer/blockbook.js";
import type { PearlNetwork } from "../network.js";
import { FREEZE_AT_OR_BELOW, type ProtectedUtxo } from "./freeze.js";

/**
 * Coin selection: largest-first, one recipient, optional change.
 *
 * Spendable means mature, not frozen, and either confirmed or our own
 * unconfirmed change (`trusted`). Unconfirmed coins from anyone else are left
 * alone: the sender could still replace them.
 *
 * Change is only created when it clears FREEZE_AT_OR_BELOW. Smaller change
 * would be frozen as a suspected inscription the moment it confirmed, so it is
 * added to the fee instead. That costs at most 0.001 PRL.
 */

// Virtual sizes in vB. Taproot key-path input: 41 bytes base + 66 bytes
// witness (count, length, 64-byte Schnorr sig) / 4.
const TX_OVERHEAD_VB = 10.5;
const INPUT_P2TR_VB = 57.5;
const OUTPUT_VB: Record<AddressType, number> = { p2tr: 43, p2wsh: 43, p2wpkh: 31 };

/** A fee rate above this is a bug or a fat finger, not a fee market. */
export const MAX_FEE_RATE = 5_000;

export interface SpendRequest {
  utxos: readonly ProtectedUtxo[];
  to: string;
  /** Grains to deliver. Omit with `max: true` to send everything spendable. */
  amount?: bigint;
  max?: boolean;
  /** sat/vB, fractional allowed. */
  feeRate: number;
  changeAddress: string;
  net: PearlNetwork;
  /** Coin control: spend exactly these outpoints ("txid:vout") and no
   *  others. They still have to be spendable; a frozen coin is unfrozen in
   *  Settings, not quietly spent here. */
  only?: readonly string[];
}

export interface SpendPlan {
  inputs: ProtectedUtxo[];
  to: string;
  amount: bigint;
  change?: { address: string; value: bigint };
  fee: bigint;
  vsize: number;
  /** Outputs left out, for the review screen ("2 protected outputs were left out"). */
  excluded: { frozen: number; immature: number; unconfirmed: number };
}

export class SpendError extends Error {
  override name = "SpendError";
  constructor(
    message: string,
    readonly code: "insufficient" | "dust" | "fee-rate" | "no-spendable",
    readonly detail: { spendable: bigint; frozen: bigint; immature: bigint; unconfirmed: bigint },
  ) {
    super(message);
  }
}

export function planSpend(req: SpendRequest): SpendPlan {
  if (!(req.feeRate >= MIN_RELAY_SAT_PER_VB) || req.feeRate > MAX_FEE_RATE) {
    throw new SpendError(`fee rate ${req.feeRate} sat/vB out of range`, "fee-rate", zero());
  }
  const toType = decodeAddress(req.to, req.net).type;
  const changeType = decodeAddress(req.changeAddress, req.net).type;

  const spendable: ProtectedUtxo[] = [];
  const detail = zero();
  const excluded = { frozen: 0, immature: 0, unconfirmed: 0 };
  for (const u of req.utxos) {
    if (u.frozen) {
      excluded.frozen++;
      detail.frozen += u.value;
    } else if (u.immature) {
      excluded.immature++;
      detail.immature += u.value;
    } else if (u.confirmations < 1 && !u.trusted) {
      excluded.unconfirmed++;
      detail.unconfirmed += u.value;
    } else {
      spendable.push(u);
      detail.spendable += u.value;
    }
  }
  if (spendable.length === 0) throw new SpendError("nothing spendable", "no-spendable", detail);
  spendable.sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));

  // A chosen set is used whole: the point of picking coins is that these are
  // the ones that move, so there is no room for the wallet to add or drop one.
  let chosen: ProtectedUtxo[] | undefined;
  if (req.only && req.only.length > 0) {
    const want = new Set(req.only);
    chosen = spendable.filter((u) => want.has(`${u.txid}:${u.vout}`));
    if (chosen.length !== want.size) {
      throw new SpendError("some chosen coins cannot be spent right now", "no-spendable", detail);
    }
  }

  const vsizeFor = (inputs: number, withChange: boolean) =>
    Math.ceil(
      TX_OVERHEAD_VB + INPUT_P2TR_VB * inputs + OUTPUT_VB[toType] + (withChange ? OUTPUT_VB[changeType] : 0),
    );
  const feeFor = (vsize: number) => BigInt(Math.ceil(vsize * req.feeRate));

  if (req.max) {
    const coins = chosen ?? spendable;
    const vsize = vsizeFor(coins.length, false);
    const fee = feeFor(vsize);
    const amount = coins.reduce((t, u) => t + u.value, 0n) - fee;
    if (amount < req.net.dustThreshold) {
      throw new SpendError("balance does not cover the network fee", "insufficient", detail);
    }
    return { inputs: coins, to: req.to, amount, fee, vsize, excluded };
  }

  const amount = req.amount ?? 0n;
  if (amount < req.net.dustThreshold) {
    throw new SpendError(`amount below the ${req.net.dustThreshold}-grain dust limit`, "dust", detail);
  }

  if (chosen) {
    const total = chosen.reduce((t, u) => t + u.value, 0n);
    const vsizeChange = vsizeFor(chosen.length, true);
    const feeChange = feeFor(vsizeChange);
    const change = total - amount - feeChange;
    const minChange = FREEZE_AT_OR_BELOW + 1n > req.net.dustThreshold ? FREEZE_AT_OR_BELOW + 1n : req.net.dustThreshold;
    if (change >= minChange) {
      return { inputs: chosen, to: req.to, amount, change: { address: req.changeAddress, value: change }, fee: feeChange, vsize: vsizeChange, excluded };
    }
    const vsizeNoChange = vsizeFor(chosen.length, false);
    if (total - amount >= feeFor(vsizeNoChange)) {
      return { inputs: chosen, to: req.to, amount, fee: total - amount, vsize: vsizeNoChange, excluded };
    }
    throw new SpendError("the chosen coins do not cover the amount and fee", "insufficient", detail);
  }

  const inputs: ProtectedUtxo[] = [];
  let total = 0n;
  for (const u of spendable) {
    inputs.push(u);
    total += u.value;

    const vsizeNoChange = vsizeFor(inputs.length, false);
    const feeNoChange = feeFor(vsizeNoChange);
    if (total < amount + feeNoChange) continue;

    const vsizeChange = vsizeFor(inputs.length, true);
    const feeChange = feeFor(vsizeChange);
    const change = total - amount - feeChange;
    const minChange = FREEZE_AT_OR_BELOW + 1n > req.net.dustThreshold ? FREEZE_AT_OR_BELOW + 1n : req.net.dustThreshold;
    if (change >= minChange) {
      return {
        inputs, to: req.to, amount,
        change: { address: req.changeAddress, value: change },
        fee: feeChange, vsize: vsizeChange, excluded,
      };
    }
    // Leftover too small to keep as change: it becomes fee.
    return { inputs, to: req.to, amount, fee: total - amount, vsize: vsizeNoChange, excluded };
  }

  throw new SpendError("insufficient spendable balance", "insufficient", detail);
}

function zero() {
  return { spendable: 0n, frozen: 0n, immature: 0n, unconfirmed: 0n };
}
