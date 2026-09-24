import { hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import { addressFromScript } from "../address.js";
import type { PearlNetwork } from "../network.js";

/**
 * What a raw transaction would do, in the terms a person can check.
 *
 * A site that asks the wallet to broadcast bytes is asking for its node and
 * its IP, so the bytes have to be readable before anyone agrees. Anything
 * that cannot be decoded is reported as such rather than waved through.
 */

export interface RawTxOutput {
  /** Absent when the output is not an address (a bare script, or OP_RETURN). */
  address?: string;
  value: bigint;
}

export interface RawTxDescription {
  txid: string;
  vsize: number;
  inputs: number;
  outputs: RawTxOutput[];
  /** Everything the outputs pay out. The fee is unknowable without the
   *  inputs' values, which are not in the transaction. */
  total: bigint;
}

export function describeRawTx(rawHex: string, net: PearlNetwork): RawTxDescription {
  const tx = Transaction.fromRaw(hex.decode(rawHex.trim()), { allowUnknownOutputs: true, allowUnknownInputs: true });
  const outputs: RawTxOutput[] = [];
  let total = 0n;
  for (let i = 0; i < tx.outputsLength; i++) {
    const o = tx.getOutput(i);
    const value = o.amount ?? 0n;
    total += value;
    const address = o.script ? addressFromScript(o.script, net) : undefined;
    outputs.push({ ...(address ? { address } : {}), value });
  }
  return { txid: tx.id, vsize: tx.vsize, inputs: tx.inputsLength, outputs, total };
}
