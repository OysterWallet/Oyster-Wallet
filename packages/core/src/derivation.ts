import { HDKey } from "@scure/bip32";
import { entropyToMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { p2tr } from "@scure/btc-signer";
import { accountPath, type PearlNetwork } from "./network.js";
import type { RandomSource } from "./platform.js";

/**
 * BIP-39 -> BIP-32 -> BIP-86 taproot addresses for Pearl.
 *
 * Checked byte-for-byte against the official oyster wallet (test/derivation.test.ts,
 * vectors from oyster 1.0.2). Do not change anything here without re-running
 * that test against fresh oyster vectors: wrong derivation loses funds
 * silently, since the addresses look valid, the chain accepts them, and the
 * seed simply does not control them.
 */

export interface DerivedAddress {
  /** bech32m, e.g. prl1p... */
  address: string;
  /** Full path, e.g. m/86'/808276'/0'/0/0 */
  path: string;
  index: number;
  change: boolean;
  /** x-only pubkey, 32 bytes. */
  pubkey: Uint8Array;
}

export interface AccountKeys {
  /** Watch-only export (zpub on mainnet, vpub on testnet). Never send this to
   *  a third-party indexer: one extended key links every past and future
   *  address of the account permanently. */
  xpub: string;
  deriveAddress(opts: { index: number; change?: boolean }): DerivedAddress;
  /** Untweaked private key for signing. Only exists while the vault is
   *  unlocked; never persist or send it anywhere. */
  privateKey(opts: { index: number; change?: boolean }): Uint8Array;
}

/** New BIP-39 phrase from the platform CSPRNG. 12 words (128 bits) matches
 *  what the official desktop wallet generates. */
export function newMnemonic(random: RandomSource, words: 12 | 24 = 12): string {
  return entropyToMnemonic(random.bytes(words === 12 ? 16 : 32), wordlist);
}

export function isValidMnemonic(mnemonic: string): boolean {
  return validateMnemonic(normalizeMnemonic(mnemonic), wordlist);
}

export function normalizeMnemonic(mnemonic: string): string {
  return mnemonic.trim().toLowerCase().split(/\s+/).join(" ");
}

/** Standard BIP-39 seed, empty passphrase by default. Oyster uses the same
 *  (wallet/walletsetup.go, bip39.NewSeed(mnemonic, "")). */
export function seedFromMnemonic(mnemonic: string, passphrase = ""): Uint8Array {
  const normalized = normalizeMnemonic(mnemonic);
  if (!validateMnemonic(normalized, wordlist)) throw new Error("invalid mnemonic");
  return mnemonicToSeedSync(normalized, passphrase);
}

export function accountFromSeed(
  seed: Uint8Array,
  net: PearlNetwork,
  account = 0,
): AccountKeys {
  const path = accountPath(net, account);
  const acct = HDKey.fromMasterSeed(seed, net.hdVersions).derive(path);
  const btcNet = {
    bech32: net.bech32,
    // Unused for taproot, required by the btc-signer network shape.
    pubKeyHash: 0x00,
    scriptHash: 0x05,
    wif: 0x80,
  };

  const child = (index: number, change: boolean) => {
    if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) {
      throw new Error(`invalid address index ${index}`);
    }
    return acct.deriveChild(change ? 1 : 0).deriveChild(index);
  };

  return {
    xpub: acct.publicExtendedKey,
    privateKey({ index, change = false }) {
      const key = child(index, change).privateKey;
      if (!key) throw new Error("account has no private key");
      return key;
    },
    deriveAddress({ index, change = false }) {
      const node = child(index, change);
      if (!node.publicKey) throw new Error("derivation produced no public key");
      // BIP-86: key-path only taproot, x-only internal key, no script tree.
      const pubkey = node.publicKey.slice(1);
      const { address } = p2tr(pubkey, undefined, btcNet);
      if (!address) throw new Error("p2tr produced no address");
      return {
        address,
        path: `${path}/${change ? 1 : 0}/${index}`,
        index,
        change,
        pubkey,
      };
    },
  };
}
