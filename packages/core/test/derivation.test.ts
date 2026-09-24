import { existsSync, readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { accountFromSeed, isValidMnemonic, newMnemonic, seedFromMnemonic } from "../src/derivation.js";
import { PEARL_MAINNET, accountPath } from "../src/network.js";

/**
 * PHASE 0 GATE. Nothing else gets built until this file passes.
 *
 * How the vectors were produced (WSL, binaries at ~/code/pearl/bin), all in an
 * isolated appdata dir so the real ~/.oyster wallet is never touched:
 *   1. oyster -A /tmp/pw-vectors --createfromfile=in.json
 *        in.json = {"PrivatePassphrase": "..."} with no Seed, so oyster
 *        generates and prints its own 12-word mnemonic
 *   2. a peerless mainnet pearld in /tmp (genesis only) so oyster's RPC is live
 *   3. prlctl --wallet getnewaddress x3, getrawchangeaddress x1
 *   4. mnemonic + addresses into test/vectors.local.json (gitignored)
 *
 * Why this is the gate: derivation that is subtly wrong produces valid-looking
 * addresses that the chain accepts and the seed does not control. Funds sent
 * there are gone, and no later test catches it.
 */

interface Vectors {
  mnemonic: string;
  bip39Passphrase: string;
  receive: string[];
  change: string[];
  /** Account 1 (m/86'/808276'/1'), from oyster's createnewaccount. */
  account1?: { receive: string[]; change: string[] };
}

const vectorsPath = new URL("./vectors.local.json", import.meta.url);
const vectors: Vectors | undefined = existsSync(vectorsPath)
  ? JSON.parse(readFileSync(vectorsPath, "utf8"))
  : undefined;

describe.skipIf(!vectors)("BIP-86 derivation matches the official oyster wallet", () => {
  const acct = () =>
    accountFromSeed(
      seedFromMnemonic(vectors!.mnemonic, vectors!.bip39Passphrase),
      PEARL_MAINNET,
    );

  it("derives the same first three receive addresses as oyster", () => {
    const a = acct();
    const derived = vectors!.receive.map((_, i) => a.deriveAddress({ index: i }).address);
    expect(derived).toEqual(vectors!.receive);
  });

  it("derives the same first change address as oyster", () => {
    const a = acct();
    const derived = vectors!.change.map(
      (_, i) => a.deriveAddress({ index: i, change: true }).address,
    );
    expect(derived).toEqual(vectors!.change);
  });

  it("reports the full BIP-86 path for each address", () => {
    const a = acct();
    expect(a.deriveAddress({ index: 2 }).path).toBe("m/86'/808276'/0'/0/2");
    expect(a.deriveAddress({ index: 0, change: true }).path).toBe("m/86'/808276'/0'/1/0");
  });

  it("derives account 1 exactly as oyster's second account (multi-wallet)", () => {
    const a1 = vectors!.account1;
    expect(a1, "regenerate vectors with scripts in PLAN.md phase 0 plus createnewaccount").toBeDefined();
    const acct1 = accountFromSeed(seedFromMnemonic(vectors!.mnemonic, vectors!.bip39Passphrase), PEARL_MAINNET, 1);
    expect(a1!.receive.map((_, i) => acct1.deriveAddress({ index: i }).address)).toEqual(a1!.receive);
    expect(a1!.change.map((_, i) => acct1.deriveAddress({ index: i, change: true }).address)).toEqual(a1!.change);
    expect(acct1.deriveAddress({ index: 0 }).path).toBe("m/86'/808276'/1'/0/0");
  });

  it("exports the account key with Pearl's zpub magic", () => {
    expect(acct().xpub.startsWith("zpub")).toBe(true);
  });
});

describe("derivation invariants", () => {
  it("uses the Pearl coin type in the account path", () => {
    expect(accountPath(PEARL_MAINNET)).toBe("m/86'/808276'/0'");
  });

  it("rejects an invalid mnemonic instead of deriving from it", () => {
    expect(() => seedFromMnemonic("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon")).toThrow(
      /invalid mnemonic/,
    );
  });

  it("generates valid 12- and 24-word phrases from the injected randomness", () => {
    let i = 0;
    const random = { bytes: (n: number) => Uint8Array.from({ length: n }, () => (i++ * 37) & 0xff) };
    expect(newMnemonic(random).split(" ")).toHaveLength(12);
    expect(newMnemonic(random, 24).split(" ")).toHaveLength(24);
    expect(isValidMnemonic(newMnemonic(random))).toBe(true);
    expect(isValidMnemonic("  ABANDON abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about ")).toBe(true);
  });

  it("rejects hardened or negative indices", () => {
    const a = accountFromSeed(new Uint8Array(64).fill(1), PEARL_MAINNET);
    expect(() => a.deriveAddress({ index: -1 })).toThrow();
    expect(() => a.deriveAddress({ index: 0x80000000 })).toThrow();
  });
});
