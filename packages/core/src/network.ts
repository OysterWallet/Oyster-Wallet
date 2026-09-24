/**
 * Pearl chain parameters.
 *
 * Verified against a local clone of pearl-research-labs/pearl on 2026-09-18:
 *   bech32 HRP            node/chaincfg/params.go:342
 *   BIP-44 coin type      node/chaincfg/params.go:67
 *   default key scope     wallet/waddrmgr/scoped_manager.go:161  (BIP-86, taproot)
 *   HD key version bytes  node/chaincfg/params.go:349,435  (BIP-84 zpub/vpub magics)
 *
 * Consensus hashing is byte-for-byte Bitcoin (double-SHA256 txids, BIP-341
 * sighash with the standard tags), so @scure/btc-signer works unmodified with
 * these params. Do not "fix" that assumption without re-reading sighash.go.
 */

export interface PearlNetwork {
  readonly id: "mainnet" | "testnet2" | "regtest";
  readonly bech32: string;
  readonly coinType: number;
  /** Blockbook v2 base URL. Both public instances confirmed live and in sync;
   *  empty for regtest, which has no indexer. */
  readonly indexer: string;
  /** Transaction page on a block explorer; `{txid}` is substituted. */
  readonly explorerTx: string;
  /** Outputs at or below this are dust and are never created. */
  readonly dustThreshold: bigint;
  /** BIP-32 serialization magics. Pearl reuses the BIP-84 values, so extended
   *  keys encode as zpub/zprv (mainnet) and vpub/vprv (testnet). Affects export
   *  strings only, never which addresses are derived. */
  readonly hdVersions: { readonly public: number; readonly private: number };
}

export const PEARL_MAINNET: PearlNetwork = {
  id: "mainnet",
  bech32: "prl",
  coinType: 808276,
  indexer: "https://blockbook.pearlresearch.ai",
  explorerTx: "https://explorer.pearlresearch.ai/tx/{txid}?network=mainnet",
  dustThreshold: 546n,
  hdVersions: { public: 0x04b24746, private: 0x04b2430c },
};

export const PEARL_TESTNET2: PearlNetwork = {
  id: "testnet2",
  bech32: "tprl",
  coinType: 1,
  indexer: "https://blockbook.testnet.pearlresearch.ai",
  explorerTx: "https://blockbook.testnet.pearlresearch.ai/tx/{txid}",
  dustThreshold: 546n,
  hdVersions: { public: 0x045f1cf6, private: 0x045f18bc },
};

/** Local regtest (node/chaincfg/params.go regtest block). Used only by the
 *  end-to-end test, which mines its own coins with pearld's CPU miner. */
export const PEARL_REGTEST: PearlNetwork = {
  id: "regtest",
  bech32: "rprl",
  coinType: 1,
  indexer: "",
  explorerTx: "",
  dustThreshold: 546n,
  hdVersions: { public: 0x045f1cf6, private: 0x045f18bc },
};

/** BIP-86 account path. Matches the desktop wallet, so seeds are portable. */
export function accountPath(net: PearlNetwork, account = 0): string {
  return `m/86'/${net.coinType}'/${account}'`;
}
