import { describe, expect, it } from "vitest";
import { decodeAddress } from "../src/address.js";
import { PEARL_MAINNET, PEARL_TESTNET2 } from "../src/network.js";
import { FEE_ADDRESS, FeeError, OYSTER_FEE_BPS, feeAddressFor, oysterFee, splitFee } from "../src/trade/fee.js";

const PRL = 100_000_000n;

/** Runs a case with the fee wallet temporarily set, since the real address
 *  is not chosen yet and the constant must stay empty until it is. */
function withFeeAddress<T>(address: string, run: () => T): T {
  const before = { ...FEE_ADDRESS };
  FEE_ADDRESS.mainnet = address;
  FEE_ADDRESS.testnet2 = address;
  try {
    return run();
  } finally {
    Object.assign(FEE_ADDRESS, before);
  }
}

const ADDRESS = "prl1p04985r8hkh8tjwj0hu78qcy6kpesypy0gmzwz5508tany932jg6sq7pzrr";

describe("Oyster's trading fee", () => {
  it("is 125 basis points", () => {
    expect(OYSTER_FEE_BPS).toBe(125n);
    expect(oysterFee(1_200n * PRL)).toBe(15n * PRL); // 1.25% of 1,200 PRL
    expect(oysterFee(100n * PRL)).toBe(125_000_000n);
  });

  it("rounds down, never in the user's disfavour", () => {
    // 1333 grains * 0.0125 = 16.6625 grains, so sixteen.
    expect(oysterFee(1_333n)).toBe(16n);
    // A fee that would be a fraction of a grain is nothing at all. At 1.25%
    // that is anything under 80 grains.
    expect(oysterFee(50n)).toBe(0n);
    expect(oysterFee(79n)).toBe(0n);
  });

  it("refuses to charge a fee on nothing", () => {
    expect(() => oysterFee(0n)).toThrow(FeeError);
    expect(() => oysterFee(-5n)).toThrow(FeeError);
  });

  it("splits a trade into what is sent and what is taken", () => {
    withFeeAddress(ADDRESS, () => {
      const s = splitFee(1_200n * PRL, PEARL_MAINNET);
      expect(s.fee).toBe(15n * PRL);
      expect(s.net).toBe(1_185n * PRL);
      expect(s.net + s.fee).toBe(1_200n * PRL);
      expect(s.feeAddress).toBe(ADDRESS);
      expect(s.dust).toBe(false);
    });
  });

  it("skips a fee that would be an unspendable output", () => {
    withFeeAddress(ADDRESS, () => {
      // 0.0004 PRL: the fee works out at 500 grains, under the 546 dust limit.
      const s = splitFee(40_000n, PEARL_MAINNET);
      expect(s.fee).toBe(0n);
      expect(s.net).toBe(40_000n);
      expect(s.feeAddress).toBeUndefined();
      expect(s.dust).toBe(true);
    });
  });

  it("pins the mainnet fee wallet, so a typo fails the build", () => {
    // Given 2026-09-21. Checked here as a literal, and decoded below, so
    // neither a slipped character nor a wrong network gets past CI.
    expect(FEE_ADDRESS.mainnet).toBe("prl1p9uawq7e5hc6l35jc70f5uhz7uw52cjlmlk3n4x8a7eevmgm82rzqal4nm3");
    const decoded = decodeAddress(FEE_ADDRESS.mainnet!, PEARL_MAINNET);
    expect(decoded.type).toBe("p2tr");
    expect(feeAddressFor(PEARL_MAINNET)).toBe(FEE_ADDRESS.mainnet);
  });

  it("sends the fee to that wallet", () => {
    const s = splitFee(1_200n * PRL, PEARL_MAINNET);
    expect(s.feeAddress).toBe(FEE_ADDRESS.mainnet);
    expect(s.fee).toBe(15n * PRL);
  });

  it("refuses a fee on a network with no wallet set, rather than burning it", () => {
    // testnet2 has none yet: better a loud refusal than an output nobody owns.
    expect(feeAddressFor(PEARL_TESTNET2)).toBeUndefined();
    expect(() => splitFee(1_200n * PRL, PEARL_TESTNET2)).toThrow(/no fee wallet address/);
  });

  it("works the same on another network, once that network has an address", () => {
    withFeeAddress(ADDRESS, () => {
      expect(splitFee(10n * PRL, PEARL_TESTNET2).fee).toBe(12_500_000n);
    });
  });
});
