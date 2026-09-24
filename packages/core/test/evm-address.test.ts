import { describe, expect, it } from "vitest";
import { isEvmAddress, normalizeEvmAddress, toChecksumAddress } from "../src/evm/address";

// Vectors from EIP-55 itself.
const CHECKSUMMED = [
  "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
  "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
  "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
  "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
];

describe("evm addresses", () => {
  it("checksums the EIP-55 vectors", () => {
    for (const a of CHECKSUMMED) expect(toChecksumAddress(a.toLowerCase())).toBe(a);
  });

  it("accepts all-lower and all-upper, which carry no checksum", () => {
    expect(isEvmAddress(CHECKSUMMED[0]!.toLowerCase())).toBe(true);
    expect(isEvmAddress(`0x${CHECKSUMMED[0]!.slice(2).toUpperCase()}`)).toBe(true);
  });

  it("rejects a mixed-case address whose checksum is wrong", () => {
    const wrong = `0xAAaeb6053F3E94C9b9A09f33669435E7Ef1BeAed`;
    expect(isEvmAddress(wrong)).toBe(false);
    expect(() => normalizeEvmAddress(wrong)).toThrow(/does not check out/);
  });

  it("explains a length problem rather than a checksum one", () => {
    expect(() => normalizeEvmAddress("0x1234")).toThrow(/too short/);
    expect(() => normalizeEvmAddress("")).toThrow(/Paste an Ethereum address/);
    expect(() => normalizeEvmAddress("prl1p04985r8hkh8tjwj0hu78qcy6kpesypy0gmzwz5508tany932jg6sq7pzrr")).toThrow(/not an Ethereum address/);
  });

  it("normalizes to checksummed form, with or without 0x", () => {
    expect(normalizeEvmAddress(` ${CHECKSUMMED[1]!.toLowerCase()} `)).toBe(CHECKSUMMED[1]);
    expect(normalizeEvmAddress(CHECKSUMMED[2]!.slice(2).toLowerCase())).toBe(CHECKSUMMED[2]);
  });
});
