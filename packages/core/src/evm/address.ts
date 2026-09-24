import { keccak_256 } from "@noble/hashes/sha3.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";

/**
 * Ethereum addresses, only as far as Oyster needs them.
 *
 * Wrapped PRL is an ERC-20 on Ethereum, and Oyster watches an address the
 * owner gives it. It holds no EVM keys and signs nothing there, so this is
 * checking and formatting, not derivation.
 */

const HEX40 = /^(0x)?[0-9a-fA-F]{40}$/;

/** EIP-55: upper-case a hex digit where the hash of the lower-case address
 *  has a high bit in that position. Mixed case is a typo check, not a format. */
export function toChecksumAddress(address: string): string {
  const raw = address.replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(raw)) throw new Error("not an Ethereum address");
  const hash = keccak_256(utf8ToBytes(raw));
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    const nibble = i % 2 === 0 ? hash[i >> 1]! >> 4 : hash[i >> 1]! & 0x0f;
    const c = raw[i]!;
    out += nibble >= 8 ? c.toUpperCase() : c;
  }
  return out;
}

/** True for a well-formed address. A mixed-case one must also checksum: that
 *  is the whole point of EIP-55, and accepting it anyway would waste it. */
export function isEvmAddress(address: string): boolean {
  const s = address.trim();
  if (!HEX40.test(s)) return false;
  const body = s.replace(/^0x/, "");
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  return toChecksumAddress(s) === (s.startsWith("0x") ? s : `0x${s}`);
}

/** Checksummed form, or an explanation of what is wrong with it. */
export function normalizeEvmAddress(address: string): string {
  const s = address.trim();
  if (!s) throw new Error("Paste an Ethereum address.");
  if (!HEX40.test(s)) {
    throw new Error(
      s.length < 42
        ? "That looks too short for an Ethereum address. They are 0x and 40 characters."
        : "That is not an Ethereum address. They start with 0x and have 40 hex characters after it.",
    );
  }
  if (!isEvmAddress(s)) throw new Error("That address does not check out. One character is likely wrong, so check it against the source you copied it from.");
  return toChecksumAddress(s);
}
