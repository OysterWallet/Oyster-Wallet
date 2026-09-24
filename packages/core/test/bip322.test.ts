import { createRequire } from "node:module";
import { base64, hex } from "@scure/base";
import { NETWORK, RawWitness, SigHash, WIF, p2tr } from "@scure/btc-signer";
import { describe, it, expect } from "vitest";
import { decodeAddress } from "../src/address.js";
import { accountFromSeed } from "../src/derivation.js";
import { PEARL_MAINNET, type PearlNetwork } from "../src/network.js";
import { bip322MessageHash, bip322ToSign, bip322ToSpendTxid, signMessageBip322 } from "../src/sign/bip322.js";
import { scriptFor } from "../src/tx/build.js";

// Schnorr verification for the tests only, reached through btc-signer's own
// dependency so core does not take on a new direct package.
const req = createRequire(createRequire(import.meta.url).resolve("@scure/btc-signer"));
const { schnorr } = req("@noble/curves/secp256k1.js") as {
  schnorr: { verify(sig: Uint8Array, msg: Uint8Array, pub: Uint8Array): boolean };
};

/** Bitcoin mainnet as a PearlNetwork, to run the BIP's own test vectors. */
const BTC: PearlNetwork = { ...PEARL_MAINNET, bech32: "bc" };

function verify(message: string, address: string, sigB64: string, net: PearlNetwork): boolean {
  const witness = RawWitness.decode(base64.decode(sigB64));
  if (witness.length !== 1) return false;
  const sig = witness[0]!;
  const hashType = sig.length === 65 ? sig[64]! : SigHash.DEFAULT;
  const tx = bip322ToSign(message, address, net);
  const sighash = tx.preimageWitnessV1(0, [scriptFor(address, net)], hashType, [0n]);
  return schnorr.verify(sig.slice(0, 64), sighash, decodeAddress(address, net).program);
}

describe("BIP-322 simple", () => {
  // Official vectors, https://github.com/bitcoin/bips/blob/master/bip-0322.mediawiki
  it("matches the BIP's message hashes", () => {
    expect(hex.encode(bip322MessageHash(""))).toBe("c90c269c4f8fcbe6880f72a721ddfbf1914268a794cbb21cfafee13770ae19f1");
    expect(hex.encode(bip322MessageHash("Hello World"))).toBe("f0eb03b1a75ac6d9847f55c624a99169b5dccba2a31f5b23bea77ba270de0a7a");
  });

  it("matches the BIP's to_spend txid", () => {
    const script = scriptFor("bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l", BTC);
    expect(bip322ToSpendTxid("", script)).toBe("c5680aa69bb8d860bf82d4e9cd3504b55dde018de765a91bb566283c545a99a7");
    expect(bip322ToSpendTxid("Hello World", script)).toBe("b79d196740ad5217771c1098fc4a4b51e0535c32236c71f1ea4d61a2d603352b");
  });

  it("verifies the BIP's taproot signature", () => {
    const addr = "bc1ppv609nr0vr25u07u95waq5lucwfm6tde4nydujnu8npg4q75mr5sxq8lt3";
    const sig = "AUHd69PrJQEv+oKTfZ8l+WROBHuy9HKrbFCJu7U1iK2iiEy1vMU5EfMtjc+VSHM7aU0SDbak5IUZRVno2P5mjSafAQ==";
    expect(verify("Hello World", addr, sig, BTC)).toBe(true);
    expect(verify("Hello World!", addr, sig, BTC)).toBe(false);
  });

  it("signs with the BIP's key, and the result verifies", () => {
    const priv = WIF(NETWORK).decode("L3VFeEujGtevx9w18HD1fhRbCH67Az2dpCymeRE1SoPK6XQtaN2k");
    const internal = p2tr(req("@noble/curves/secp256k1.js").schnorr.getPublicKey(priv)).tapInternalKey;
    const addr = "bc1ppv609nr0vr25u07u95waq5lucwfm6tde4nydujnu8npg4q75mr5sxq8lt3";
    const sig = signMessageBip322("Hello World", addr, priv, internal, BTC);
    expect(verify("Hello World", addr, sig, BTC)).toBe(true);
  });

  it("signs for a Pearl address from the wallet's own keys", () => {
    const acct = accountFromSeed(new Uint8Array(64).fill(5), PEARL_MAINNET);
    const d = acct.deriveAddress({ index: 0 });
    const sig = signMessageBip322("Sign in to market.example", d.address, acct.privateKey({ index: 0 }), d.pubkey, PEARL_MAINNET);
    expect(verify("Sign in to market.example", d.address, sig, PEARL_MAINNET)).toBe(true);
    expect(verify("Sign in to evil.example", d.address, sig, PEARL_MAINNET)).toBe(false);
  });

  it("refuses to sign with a key that does not own the address", () => {
    const acct = accountFromSeed(new Uint8Array(64).fill(5), PEARL_MAINNET);
    const d0 = acct.deriveAddress({ index: 0 });
    const d1 = acct.deriveAddress({ index: 1 });
    expect(() => signMessageBip322("x", d0.address, acct.privateKey({ index: 1 }), d1.pubkey, PEARL_MAINNET)).toThrow();
  });
});
