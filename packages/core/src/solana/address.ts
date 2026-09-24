import { base58 } from "@scure/base";

/**
 * Checking a Solana address before someone's money is sent to it.
 *
 * A Solana address is a 32-byte ed25519 public key written in base58, with
 * no checksum of its own. That is worth knowing: unlike a Pearl or a Bitcoin
 * address, a typo does not reliably fail to decode, it just decodes to a
 * different key. So this can rule out an address that is malformed, and it
 * cannot rule out one that is merely wrong.
 *
 * Which is exactly why the wallet asks people to paste rather than type, and
 * shows the address back to them before anything is sent.
 */

/** Whether this could be a Solana address at all. */
export function isSolanaAddress(address: string): boolean {
  const s = address.trim();
  // Base58 has no 0, O, I or l, so a string containing one is not base58 at
  // all and can be turned away before decoding.
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try {
    return base58.decode(s).length === 32;
  } catch {
    return false;
  }
}

/**
 * The address as it should be stored.
 *
 * Solana is case sensitive, so unlike an EVM address this is only trimmed,
 * never lower-cased: changing the case changes the key.
 */
export function normalizeSolanaAddress(address: string): string {
  const s = address.trim();
  if (!isSolanaAddress(s)) throw new Error(`${address} is not a Solana address`);
  return s;
}
