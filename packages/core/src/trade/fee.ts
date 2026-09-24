import type { PearlNetwork } from "../network.js";

/**
 * Oyster's trading fee: 1.25% of the PRL traded, charged in PRL.
 *
 * Taken on every buy, every sell, and every auto-sold mining payout, on top
 * of the exchange's own fee. Always rounded down to whole grains, so the
 * rounding never falls on the user.
 *
 * On a sell it is a second output of the wallet's own transaction, which
 * means it is collected on chain, visible in any explorer, and needs nothing
 * from the exchange. On a buy it is held back from the PRL delivered.
 */

export const OYSTER_FEE_BPS = 125n;
const BPS = 10_000n;

/**
 * The fee wallet: one Pearl address used for nothing else.
 *
 * Pinned here and checked by a test, so a typo fails the build rather than
 * sending fees somewhere nobody controls. A network with no address set
 * refuses to charge a fee at all, which is the right failure: no fee is
 * better than a fee sent into the void.
 */
export const FEE_ADDRESS: Record<string, string> = {
  mainnet: "prl1p9uawq7e5hc6l35jc70f5uhz7uw52cjlmlk3n4x8a7eevmgm82rzqal4nm3",
  testnet2: "",
};

export class FeeError extends Error {
  override name = "FeeError";
  constructor(
    message: string,
    readonly code: "no-fee-address" | "not-positive",
  ) {
    super(message);
  }
}

/** 1.25% of an amount in grains, rounded down. */
export function oysterFee(grains: bigint): bigint {
  if (grains <= 0n) throw new FeeError("nothing to charge a fee on", "not-positive");
  return (grains * OYSTER_FEE_BPS) / BPS;
}

/** Is the fee wallet set for this network? */
export function feeAddressFor(net: PearlNetwork): string | undefined {
  const address = FEE_ADDRESS[net.id];
  return address && address.length > 0 ? address : undefined;
}

export interface FeeSplit {
  /** What the trade is for, after the fee. */
  net: bigint;
  /** What Oyster takes. Zero when the fee would be dust. */
  fee: bigint;
  /** Where the fee goes, absent when there is no fee to send. */
  feeAddress?: string;
  /** True when a fee was calculated but skipped for being below dust. */
  dust: boolean;
}

/**
 * Splits an amount into what gets traded and what Oyster takes.
 *
 * A fee below the dust threshold is skipped rather than creating an output
 * nobody can ever spend. Exchange minimums make that theoretical, but a
 * wallet should not be able to build an unspendable output at all.
 */
export function splitFee(grains: bigint, net: PearlNetwork): FeeSplit {
  const fee = oysterFee(grains);
  if (fee < net.dustThreshold) return { net: grains, fee: 0n, dust: fee > 0n };
  const address = feeAddressFor(net);
  if (!address) {
    throw new FeeError(
      "no fee wallet address is set for this network, so the fee cannot be collected",
      "no-fee-address",
    );
  }
  return { net: grains - fee, fee, feeAddress: address, dust: false };
}
