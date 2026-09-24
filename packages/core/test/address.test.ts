import { bech32, bech32m } from "@scure/base";
import { hex } from "@scure/base";
import { describe, it, expect } from "vitest";
import { addressFromScript, decodeAddress, encodeTaproot, isValidAddress } from "../src/address.js";
import { accountFromSeed } from "../src/derivation.js";
import { scriptFor } from "../src/tx/build.js";
import { PEARL_MAINNET, PEARL_TESTNET2 } from "../src/network.js";

// Real testnet2 coinbase output from block 99,946, as served by Blockbook:
// scriptPubKey 5120dba8f2ac...4343 pays to this address.
const ONCHAIN_ADDR = "tprl1pmw509tys3kulusq5an6sy687evtmjd45hehluh9knn46n2v2gdpscgc7mf";
const ONCHAIN_KEY = "dba8f2ac908db9fe4014ecf50268fecb17b936b4be6ffe5cb69ceba9a98a4343";

const enc = (codec: typeof bech32, hrp: string, v: number, program: Uint8Array) =>
  codec.encode(hrp, [v, ...codec.toWords(program)]);

describe("decodeAddress", () => {
  it("decodes a real on-chain taproot address to its scriptPubKey key", () => {
    const d = decodeAddress(ONCHAIN_ADDR, PEARL_TESTNET2);
    expect(d.type).toBe("p2tr");
    expect(hex.encode(d.program)).toBe(ONCHAIN_KEY);
  });

  it("round-trips through encodeTaproot", () => {
    expect(encodeTaproot(hex.decode(ONCHAIN_KEY), PEARL_TESTNET2)).toBe(ONCHAIN_ADDR);
  });

  it("accepts all-uppercase, rejects mixed case", () => {
    expect(decodeAddress(ONCHAIN_ADDR.toUpperCase(), PEARL_TESTNET2).type).toBe("p2tr");
    const mixed = ONCHAIN_ADDR.slice(0, 10) + ONCHAIN_ADDR.slice(10).toUpperCase();
    expect(() => decodeAddress(mixed, PEARL_TESTNET2)).toThrow(/mixes upper and lower/);
  });

  it("names the network when the address is for the other one", () => {
    expect(() => decodeAddress(ONCHAIN_ADDR, PEARL_MAINNET)).toThrow(/testnet2 address/);
  });

  it("rejects Bitcoin addresses outright", () => {
    const btc = enc(bech32m, "bc", 1, hex.decode(ONCHAIN_KEY));
    expect(() => decodeAddress(btc, PEARL_MAINNET)).toThrow(/not a Pearl mainnet address/);
    expect(isValidAddress("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2", PEARL_MAINNET)).toBe(false);
  });

  it("rejects a single-character typo", () => {
    const typo = ONCHAIN_ADDR.slice(0, -1) + (ONCHAIN_ADDR.endsWith("f") ? "g" : "f");
    expect(() => decodeAddress(typo, PEARL_TESTNET2)).toThrow(/checksum/);
  });

  it("accepts v0 p2wpkh and p2wsh with bech32", () => {
    expect(decodeAddress(enc(bech32, "prl", 0, new Uint8Array(20).fill(7)), PEARL_MAINNET).type).toBe("p2wpkh");
    expect(decodeAddress(enc(bech32, "prl", 0, new Uint8Array(32).fill(7)), PEARL_MAINNET).type).toBe("p2wsh");
  });

  it("enforces BIP-350: v1 must be bech32m, v0 must be bech32", () => {
    const key = hex.decode(ONCHAIN_KEY);
    expect(() => decodeAddress(enc(bech32, "prl", 1, key), PEARL_MAINNET)).toThrow(/bech32m/);
    expect(() => decodeAddress(enc(bech32m, "prl", 0, new Uint8Array(20)), PEARL_MAINNET)).toThrow(/bech32/);
  });

  it("refuses unknown witness versions and lengths instead of sending to them", () => {
    expect(() => decodeAddress(enc(bech32m, "prl", 2, new Uint8Array(32)), PEARL_MAINNET)).toThrow(/unsupported witness v2/);
    expect(() => decodeAddress(enc(bech32m, "prl", 1, new Uint8Array(20)), PEARL_MAINNET)).toThrow(/unsupported witness v1/);
  });
});

describe("addressFromScript", () => {
  it("round-trips every segwit output type this wallet can meet", () => {
    for (const net of [PEARL_MAINNET, PEARL_TESTNET2]) {
      const tr = accountFromSeed(new Uint8Array(64).fill(7), net).deriveAddress({ index: 0 }).address;
      const back = addressFromScript(scriptFor(tr, net), net);
      expect(back).toBe(tr);
    }
  });

  it("says nothing for a script that is not an address", () => {
    // OP_RETURN with a few bytes of data.
    expect(addressFromScript(new Uint8Array([0x6a, 0x03, 1, 2, 3]), PEARL_MAINNET)).toBeUndefined();
    expect(addressFromScript(new Uint8Array([]), PEARL_MAINNET)).toBeUndefined();
    // Witness v0 with a length nobody spends.
    expect(addressFromScript(new Uint8Array([0x00, 0x02, 1, 2]), PEARL_MAINNET)).toBeUndefined();
  });
});
