import { hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import type { DerivedAddress } from "../derivation.js";
import { MIN_RELAY_SAT_PER_VB, type IndexerTx } from "../indexer/blockbook.js";
import type { PearlNetwork } from "../network.js";
import { FREEZE_AT_OR_BELOW, type ProtectedUtxo } from "./freeze.js";
import { MAX_FEE_RATE, type SpendPlan } from "./select.js";

/**
 * "Speed up": replace an unconfirmed send with the same payment at a higher
 * fee (BIP-125 replace-by-fee; every Oyster send signals it).
 *
 * Pearl's mempool (node/mempool/mempool.go validateReplacement) accepts the
 * replacement only if its fee rate is strictly higher, its absolute fee covers
 * the old fee plus the relay minimum for its own size, and it adds no new
 * unconfirmed inputs.
 *
 * The recipient's amount never changes. The extra fee comes out of the change
 * output; if change cannot cover it, confirmed coins are added and change is
 * recomputed. Only transactions shaped the way Oyster builds them (all inputs
 * ours, one payment out, at most one change output) are handled.
 */

const TX_OVERHEAD_VB = 10.5;
const INPUT_P2TR_VB = 57.5;
/** p2tr/p2wsh size; p2wpkh is smaller, so this over-estimates safely. */
const OUTPUT_VB = 43;

export class BumpError extends Error {
  override name = "BumpError";
  constructor(
    message: string,
    readonly code: "confirmed" | "not-ours" | "shape" | "change-spent" | "insufficient" | "fee-rate",
  ) {
    super(message);
  }
}

export interface BumpRequest {
  /** The stuck transaction from the indexer, including its raw hex. */
  tx: IndexerTx;
  owned: ReadonlyMap<string, DerivedAddress>;
  /** Confirmed, spendable coins to add if change cannot cover the bump. */
  spendable: readonly ProtectedUtxo[];
  /** New rate in sat/vB, or a function of the current rate (known exactly
   *  only once the raw transaction is parsed). Must beat the current rate. */
  feeRate: number | ((currentRate: number) => number);
  changeAddress: string;
  net: PearlNetwork;
  /** An output of `tx` is already spent by another mempool transaction, so
   *  replacing it would also cancel that one. Refused rather than cascaded. */
  outputsSpent?: boolean;
}

export interface BumpPlan extends SpendPlan {
  replaces: string;
  oldFee: bigint;
  oldFeeRate: number;
}

/** Everything both planners need out of the stuck transaction: its inputs as
 *  spendable coins, who it paid, and what it paid in fees. */
function readStuck(req: BumpRequest) {
  const { tx, owned } = req;
  if (tx.confirmations > 0) throw new BumpError("already confirmed, nothing to replace", "confirmed");
  if (!tx.hex) throw new BumpError("indexer did not return the raw transaction", "shape");
  if (req.outputsSpent) throw new BumpError("its change has already been spent by a newer send", "change-spent");
  const raw = Transaction.fromRaw(hex.decode(tx.hex), { allowUnknownOutputs: true });
  const inputs: ProtectedUtxo[] = [];
  for (let i = 0; i < raw.inputsLength; i++) {
    const inp = raw.getInput(i);
    const address = tx.vin[i]?.addresses[0];
    if (!address || !owned.has(address) || inp.txid === undefined || inp.index === undefined) {
      throw new BumpError("it spends coins this wallet does not control", "not-ours");
    }
    inputs.push({
      txid: hex.encode(inp.txid), vout: inp.index, address, value: tx.vin[i]!.value,
      confirmations: 1, coinbase: false, immature: false, frozen: false,
    });
  }
  const outs = tx.vout.map((o) => ({ address: o.addresses[0], value: o.value }));
  const external = outs.filter((o) => !o.address || !owned.has(o.address));
  const ours = outs.filter((o) => o.address !== undefined && owned.has(o.address));
  if (external.length !== 1 || !external[0]!.address || ours.length > 1) {
    throw new BumpError("only sends made by Oyster can be replaced", "shape");
  }
  const total = inputs.reduce((s, u) => s + u.value, 0n);
  const oldFee = total - outs.reduce((s, o) => s + o.value, 0n);
  return {
    inputs, total, oldFee,
    oldFeeRate: Number(oldFee) / raw.vsize,
    to: external[0]!.address!,
    amount: external[0]!.value,
    changeAddress: ours[0]?.address ?? req.changeAddress,
  };
}

/** The replacement rate, checked against both the node's rules and ours. */
function replacementRate(req: BumpRequest, oldFeeRate: number): number {
  const feeRate = typeof req.feeRate === "function" ? req.feeRate(oldFeeRate) : req.feeRate;
  if (!(feeRate >= MIN_RELAY_SAT_PER_VB) || feeRate > MAX_FEE_RATE) {
    throw new BumpError(`fee rate ${feeRate} sat/vB out of range`, "fee-rate");
  }
  if (feeRate <= oldFeeRate) {
    throw new BumpError(`the new rate must be above the current ${oldFeeRate.toFixed(2)} sat/vB`, "fee-rate");
  }
  return feeRate;
}

/**
 * "Cancel": replace an unconfirmed send with one that pays everything back to
 * an address of your own, at a higher fee, so the original can never confirm.
 *
 * The same BIP-125 rules apply as for a speed-up, and the same shape limits.
 * It is not a guarantee: if the original is already mined, or a miner has it
 * and will not take the replacement, the payment stands. Nothing a wallet
 * does can undo a confirmed transaction.
 */
export function planCancel(req: BumpRequest): BumpPlan {
  const { inputs, total, oldFee, oldFeeRate, changeAddress } = readStuck(req);
  const feeRate = replacementRate(req, oldFeeRate);
  const vsize = Math.ceil(TX_OVERHEAD_VB + INPUT_P2TR_VB * inputs.length + OUTPUT_VB);
  const byRate = BigInt(Math.ceil(vsize * feeRate));
  const byRule = oldFee + BigInt(Math.ceil(vsize * MIN_RELAY_SAT_PER_VB));
  const fee = byRate > byRule ? byRate : byRule;
  const back = total - fee;
  if (back < req.net.dustThreshold) {
    throw new BumpError("what is left after the higher fee would be dust", "insufficient");
  }
  return {
    inputs,
    to: changeAddress,
    amount: back,
    fee,
    vsize,
    excluded: { frozen: 0, immature: 0, unconfirmed: 0 },
    replaces: req.tx.txid,
    oldFee,
    oldFeeRate,
  };
}

export function planBump(req: BumpRequest): BumpPlan {
  const { tx, owned, net } = req;
  if (tx.confirmations > 0) throw new BumpError("already confirmed, nothing to speed up", "confirmed");
  if (!tx.hex) throw new BumpError("indexer did not return the raw transaction", "shape");
  if (req.outputsSpent) throw new BumpError("its change has already been spent by a newer send", "change-spent");
  // Inputs come from the raw transaction (the indexer omits vout when it is 0);
  // value and address from the indexer's view of each input.
  const raw = Transaction.fromRaw(hex.decode(tx.hex), { allowUnknownOutputs: true });
  const inputs: ProtectedUtxo[] = [];
  for (let i = 0; i < raw.inputsLength; i++) {
    const inp = raw.getInput(i);
    const address = tx.vin[i]?.addresses[0];
    if (!address || !owned.has(address) || inp.txid === undefined || inp.index === undefined) {
      throw new BumpError("it spends coins this wallet does not control", "not-ours");
    }
    inputs.push({
      txid: hex.encode(inp.txid),
      vout: inp.index,
      address,
      value: tx.vin[i]!.value,
      confirmations: 1,
      coinbase: false,
      immature: false,
      frozen: false,
    });
  }

  const outs = tx.vout.map((o) => ({ address: o.addresses[0], value: o.value }));
  const external = outs.filter((o) => !o.address || !owned.has(o.address));
  const ours = outs.filter((o) => o.address !== undefined && owned.has(o.address));
  if (external.length !== 1 || !external[0]!.address || ours.length > 1) {
    throw new BumpError("only sends made by Oyster can be sped up", "shape");
  }
  const to = external[0]!.address;
  const amount = external[0]!.value;
  const changeAddress = ours[0]?.address ?? req.changeAddress;

  let total = inputs.reduce((s, u) => s + u.value, 0n);
  const oldFee = total - outs.reduce((s, o) => s + o.value, 0n);
  const oldFeeRate = Number(oldFee) / raw.vsize;
  const feeRate = typeof req.feeRate === "function" ? req.feeRate(oldFeeRate) : req.feeRate;
  if (!(feeRate >= MIN_RELAY_SAT_PER_VB) || feeRate > MAX_FEE_RATE) {
    throw new BumpError(`fee rate ${feeRate} sat/vB out of range`, "fee-rate");
  }
  if (feeRate <= oldFeeRate) {
    throw new BumpError(`the new rate must be above the current ${oldFeeRate.toFixed(2)} sat/vB`, "fee-rate");
  }

  const minChange = FREEZE_AT_OR_BELOW + 1n > net.dustThreshold ? FREEZE_AT_OR_BELOW + 1n : net.dustThreshold;
  const vsizeFor = (nIn: number, withChange: boolean) =>
    Math.ceil(TX_OVERHEAD_VB + INPUT_P2TR_VB * nIn + OUTPUT_VB * (withChange ? 2 : 1));
  // Both node rules at once: the new rate, and old fee + relay minimum.
  const feeFor = (vsize: number) => {
    const byRate = BigInt(Math.ceil(vsize * feeRate));
    const byRule = oldFee + BigInt(Math.ceil(vsize * MIN_RELAY_SAT_PER_VB));
    return byRate > byRule ? byRate : byRule;
  };

  const extra = req.spendable
    .filter((u) => !u.frozen && !u.immature && u.confirmations > 0)
    .filter((u) => !inputs.some((i) => i.txid === u.txid && i.vout === u.vout))
    .sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));

  const base = { to, amount, excluded: { frozen: 0, immature: 0, unconfirmed: 0 }, replaces: tx.txid, oldFee, oldFeeRate };
  for (let added = 0; ; added++) {
    if (added > 0) {
      const u = extra[added - 1];
      if (!u) throw new BumpError("not enough spendable PRL to pay the higher fee", "insufficient");
      inputs.push(u);
      total += u.value;
    }
    const vsizeChange = vsizeFor(inputs.length, true);
    const feeChange = feeFor(vsizeChange);
    const change = total - amount - feeChange;
    if (change >= minChange) {
      return { ...base, inputs, change: { address: changeAddress, value: change }, fee: feeChange, vsize: vsizeChange };
    }
    const vsizeNo = vsizeFor(inputs.length, false);
    if (total - amount >= feeFor(vsizeNo)) {
      // Leftover under the change minimum goes to the fee, as in a normal send.
      return { ...base, inputs, fee: total - amount, vsize: vsizeNo };
    }
  }
}
