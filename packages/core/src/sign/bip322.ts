import { sha256 } from "@noble/hashes/sha2.js";
import { base64, hex, utf8 } from "@scure/base";
import { RawTx, RawWitness, Transaction } from "@scure/btc-signer";
import { decodeAddress } from "../address.js";
import type { PearlNetwork } from "../network.js";
import { scriptFor } from "../tx/build.js";

/**
 * BIP-322 "simple" message signing for taproot (key-path) addresses.
 *
 * Used by window.pearl signMessage so a site can check that a visitor
 * controls an address (sign-in), without any transaction being possible:
 * the signed transaction spends a virtual output that does not exist.
 *
 * to_spend: version 0, one input spending 000..0:0xffffffff with
 *   scriptSig OP_0 <tagged hash of the message>, one 0-value output paying
 *   the signing address.
 * to_sign: version 0, one input spending to_spend:0, one 0-value OP_RETURN
 *   output. The "simple" signature is the witness of that input, base64.
 */

const TAG = sha256(utf8.decode("BIP0322-signed-message"));

export function bip322MessageHash(message: string): Uint8Array {
  const m = utf8.decode(message);
  const buf = new Uint8Array(TAG.length * 2 + m.length);
  buf.set(TAG, 0);
  buf.set(TAG, TAG.length);
  buf.set(m, TAG.length * 2);
  return sha256(buf);
}

/** txid (display order, hex) of the virtual to_spend transaction. */
export function bip322ToSpendTxid(message: string, script: Uint8Array): string {
  const raw = RawTx.encode({
    version: 0,
    segwitFlag: false,
    inputs: [{
      txid: new Uint8Array(32),
      index: 0xffffffff,
      finalScriptSig: new Uint8Array([0x00, 0x20, ...bip322MessageHash(message)]),
      sequence: 0,
    }],
    outputs: [{ amount: 0n, script }],
    witnesses: [],
    lockTime: 0,
  });
  return hex.encode(sha256(sha256(raw)).reverse());
}

/** The unsigned to_sign transaction for `address`, ready for key-path signing. */
export function bip322ToSign(message: string, address: string, net: PearlNetwork, internalKey?: Uint8Array): Transaction {
  const script = scriptFor(address, net);
  const tx = new Transaction({ version: 0, allowUnknownOutputs: true });
  tx.addInput({
    txid: bip322ToSpendTxid(message, script),
    index: 0,
    sequence: 0,
    witnessUtxo: { script, amount: 0n },
    ...(internalKey ? { tapInternalKey: internalKey } : {}),
  });
  tx.addOutput({ script: new Uint8Array([0x6a]), amount: 0n });
  return tx;
}

/**
 * Signs `message` for a taproot address this wallet controls. `privateKey` is
 * the untweaked key and `internalKey` its x-only public key (BIP-86), exactly
 * as for spending. Returns the BIP-322 simple signature, base64.
 */
export function signMessageBip322(
  message: string,
  address: string,
  privateKey: Uint8Array,
  internalKey: Uint8Array,
  net: PearlNetwork,
): string {
  if (decodeAddress(address, net).type !== "p2tr") {
    throw new Error("BIP-322 signing is implemented for taproot addresses only");
  }
  const tx = bip322ToSign(message, address, net, internalKey);
  // signIdx checks the tweaked key matches the address before signing.
  if (!tx.signIdx(privateKey, 0)) throw new Error("message signature not produced");
  tx.finalize();
  const witness = tx.getInput(0).finalScriptWitness;
  if (!witness) throw new Error("message signature missing");
  return base64.encode(RawWitness.encode(witness));
}
