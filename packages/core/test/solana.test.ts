import { describe, expect, it } from "vitest";
import { isSolanaAddress, normalizeSolanaAddress } from "../src/solana/address.js";

describe("Solana addresses", () => {
  // Real ones. The first is the address that funded the SafeTrade account,
  // the second SafeTrade's own Solana deposit address, so both are known
  // good rather than invented.
  const REAL = [
    "C88tUFkDZAtCzA1xu8iLAb7a6FsSUJxrUr3L6sfMsDgc",
    "BebS1iyPsiJmQZU43XSgC8y7hZkhXatgRxYp4UBmcRRD",
  ];

  it("accepts real addresses", () => {
    for (const a of REAL) expect(isSolanaAddress(a)).toBe(true);
  });

  it("accepts one with leading ones, which encode leading zero bytes", () => {
    // A key beginning with zero bytes is shorter in base58 than 44 chars,
    // and refusing it would turn away a perfectly good address.
    expect(isSolanaAddress("11111111111111111111111111111111")).toBe(true);
  });

  it("turns away characters base58 does not have", () => {
    // No zero, capital O, capital I or lower-case l, so these are not
    // near-misses to decode: they are not base58 at all.
    for (const bad of ["0".repeat(44), `O${REAL[0]!.slice(1)}`, `I${REAL[0]!.slice(1)}`, `l${REAL[0]!.slice(1)}`]) {
      expect(isSolanaAddress(bad)).toBe(false);
    }
  });

  it("turns away anything that is not 32 bytes", () => {
    expect(isSolanaAddress("abc")).toBe(false);
    expect(isSolanaAddress(REAL[0]!.slice(0, 20))).toBe(false);
    expect(isSolanaAddress(`${REAL[0]}${REAL[0]}`)).toBe(false);
  });

  it("turns away an address from another chain", () => {
    expect(isSolanaAddress("0x07696DcaB55E62cfef953666b29Fe1970518cB00")).toBe(false);
    expect(isSolanaAddress("prl1p9uawq7e5hc6l35jc70f5uhz7uw52cjlmlk3n4x8a7eevmgm82rzqal4nm3")).toBe(false);
    expect(isSolanaAddress("TKwFymvmv5GKzwQ3f5cgqkKjpF2u9DK8Wi")).toBe(false);
  });

  it("turns away nothing at all", () => {
    expect(isSolanaAddress("")).toBe(false);
    expect(isSolanaAddress("   ")).toBe(false);
  });

  it("trims but never changes the case", () => {
    // Solana is case sensitive. Lower-casing it, as one would an EVM
    // address, would produce a different key and lose the money.
    expect(normalizeSolanaAddress(`  ${REAL[0]}  `)).toBe(REAL[0]);
    expect(isSolanaAddress(REAL[0]!.toLowerCase())).toBe(false);
  });

  it("refuses to normalise something that is not an address", () => {
    expect(() => normalizeSolanaAddress("not an address")).toThrow();
  });
});
