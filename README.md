# Oyster Wallet

A self-custody wallet for the [Pearl](https://github.com/pearl-research-labs/pearl) (PRL)
network, as a browser extension. Your seed phrase and keys are created, encrypted and used on
your device, and never leave it.

[oysterwallet.app](https://oysterwallet.app) · [Docs](https://oysterwallet.app/docs) ·
[Security](#security)

## Layout

```
packages/core        platform-agnostic wallet logic. No chrome.*, no DOM, no WebCrypto.
packages/extension   WXT shell (MV3, Chrome + Firefox)
                     a React Native shell joins these later
```

`core` is where derivation, the vault, coin selection, transaction building and
the indexer client live. The shells contribute storage, randomness and a fetch,
and nothing else. That is what makes a mobile app a new shell rather than a
rewrite, and it is why the vault uses `@noble/ciphers` instead of WebCrypto:
React Native has no `SubtleCrypto`.

## Build

Requires Node 22+ and pnpm 10.

```
pnpm install
pnpm test          # core and extension tests
pnpm build         # extension build lands in packages/extension/.output/chrome-mv3
pnpm dev           # extension with hot reload
```

Load `packages/extension/.output/chrome-mv3` as an unpacked extension from
`chrome://extensions` with Developer mode on.

## Chain facts this repo assumes

Verified against a local clone of `pearl-research-labs/pearl` on 2026-09-18.

| Fact | Value | Source |
| --- | --- | --- |
| txids | double-SHA256 | `chainhash/hashfuncs.go` |
| sighash | BIP-341, standard tags | `node/txscript/sighash.go` |
| key scope | BIP-86 taproot | `waddrmgr/scoped_manager.go:161` |
| coin type | 808276 | `node/chaincfg/params.go:67` |
| HRP | `prl` / `tprl` | `node/chaincfg/params.go:342` |

Consensus hashing is byte-for-byte Bitcoin, so `@scure/btc-signer` works
unmodified with Pearl network params. Do not relax that assumption without
re-reading `sighash.go`.

Derivation matches the official Pearl desktop wallet byte for byte, so a seed phrase
works in either.

## Trading

Trading, USDT buying power and auto-sell go through Oyster's relay service, which is
operated separately and is not part of this repository. The extension only signs requests
and transactions locally; see the [docs](https://oysterwallet.app/docs#custody) for what the
relay holds.

## Security

Please report vulnerabilities privately to hello@oysterwallet.app rather than in a public
issue.

## License

Copyright (C) 2026 UALIS CORP.

This program is free software: you can redistribute it and/or modify it under the terms of
the GNU General Public License as published by the Free Software Foundation, either version 3
of the License, or (at your option) any later version. See [LICENSE](./LICENSE).

Bundled fonts (IBM Plex Sans, IBM Plex Mono, Newsreader) are under the SIL Open Font
License; see `packages/extension/public/fonts/OFL-*.txt`.
