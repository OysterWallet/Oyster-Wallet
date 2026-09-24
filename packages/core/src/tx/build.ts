import { Transaction } from "@scure/btc-signer";
import { decodeAddress } from "../address.js";
import type { AccountKeys, DerivedAddress } from "../derivation.js";
import type { PearlNetwork } from "../network.js";
import type { SpendPlan } from "./select.js";

/**
 * Turns a SpendPlan into a signed, finalized taproot transaction.
 *
 * Every input is BIP-86 key-path: the internal key is our x-only pubkey and
 * btc-signer applies the TapTweak when signing. Pearl's sighash is byte-for-
 * byte BIP-341 (node/txscript/sighash.go), so no Pearl-specific signing code
 * exists here, and the end-to-end test proves that against a real pearld.
 *
 * Inputs signal RBF (nSequence 0xfffffffd) so a stuck send can be fee-bumped
 * later rather than waited out.
 */

const RBF_SEQUENCE = 0xfffffffd;

export interface SignedTx {
  txid: string;
  hex: string;
  vsize: number;
  fee: bigint;
}

export function scriptFor(address: string, net: PearlNetwork): Uint8Array {
  const d = decodeAddress(address, net);
  // OP_0 <20|32> for v0, OP_1 <32> for v1 (taproot).
  return Uint8Array.from([d.version === 0 ? 0x00 : 0x50 + d.version, d.program.length, ...d.program]);
}

/**
 * `owned` maps each input's address to its derivation, found by the account
 * scan. An input whose address is missing from it is not ours and aborts.
 */
export function signPlan(
  plan: SpendPlan,
  acct: AccountKeys,
  owned: ReadonlyMap<string, DerivedAddress>,
  net: PearlNetwork,
): SignedTx {
  const tx = new Transaction();

  for (const u of plan.inputs) {
    const d = owned.get(u.address);
    if (!d) throw new Error(`input ${u.txid}:${u.vout} is on ${u.address}, which this account does not own`);
    tx.addInput({
      txid: u.txid,
      index: u.vout,
      sequence: RBF_SEQUENCE,
      witnessUtxo: { script: scriptFor(u.address, net), amount: u.value },
      tapInternalKey: d.pubkey,
    });
  }

  tx.addOutput({ script: scriptFor(plan.to, net), amount: plan.amount });
  if (plan.change) tx.addOutput({ script: scriptFor(plan.change.address, net), amount: plan.change.value });

  plan.inputs.forEach((u, i) => {
    const d = owned.get(u.address)!;
    const key = acct.privateKey({ index: d.index, change: d.change });
    try {
      // Throws if the tweaked key does not match the output being spent,
      // which catches a wrong derivation before anything is broadcast.
      if (!tx.signIdx(key, i)) throw new Error("signature not produced");
    } finally {
      key.fill(0);
    }
  });
  tx.finalize();

  // Fee and size are what the node will judge; check them, do not trust the plan.
  const inTotal = plan.inputs.reduce((s, u) => s + u.value, 0n);
  const outTotal = plan.amount + (plan.change?.value ?? 0n);
  const fee = inTotal - outTotal;
  if (fee !== plan.fee) throw new Error(`fee mismatch: plan ${plan.fee}, tx ${fee}`);
  if (tx.vsize > plan.vsize) {
    throw new Error(`signed tx is ${tx.vsize} vB, estimate was ${plan.vsize}: fee would be short`);
  }
  if (fee < BigInt(tx.vsize)) throw new Error("fee below the 1 sat/vB relay minimum");

  return { txid: tx.id, hex: tx.hex, vsize: tx.vsize, fee };
}
