import { bech32, bech32m } from "@scure/base";
import { PEARL_MAINNET, PEARL_REGTEST, PEARL_TESTNET2, type PearlNetwork } from "./network.js";

/**
 * Segwit address handling for Pearl (BIP-173 / BIP-350 with Pearl HRPs).
 *
 * Only segwit is accepted. Pearl's desktop wallet is taproot-only and every
 * address seen on chain is bech32/bech32m, so a base58 string is far more
 * likely to be a Bitcoin address pasted by mistake than a Pearl one.
 *
 * Unknown witness versions and lengths are rejected rather than passed
 * through: they are valid encodings, but sending to one is sending to a
 * script nobody may be able to spend today.
 */

export type AddressType = "p2wpkh" | "p2wsh" | "p2tr";

export interface DecodedAddress {
  type: AddressType;
  version: number;
  program: Uint8Array;
}

export class AddressError extends Error {
  override name = "AddressError";
}

const OTHER_NETWORKS: readonly PearlNetwork[] = [PEARL_MAINNET, PEARL_TESTNET2, PEARL_REGTEST];

export function decodeAddress(address: string, net: PearlNetwork): DecodedAddress {
  const trimmed = address.trim();
  if (trimmed !== trimmed.toLowerCase() && trimmed !== trimmed.toUpperCase()) {
    throw new AddressError("address mixes upper and lower case");
  }
  const lower = trimmed.toLowerCase();

  const sep = lower.lastIndexOf("1");
  const hrp = sep > 0 ? lower.slice(0, sep) : "";
  if (hrp !== net.bech32) {
    const other = OTHER_NETWORKS.find((n) => n.bech32 === hrp && n.id !== net.id);
    throw new AddressError(
      other
        ? `this is a ${other.id} address, wallet is on ${net.id}`
        : `not a Pearl ${net.id} address (expected ${net.bech32}1...)`,
    );
  }

  // Witness version is the first data character; it decides the checksum.
  const version = bech32.decodeUnsafe(lower)?.words[0] ?? bech32m.decodeUnsafe(lower)?.words[0];
  if (version === undefined) throw new AddressError("invalid address checksum");
  const codec = version === 0 ? bech32 : bech32m;
  const decoded = codec.decodeUnsafe(lower);
  if (!decoded) {
    throw new AddressError(
      version === 0 ? "invalid checksum (v0 must use bech32)" : "invalid checksum (v1+ must use bech32m)",
    );
  }

  const program = Uint8Array.from(codec.fromWords(decoded.words.slice(1)));
  if (version === 0 && program.length === 20) return { type: "p2wpkh", version, program };
  if (version === 0 && program.length === 32) return { type: "p2wsh", version, program };
  if (version === 1 && program.length === 32) return { type: "p2tr", version, program };
  throw new AddressError(`unsupported witness v${version} program of ${program.length} bytes`);
}

export function isValidAddress(address: string, net: PearlNetwork): boolean {
  try {
    decodeAddress(address, net);
    return true;
  } catch {
    return false;
  }
}

/** Encode an already-tweaked 32-byte taproot output key. */
export function encodeTaproot(outputKey: Uint8Array, net: PearlNetwork): string {
  if (outputKey.length !== 32) throw new AddressError("taproot output key must be 32 bytes");
  return bech32m.encode(net.bech32, [1, ...bech32m.toWords(outputKey)]);
}

/** The address a segwit output script pays to, or undefined when the script
 *  is not one (a bare script, an OP_RETURN, an unknown witness version). */
export function addressFromScript(script: Uint8Array, net: PearlNetwork): string | undefined {
  if (script.length < 4 || script.length > 42) return undefined;
  const op = script[0]!;
  const version = op === 0 ? 0 : op >= 0x51 && op <= 0x60 ? op - 0x50 : -1;
  if (version < 0) return undefined;
  const len = script[1]!;
  const program = script.subarray(2);
  if (len !== program.length) return undefined;
  if (version === 0 && program.length !== 20 && program.length !== 32) return undefined;
  if (version === 1 && program.length !== 32) return undefined;
  const codec = version === 0 ? bech32 : bech32m;
  return codec.encode(net.bech32, [version, ...codec.toWords(program)]);
}
