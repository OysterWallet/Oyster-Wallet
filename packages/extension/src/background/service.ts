import {
  accountFromSeed,
  accountHistory,
  AddressError,
  BlockbookError,
  formatPrl,
  SpendError,
  applyFreezePolicy,
  BlockbookClient,
  BumpError,
  planBump,
  planCancel,
  DEFAULT_GAP_LIMIT,
  decodeAddress,
  describeRawTx,
  inBatches,
  isValidMnemonic,
  LOOKUP_CONCURRENCY,
  newMnemonic,
  normalizeEvmAddress,
  isEvmAddress,
  isSolanaAddress,
  normalizeSolanaAddress,
  normalizeMnemonic,
  OYSTER_RECOVERY_GAP,
  outpoint,
  PEARL_MAINNET,
  PEARL_TESTNET2,
  planSpend,
  scanAccount,
  seedFromMnemonic,
  signPlan,
  Vault,
  VaultError,
  type AccountKeys,
  type AccountScan,
  type DerivedAddress,
  type PearlNetwork,
  type Platform,
  type ProtectedUtxo,
  type SpendPlan,
  type VaultContents,
  type VaultWallet,
  type WalletColor,
  type WalletTx,
  miningStats,
  signMessageBip322,
  MAX_FEE_RATE,
  MIN_RELAY_SAT_PER_VB,
  WALLET_COLORS,
} from "@pearl-wallet/core";
import type {
  AddWalletArgs,
  AppState,
  AutoSell,
  CashView,
  ChartRange,
  DepthView,
  MarketTrade,
  OrderQuote,
  AccountView,
  MyOrder,
  MyOrdersView,
  OrdersView,
  PriceAlert,
  TradesView,
  DepositAddress,
  Coin,
  Contact,
  EstimatedTier,
  ChartView,
  MiningView,
  PriceView,
  FeeTier,
  NetworkId,
  ProtectedCoin,
  RawTxSummary,
  Theme,
  UiMode,
  SendArgs,
  SendQuote,
  CancelQuote,
  SpeedUpQuote,
  WalletDetails,
  WalletSummary,
  CashEntry,
  WalletView,
  WithdrawInfo,
  WrappedView,
  WireTx,
} from "../messages";
import { AUTO_LOCK_CHOICES, CASH_CHAINS, type CashChainId, PEARL_CHAIN } from "../messages";
import { Account, AccountError, sellClaimMessage } from "./account";
import { type SellWatcher, tellRelayCancelled, tellRelayReplaced } from "./relay-notify";
import { DEFAULT_RELAY, Prices } from "./prices";

/**
 * Everything with a key or a socket lives here, in the background worker.
 *
 * In-memory caches (derived keys, the last scan) die with the worker, which
 * MV3 kills after ~30 s idle. That is fine: while the vault session is still
 * unlocked they are rebuilt from the vault on the next request, and when it
 * is locked they are exactly what should be gone.
 */

/** How many addresses the locked watcher will poll. One request each, paced,
 *  every two minutes: enough for any real wallet, bounded for a huge one. */
const WATCH_ADDRESS_LIMIT = 12;

/** Auto-sell defaults: a hundred PRL, which is a few pool payouts rather than
 *  one, and a floor below which a trade costs more than it returns. */
const DEFAULT_AUTOSELL_THRESHOLD = 100n * 100_000_000n;
const MIN_AUTOSELL_THRESHOLD = 10n * 100_000_000n;
/** Enough for a few levels either side; past that it is noise, not signal. */
const MAX_ALERTS = 10;

const NETWORKS: Record<NetworkId, PearlNetwork> = {
  mainnet: PEARL_MAINNET,
  testnet2: PEARL_TESTNET2,
};

/** Confirmation targets in blocks, at ~168 s per block (measured 2026-09-19). */
const FEE_TARGETS: Record<EstimatedTier, number> = { fast: 1, normal: 4, slow: 10 };
/** How far the Mining screen digs for a week of payouts: up to 1,000
 *  transactions per address. Measured: a 250-tx page takes ~0.5 s. */
const MINING_PAGE_SIZE = 250;
const MINING_MAX_PAGES = 4;
/** A view older than this is rescanned before quoting or sending. */
const FRESH_MS = 30_000;

interface Settings {
  network: NetworkId;
  uiMode?: UiMode;
  relayUrl?: string;
  operatorSecret?: string;
  cashAddresses?: Partial<Record<CashChainId, string>>;
  activeWalletId?: string;
  autoLockMinutes?: number;
  theme?: Theme;
}

/** Non-secret, per wallet and network. */
interface WalletMeta {
  knownUsed: { receive: number; change: number };
  /** Imported seeds get one deep scan at oyster's recovery window. */
  needsDeepScan: boolean;
  /**
   * Payments this wallet has broadcast and not yet seen reported back.
   *
   * The history comes from the indexer, which does not have a transaction
   * the instant it is broadcast. Without these, a payment vanishes between
   * hitting send and the indexer catching up: the money has left, and the
   * wallet shows no sign of it, which reads as having lost it.
   *
   * Dropped as soon as the indexer reports the same txid, so they are a
   * stand-in and never a second source of truth.
   */
  broadcast?: { txid: string; net: string; fee: string; to: string; at: number }[];
  /** From the last scan, for the wallet list (no rescan to open it). */
  lastBalance?: string;
  firstAddress?: string;
}

interface Loaded {
  key: string;
  net: PearlNetwork;
  /** Null for a watch-only wallet: there are no keys to derive or sign with. */
  acct: AccountKeys | null;
  /** The followed address, for a watch-only wallet. */
  watch?: string;
  scan: AccountScan;
  utxos: ProtectedUtxo[];
  txs: WalletTx[];
  historyComplete: boolean;
  owned: Map<string, DerivedAddress>;
  scannedAt: number;
}

export class ServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class WalletService {
  private readonly vault: Vault;
  private readonly accounts = new Map<string, AccountKeys>();
  /** One client per network, so every lookup shares one request pacer. */
  private readonly clients = new Map<string, BlockbookClient>();
  private loaded: Loaded | null = null;
  private readonly prices: Prices;
  /** The account the relay keeps for this wallet, and its session. */
  private readonly relayAccount: Account;
  /** History pages fetched per address; grows when the user asks for more. */
  private historyPages = 1;
  private scanning: Promise<Loaded> | null = null;

  constructor(private readonly platform: Platform) {
    this.prices = new Prices(platform.fetch, () => platform.clock.now());
    this.relayAccount = new Account(platform.fetch, () => platform.clock.now(), DEFAULT_RELAY);
    this.vault = new Vault(platform, {
      autoLockMs: async () => ((await this.settings()).autoLockMinutes ?? 15) * 60_000,
    });
  }

  // ---- state and lifecycle -------------------------------------------------

  async state(): Promise<AppState> {
    const settings = await this.settings();
    const hasVault = await this.vault.exists();
    const unlocked = hasVault && (await this.vault.isUnlocked());
    if (!unlocked) this.forget();
    const wallets = unlocked ? await this.summaries(await this.vault.read(), settings.network) : [];
    return {
      hasVault,
      unlocked,
      network: settings.network,
      wallets,
      autoLockMinutes: settings.autoLockMinutes ?? 15,
      theme: settings.theme ?? "system",
      relayUrl: settings.relayUrl ?? DEFAULT_RELAY,
      hasOperatorKey: (settings.operatorSecret ?? "").length > 0,
      cashAddresses: settings.cashAddresses ?? {},
      uiMode: settings.uiMode ?? "popup",
      sidePanelSupported: this.platform.sidePanel !== undefined,
      ...(settings.activeWalletId ? { activeWalletId: settings.activeWalletId } : {}),
    };
  }

  generateMnemonic(): { mnemonic: string } {
    return { mnemonic: newMnemonic(this.platform.random) };
  }

  validateMnemonic(mnemonic: string): { valid: boolean; words: number } {
    const words = normalizeMnemonic(mnemonic).split(" ").filter(Boolean).length;
    return { valid: (words === 12 || words === 24) && isValidMnemonic(mnemonic), words };
  }

  /** `replace` is the forgot-password path: the old vault is deleted and the
   *  wallet comes back from the seed phrase the user just typed. */
  async createVault(password: string, mnemonic: string, imported: boolean, replace = false): Promise<AppState> {
    if (!isValidMnemonic(mnemonic)) throw new ServiceError("invalid-mnemonic", "That seed phrase is not valid.");
    if (replace) {
      await this.vault.destroy();
      this.forget();
    }
    const id = hex(this.platform.random.bytes(8));
    const seedId = hex(this.platform.random.bytes(8));
    const now = this.platform.clock.now();
    await this.vault.create(password, {
      schema: 2,
      seeds: [{ id: seedId, mnemonic: normalizeMnemonic(mnemonic), createdAt: now }],
      wallets: [{ id, name: "Main wallet", color: "teal", source: { kind: "seed", seedId, account: 0 }, createdAt: now }],
    });
    await this.saveSettings({ ...(await this.settings()), activeWalletId: id });
    for (const net of Object.keys(NETWORKS) as NetworkId[]) {
      await this.saveMeta(id, net, { ...emptyMeta(), needsDeepScan: imported });
    }
    // The design asks for the password once more right after setup, which
    // doubles as a check that the user actually knows what they just typed.
    await this.vault.lock();
    return this.state();
  }

  async unlock(password: string): Promise<AppState> {
    await this.vault.unlock(password);
    return this.state();
  }

  async lock(): Promise<AppState> {
    await this.vault.lock();
    this.forget();
    return this.state();
  }

  /** Called from the alarm: applies the idle timeout even with no popup open. */
  /** True when this call is the one that noticed the lock, so the caller can
   *  tell any open window rather than leaving a stale balance on screen. */
  /**
   * Is the wallet still unlocked? Deliberately the one question that does
   * not count as activity: reading the vault touches the idle timer, so a
   * window asking "are we still unlocked" on a timer would keep the wallet
   * unlocked for as long as it stayed open, which is the opposite of what
   * an auto-lock is for. Asking also enforces the deadline, so the answer
   * is never stale.
   */
  async lockState(): Promise<{ hasVault: boolean; unlocked: boolean }> {
    const hasVault = await this.vault.exists();
    const unlocked = hasVault && (await this.vault.isUnlocked());
    if (!unlocked) this.forget();
    return { hasVault, unlocked };
  }

  async enforceAutoLock(): Promise<boolean> {
    if (await this.vault.isUnlocked()) return false;
    const wasOpen = this.loaded !== null;
    this.forget();
    return wasOpen;
  }

  async setNetwork(network: NetworkId): Promise<AppState> {
    if (!(network in NETWORKS)) throw new ServiceError("bad-network", `unknown network ${network}`);
    await this.saveSettings({ ...(await this.settings()), network });
    this.loaded = null;
    return this.state();
  }

  /** Popup or side panel. The platform applies it to the browser action; the
   *  setting is remembered so a restarted worker can apply it again. */
  async setUiMode(mode: UiMode): Promise<AppState> {
    if (mode !== "popup" && mode !== "sidepanel") throw new ServiceError("bad-setting", "mode must be popup or sidepanel");
    await this.saveSettings({ ...(await this.settings()), uiMode: mode });
    await this.platform.sidePanel?.apply(mode === "sidepanel");
    return this.state();
  }

  /** Applied on every worker start, since a browser action forgets it. */
  async applyUiMode(): Promise<void> {
    await this.platform.sidePanel?.apply(((await this.settings()).uiMode ?? "popup") === "sidepanel");
  }

  async setAutoLock(minutes: number): Promise<AppState> {
    if (!(AUTO_LOCK_CHOICES as readonly number[]).includes(minutes)) {
      throw new ServiceError("bad-setting", `auto-lock must be one of ${AUTO_LOCK_CHOICES.join(", ")} minutes`);
    }
    await this.saveSettings({ ...(await this.settings()), autoLockMinutes: minutes });
    return this.state();
  }

  async setTheme(theme: Theme): Promise<AppState> {
    if (!["system", "light", "dark"].includes(theme)) throw new ServiceError("bad-setting", "unknown theme");
    await this.saveSettings({ ...(await this.settings()), theme });
    return this.state();
  }

  async changePassword(oldPassword: string, newPassword: string): Promise<AppState> {
    await this.vault.changePassword(oldPassword, newPassword);
    return this.state();
  }

  /**
   * A file that restores this whole wallet, not just one seed phrase.
   *
   * The vault inside it stays sealed with the password, so the file is
   * useless to anyone who does not have that. The few settings alongside it
   * are in the clear: which addresses are watched, miner mode, the coins
   * left unfrozen. They are not secrets, but they do say what this wallet
   * follows, so the file still wants keeping somewhere private.
   */
  async exportBackup(password: string): Promise<{ file: string; name: string }> {
    if (!(await this.vault.verifyPassword(password))) {
      throw new ServiceError("wrong-password", "That password is not right.");
    }
    const all = (await this.platform.storage.entries?.()) ?? {};
    const extras: Record<string, string> = {};
    for (const [k, v] of Object.entries(all)) {
      if (k === "vault.v1" || k === "vault.attempts") continue;
      extras[k] = v;
    }
    const file = JSON.stringify(
      { app: "oyster", v: 1, at: new Date().toISOString(), vault: await this.vault.exportSealed(), extras },
      null,
      2,
    );
    const day = new Date().toISOString().slice(0, 10);
    return { file, name: `oyster-backup-${day}.json` };
  }

  /** Replaces everything on this device with a backup file. */
  async importBackup(fileText: string, password: string): Promise<AppState> {
    let parsed: { app?: string; v?: number; vault?: string; extras?: Record<string, string> };
    try {
      parsed = JSON.parse(fileText) as typeof parsed;
    } catch {
      throw new ServiceError("bad-backup", "That file is not an Oyster backup.");
    }
    if (parsed.app !== "oyster" || parsed.v !== 1 || typeof parsed.vault !== "string") {
      throw new ServiceError("bad-backup", "That file is not an Oyster backup.");
    }
    // Proves the password before anything on this device is touched.
    await this.vault.importSealed(parsed.vault, password);
    for (const [k, v] of Object.entries(parsed.extras ?? {})) {
      if (k.startsWith("vault.") || typeof v !== "string") continue;
      await this.platform.storage.set(k, v);
    }
    this.loaded = null;
    await this.useRelay();
    return this.state();
  }

  async exportSeed(password: string, walletId?: string): Promise<{ mnemonic: string }> {
    if (!(await this.vault.verifyPassword(password))) {
      throw new ServiceError("wrong-password", "That password is not right.");
    }
    const contents = await this.vault.read();
    const w = walletId ? contents.wallets.find((x) => x.id === walletId) : await this.activeWallet();
    if (!w) throw new ServiceError("no-wallet", "That wallet is no longer in Oyster.");
    if (w.source.kind !== "seed") {
      throw new ServiceError("watch-only", "A watch-only wallet has no seed phrase. It only follows an address.");
    }
    const seedId = w.source.seedId;
    const seed = contents.seeds.find((x) => x.id === seedId);
    if (!seed) throw new ServiceError("no-seed", "This wallet's seed phrase is missing from the vault.");
    return { mnemonic: seed.mnemonic };
  }

  // ---- wallets -------------------------------------------------------------

  async switchWallet(id: string): Promise<AppState> {
    const { wallets } = await this.vault.read();
    if (!wallets.some((w) => w.id === id)) throw new ServiceError("no-wallet", "That wallet is no longer in Oyster.");
    await this.saveSettings({ ...(await this.settings()), activeWalletId: id });
    this.loaded = null;
    this.historyPages = 1;
    return this.state();
  }

  async addWallet(args: AddWalletArgs): Promise<AppState> {
    const name = args.name.trim();
    if (!name || name.length > 32) throw new ServiceError("bad-name", "Give the wallet a name, up to 32 characters.");
    const contents = await this.vault.read();
    const now = this.platform.clock.now();
    const id = hex(this.platform.random.bytes(8));
    const color: WalletColor = args.color ?? WALLET_COLORS[contents.wallets.length % WALLET_COLORS.length]!;
    let wallet: VaultWallet;
    let deepScan = false;

    if (args.mode.kind === "next") {
      const active = await this.activeWallet();
      const seedId = active.source.kind === "seed" ? active.source.seedId : contents.seeds[0]?.id;
      if (!seedId) {
        throw new ServiceError("no-seed", "There is no seed phrase in Oyster yet. Import one instead.");
      }
      const used = contents.wallets.flatMap((w) => (w.source.kind === "seed" && w.source.seedId === seedId ? [w.source.account] : []));
      const account = used.length ? Math.max(...used) + 1 : 0;
      wallet = { id, name, color, source: { kind: "seed", seedId, account }, createdAt: now };
    } else if (args.mode.kind === "import") {
      const mnemonic = normalizeMnemonic(args.mode.mnemonic);
      if (!isValidMnemonic(mnemonic)) throw new ServiceError("invalid-mnemonic", "That seed phrase is not valid.");
      const existing = contents.seeds.findIndex((x) => x.mnemonic === mnemonic);
      if (existing >= 0) {
        throw new ServiceError(
          "seed-exists",
          `That seed phrase is already in Oyster as Seed ${existing + 1}. Use "New wallet from my seed" to add another account from it.`,
        );
      }
      const seedId = hex(this.platform.random.bytes(8));
      contents.seeds.push({ id: seedId, mnemonic, createdAt: now });
      wallet = { id, name, color, source: { kind: "seed", seedId, account: 0 }, createdAt: now };
      deepScan = true;
    } else {
      const address = args.mode.address.trim();
      decodeAddress(address, await this.net()); // throws a readable AddressError
      if (contents.wallets.some((w) => w.source.kind === "watch" && w.source.address === address)) {
        throw new ServiceError("watch-exists", "Oyster is already watching that address.");
      }
      wallet = { id, name, color, source: { kind: "watch", address }, createdAt: now };
    }

    contents.wallets.push(wallet);
    await this.vault.write(contents);
    for (const net of Object.keys(NETWORKS) as NetworkId[]) {
      await this.saveMeta(id, net, { ...emptyMeta(), needsDeepScan: deepScan });
    }
    return this.switchWallet(id);
  }

  async updateWallet(id: string, patch: { name?: string; color?: WalletColor }): Promise<AppState> {
    const contents = await this.vault.read();
    const w = contents.wallets.find((x) => x.id === id);
    if (!w) throw new ServiceError("no-wallet", "That wallet is no longer in Oyster.");
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name || name.length > 32) throw new ServiceError("bad-name", "Give the wallet a name, up to 32 characters.");
      w.name = name;
    }
    if (patch.color !== undefined) {
      if (!WALLET_COLORS.includes(patch.color)) throw new ServiceError("bad-color", "Unknown color.");
      w.color = patch.color;
    }
    await this.vault.write(contents);
    return this.state();
  }

  /**
   * Removing the last wallet on a seed deletes that seed phrase from this
   * device, so it needs `acknowledgeSeedDeletion` (the UI makes the user
   * confirm they have the phrase). The last wallet overall cannot be removed.
   */
  async removeWallet(id: string, acknowledgeSeedDeletion = false): Promise<AppState> {
    const contents = await this.vault.read();
    const w = contents.wallets.find((x) => x.id === id);
    if (!w) throw new ServiceError("no-wallet", "That wallet is no longer in Oyster.");
    if (contents.wallets.length === 1) {
      throw new ServiceError("last-wallet", "This is the only wallet in Oyster, so it cannot be removed.");
    }
    const removesSeed = this.removesSeed(contents, w);
    if (removesSeed && !acknowledgeSeedDeletion) {
      throw new ServiceError("needs-ack", "Removing this wallet deletes its seed phrase from this device. Confirm you have it written down.");
    }
    contents.wallets = contents.wallets.filter((x) => x.id !== id);
    if (removesSeed && w.source.kind === "seed") {
      const seedId = w.source.seedId;
      contents.seeds = contents.seeds.filter((x) => x.id !== seedId);
    }
    await this.vault.write(contents);
    for (const net of Object.keys(NETWORKS) as NetworkId[]) {
      await this.platform.storage.delete(`wallet.${id}.${net}`);
      await this.platform.storage.delete(`unfrozen.${id}.${net}`);
      await this.platform.storage.delete(`miner.${id}`);
      await this.platform.storage.delete(`wrapped.${id}`);
      await this.platform.storage.delete(`autosell.${id}`);
      this.accounts.delete(`${id}:${net}`);
    }
    const settings = await this.settings();
    if (settings.activeWalletId === id) return this.switchWallet(contents.wallets[0]!.id);
    return this.state();
  }

  async walletDetails(id: string): Promise<WalletDetails> {
    const contents = await this.vault.read();
    const w = contents.wallets.find((x) => x.id === id);
    if (!w) throw new ServiceError("no-wallet", "That wallet is no longer in Oyster.");
    const net = await this.net();
    const netId = net.id as NetworkId;
    const meta = await this.meta(id, netId);
    let address = meta.firstAddress;
    let path: string | undefined;
    if (w.source.kind === "seed") {
      path = `m/86'/${net.coinType}'/${w.source.account}'`;
      address ??= (await this.account(id, net))!.deriveAddress({ index: 0 }).address;
    } else {
      address = w.source.address;
    }
    return {
      id: w.id,
      name: w.name,
      color: w.color,
      kind: w.source.kind,
      sourceLabel: this.sourceLabel(contents, w),
      address,
      ...(path ? { path } : {}),
      ...(meta.lastBalance ? { balance: meta.lastBalance } : {}),
      removesSeed: this.removesSeed(contents, w),
      isOnly: contents.wallets.length === 1,
      miner: (await this.miner(w.id)).enabled,
    };
  }

  private removesSeed(contents: VaultContents, w: VaultWallet): boolean {
    if (w.source.kind !== "seed") return false;
    const seedId = w.source.seedId;
    return !contents.wallets.some((x) => x.id !== w.id && x.source.kind === "seed" && x.source.seedId === seedId);
  }

  private sourceLabel(contents: VaultContents, w: VaultWallet): string {
    if (w.source.kind === "watch") return "watch only";
    const seedId = w.source.seedId;
    return `seed ${contents.seeds.findIndex((x) => x.id === seedId) + 1}`;
  }

  private async summaries(contents: VaultContents, network: NetworkId): Promise<WalletSummary[]> {
    return Promise.all(
      contents.wallets.map(async (w) => {
        const meta = await this.meta(w.id, network);
        const address = w.source.kind === "watch" ? w.source.address : meta.firstAddress;
        return {
          id: w.id,
          name: w.name,
          color: w.color,
          kind: w.source.kind,
          sourceLabel: this.sourceLabel(contents, w),
          ...(address ? { address } : {}),
          ...(meta.lastBalance ? { balance: meta.lastBalance } : {}),
          miner: (await this.miner(w.id)).enabled,
        };
      }),
    );
  }

  // ---- price ---------------------------------------------------------------

  /** Null rather than an error: without a price the UI just hides fiat. */
  async price(): Promise<PriceView | null> {
    await this.useRelay();
    return (await this.prices.get()) ?? null;
  }

  async wrappedBalance(): Promise<WrappedView | null> {
    const address = await this.wrappedAddress(await this.activeId());
    if (!address) return null;
    await this.useRelay();
    return (await this.prices.wrappedBalance(address)) ?? null;
  }

  async cash(): Promise<CashView | null> {
    await this.useRelay();
    return (await this.prices.cash()) ?? null;
  }

  async depth(): Promise<DepthView | null> {
    await this.useRelay();
    return (await this.prices.depth()) ?? null;
  }

  async marketTrades(): Promise<MarketTrade[] | null> {
    await this.useRelay();
    return (await this.prices.marketTrades()) ?? null;
  }

  async orderQuote(side: "buy" | "sell", of: { amount?: number; spend?: number }): Promise<OrderQuote | null> {
    await this.useRelay();
    return (await this.prices.orderQuote(side, of)) ?? null;
  }

  async openOrders(): Promise<OrdersView | null> {
    await this.useRelay();
    return (await this.prices.openOrders()) ?? null;
  }

  // ---- the account the relay keeps for this wallet -------------------------

  /**
   * Signing in, on demand.
   *
   * There is no sign-in screen and no button. Identity is the wallet's own
   * address and the proof is a signature, so the first call that needs a
   * session makes one, and a locked wallet simply has none. Anything that
   * needs it says so rather than pretending the balance is zero.
   */
  private async asMe(): Promise<{ me: string; sign: (message: string) => Promise<{ address: string; signature: string }> }> {
    const w = await this.activeWallet();
    const net = await this.net();
    const acct = await this.account(w.id, net);
    if (!acct) {
      throw new ServiceError("watch-only", "A watch-only wallet cannot trade. It follows an address but holds no key.");
    }
    const me = acct.deriveAddress({ index: 0 }).address;
    return { me, sign: (message: string) => this.siteSignMessage(message) };
  }

  /** What the relay holds. Null when locked or unreachable, never a zero. */
  async myAccount(): Promise<AccountView | null> {
    await this.useRelay();
    try {
      const { me, sign } = await this.asMe();
      return await this.relayAccount.me(me, sign);
    } catch {
      return null;
    }
  }

  async myOrders(): Promise<MyOrdersView | null> {
    await this.useRelay();
    try {
      const { me, sign } = await this.asMe();
      return await this.relayAccount.orders(me, sign);
    } catch {
      return null;
    }
  }

  /**
   * Places an order.
   *
   * This one throws rather than returning null. A balance that cannot be
   * read is a screen with less on it; an order that did not get placed is
   * something the person has to be told about.
   */
  async placeOrder(side: "buy" | "sell", amount: string, price: string, keep = false): Promise<MyOrder> {
    await this.useRelay();
    const { me, sign } = await this.asMe();
    try {
      return await this.relayAccount.place(me, sign, { side, amount, price, ...(keep ? { keep } : {}) });
    } catch (e) {
      throw this.fromRelay(e);
    }
  }

  /** "Send to my wallet": PRL kept on the exchange is delivered on the relay's next pass. */
  async releasePrl(): Promise<{ released: string }> {
    await this.useRelay();
    const { me, sign } = await this.asMe();
    try {
      return await this.relayAccount.releasePrl(me, sign);
    } catch (e) {
      throw this.fromRelay(e);
    }
  }

  /**
   * Selling PRL that is still in this wallet.
   *
   * One action, three steps. The relay is told what is wanted and answers
   * with the exchange's address; this wallet pays it; the relay is told
   * which payment is bringing it. The selling happens on the relay's side
   * once the exchange has counted the deposit, about half an hour later.
   *
   * The order matters. Asking first means a payment is never sent without
   * something on the other end expecting it, which would be PRL sitting on
   * an exchange with nothing recording why.
   */
  /** Everything that has moved this account's money on the relay. */
  async accountHistory(): Promise<CashEntry[] | null> {
    try {
      await this.useRelay();
      const { me, sign } = await this.asMe();
      return await this.relayAccount.history(me, sign);
    } catch {
      // Null, not empty. A screen that could not ask must say so rather
      // than show somebody an empty history of their own money.
      return null;
    }
  }

  /** How much could be taken out, and on which chains. */
  async withdrawInfo(): Promise<WithdrawInfo | null> {
    try {
      await this.useRelay();
      const { me, sign } = await this.asMe();
      return await this.relayAccount.withdrawInfo(me, sign);
    } catch {
      // Null, not an empty one. A screen that cannot ask must say so
      // rather than show nowhere to send and no money to send.
      return null;
    }
  }

  /**
   * Takes USDT out, to the address it was sent from on that chain.
   *
   * No destination is passed and none can be. The relay looks it up from
   * what this wallet declared, and the signer refuses any address its
   * owner has not declared.
   */
  async withdraw(chain: string, amountMicros: string) {
    await this.useRelay();
    const { me, sign } = await this.asMe();
    try {
      return await this.relayAccount.withdraw(me, sign, chain, amountMicros);
    } catch (e) {
      throw this.fromRelay(e);
    }
  }

  async placeSell(amountGrains: string): Promise<{ txid: string; sellId: number }> {
    await this.useRelay();
    const { me, sign } = await this.asMe();

    let asked: { id: number; sendTo: string };
    try {
      asked = await this.relayAccount.sell(me, sign, amountGrains);
    } catch (e) {
      throw this.fromRelay(e);
    }

    // Paid from this wallet like any other payment, so it goes through the
    // same planning, the same fee policy and the same signing.
    const { txid, claim } = await this.sendAndClaim({ to: asked.sendTo, amount: amountGrains, tier: "normal" }, me);

    // Told afterwards, and not fatal if it fails: when the payment spent
    // from this wallet's own address the relay recognises it by that, and
    // the claim is what places it when coin selection used another one.
    try {
      if (claim) await this.relayAccount.sellSent(me, sign, txid, claim.from, claim.signature);
    } catch {
      /* recognised by its sender, or placed by hand */
    }
    return { txid, sellId: asked.id };
  }

  async cancelMyOrder(id: number): Promise<MyOrder> {
    await this.useRelay();
    const { me, sign } = await this.asMe();
    try {
      return await this.relayAccount.cancel(me, sign, id);
    } catch (e) {
      throw this.fromRelay(e);
    }
  }

  /** The relay's own refusals, kept as they were written. It says why in a
   *  sentence meant for a person, and rewording it here would lose that. */
  private fromRelay(e: unknown): Error {
    if (e instanceof AccountError) return new ServiceError(e.code, e.message);
    return e as Error;
  }

  async orderHistory(): Promise<OrdersView | null> {
    await this.useRelay();
    return (await this.prices.orderHistory()) ?? null;
  }

  /**
   * Where to send USDT on one chain.
   *
   * Only asked for once the wallet has declared an address on that chain,
   * because the deposit lands in the exchange's own account where nothing
   * distinguishes one sender from another. Being told where to send before
   * saying who you are is how a deposit ends up belonging to nobody.
   */
  async depositAddress(chain: CashChainId | typeof PEARL_CHAIN): Promise<DepositAddress> {
    // Pearl is exempt. On that chain the sender is the account, so signing
    // in already told the relay where this wallet sends from and there is
    // nothing left to declare.
    if (chain !== PEARL_CHAIN) {
      const settings = await this.settings();
      if (!(settings.cashAddresses ?? {})[chain]) {
        return { open: false, why: "save the address you will send from first" };
      }
    }
    await this.useRelay();
    try {
      // Through the session, not the operator key. The relay will only
      // hand an address to somebody it can name, because a deposit lands in
      // the exchange's own account and the sender is all there is to go on.
      const { me, sign } = await this.asMe();

      // Declared again, every time, because this is the moment it has to be
      // true. It is cheap and idempotent, and it means a declaration that
      // failed when the address was saved, because the wallet was locked or
      // the relay was unreachable, fixes itself here rather than leaving a
      // deposit screen that never opens and says nothing useful about why.
      if (chain !== PEARL_CHAIN) {
        const saved = (await this.settings()).cashAddresses?.[chain];
        if (saved) {
          try {
            await this.relayAccount.declareSender(me, sign, chain, saved);
          } catch {
            /* it may already be declared, which is the same as success here */
          }
        }
      }
      return await this.relayAccount.depositAddress(me, sign, chain);
    } catch (e) {
      return { open: false, why: (e as Error).message };
    }
  }

  async accountTrades(): Promise<TradesView | null> {
    await this.useRelay();
    return (await this.prices.accountTrades()) ?? null;
  }

  async cancelOrder(id: number): Promise<{ cancelled: boolean }> {
    await this.useRelay();
    try {
      return { cancelled: await this.prices.cancelOrder(id) };
    } catch (e) {
      throw new ServiceError("cancel-failed", (e as Error).message);
    }
  }

  async chart(range: ChartRange): Promise<ChartView | null> {
    await this.useRelay();
    return (await this.prices.chart(range)) ?? null;
  }

  /** For development: point the wallet at a local relay. */
  async setRelayUrl(url: string): Promise<AppState> {
    const trimmed = url.trim().replace(/\/$/, "");
    if (!/^https?:\/\/[^\s]+$/.test(trimmed)) throw new ServiceError("bad-url", "That is not a valid relay address.");
    await this.saveSettings({ ...(await this.settings()), relayUrl: trimmed });
    return this.state();
  }

  /**
   * The key that lets this wallet reach the exchange account on the relay.
   *
   * Operator-only, and deliberately not derived from the seed: it authorises
   * one machine to trade one exchange account, which has nothing to do with
   * owning a Pearl address. An empty string clears it, and the relay then
   * refuses those endpoints, which is the right state for any wallet that is
   * not the operator's.
   */
  async setOperatorKey(secret: string): Promise<AppState> {
    const trimmed = secret.trim();
    // Long enough that guessing it is not a strategy. Generated, not chosen.
    if (trimmed.length > 0 && trimmed.length < 32) {
      throw new ServiceError("bad-setting", "An operator key needs at least 32 characters. Generate one, do not invent one.");
    }
    await this.saveSettings({ ...(await this.settings()), operatorSecret: trimmed });
    await this.useRelay();
    return this.state();
  }

  /**
   * The address this person sends cash from, and gets it back at.
   *
   * One field doing two jobs, which is deliberate: it is how a deposit is
   * recognised as theirs, and it is where a withdrawal goes. Checked here
   * rather than only in the popup, because the popup is a view and this is
   * the thing that decides where money ends up.
   */
  async setCashAddress(chain: CashChainId, address: string): Promise<AppState> {
    const spec = CASH_CHAINS.find((c) => c.id === chain);
    if (!spec) throw new ServiceError("bad-setting", "That is not a chain cash can move on.");

    const settings = await this.settings();
    const next = { ...(settings.cashAddresses ?? {}) };

    const trimmed = address.trim();
    if (trimmed === "") {
      delete next[chain];
    } else {
      // Validated per chain, because an address that is valid somewhere else
      // is still money sent into a hole.
      if (spec.kind === "solana") {
        if (!isSolanaAddress(trimmed)) throw new ServiceError("bad-address", "That is not a Solana address.");
        next[chain] = normalizeSolanaAddress(trimmed);
      } else {
        if (!isEvmAddress(trimmed)) throw new ServiceError("bad-address", `That is not an ${spec.name} address.`);
        next[chain] = normalizeEvmAddress(trimmed);
      }
    }
    await this.saveSettings({ ...settings, cashAddresses: next });

    /**
     * And tell the relay, which is the half that matters.
     *
     * Saved here alone, this address does nothing: the deposit lands in the
     * exchange's own account and the relay has no way to know whose it is.
     * The wallet would show a saved address, the relay would keep saying it
     * had not been told, and the deposit screen would never open.
     *
     * Not fatal if it fails. The address is saved, and asking for a deposit
     * address declares it again, so a wallet that was locked or offline at
     * this moment heals itself rather than staying broken.
     */
    if (trimmed !== "") {
      try {
        const { me, sign } = await this.asMe();
        await this.useRelay();
        await this.relayAccount.declareSender(me, sign, chain, next[chain]!);
      } catch {
        /* declared again when the deposit address is asked for */
      }
    }
    return this.state();
  }

  // ---- for connected sites (window.pearl) ----------------------------------

  /** Whether the vault is unlocked, without touching the auto-lock clock. */
  async isUnlocked(): Promise<boolean> {
    return this.vault.isUnlocked();
  }

  /** The address a site sees: the active wallet's first receive address,
   *  stable across payments. Watch-only wallets cannot be connected. */
  async siteAccount(): Promise<{ address: string; publicKey: string; walletName: string; network: NetworkId }> {
    const w = await this.activeWallet();
    const net = await this.net();
    const acct = await this.account(w.id, net);
    if (!acct) {
      throw new ServiceError("watch-only", "The active wallet is watch-only. Switch to a wallet with keys to connect.");
    }
    const d = acct.deriveAddress({ index: 0 });
    return { address: d.address, publicKey: hexOf(d.pubkey), walletName: w.name, network: net.id as NetworkId };
  }

  async siteBalance(): Promise<{ confirmed: bigint; unconfirmed: bigint }> {
    const l = await this.load(false, FRESH_MS);
    return { confirmed: l.scan.confirmed, unconfirmed: l.scan.unconfirmed };
  }

  /** Plan a site-requested payment for the approval screen. `feeRate` from the
   *  site is clamped to sane bounds; without one, the normal tier is used. */
  async quoteSiteSend(to: string, amount: bigint, feeRate?: number): Promise<SendQuote & { inputs: number; outputs: number }> {
    const l = await this.load(false, FRESH_MS);
    const rate = clampRate(feeRate ?? (await this.feeOptions()).rates.normal);
    const plan = this.plan(l, { to, amount: amount.toString(), tier: "normal" }, rate);
    return { ...quote(plan, rate), inputs: plan.inputs.length, outputs: plan.change ? 2 : 1 };
  }

  /** Re-plans from a fresh scan at approval time, like the wallet's own send. */
  async siteSend(to: string, amount: bigint, feeRate: number): Promise<string> {
    const l = await this.load(true);
    const plan = this.plan(l, { to, amount: amount.toString(), tier: "normal" }, clampRate(feeRate));
    const signed = signPlan(plan, signer(l), l.owned, l.net);
    const txid = await this.client(l.net).broadcast(signed.hex);
    if (txid !== signed.txid) throw new ServiceError("txid-mismatch", `node reported ${txid}, expected ${signed.txid}`);
    this.loaded = null;
    return txid;
  }

  async siteSignMessage(message: string): Promise<{ address: string; signature: string }> {
    const w = await this.activeWallet();
    const net = await this.net();
    const acct = await this.account(w.id, net);
    if (!acct) throw new ServiceError("watch-only", "The active wallet is watch-only and cannot sign.");
    const d = acct.deriveAddress({ index: 0 });
    const key = acct.privateKey({ index: 0 });
    try {
      return { address: d.address, signature: signMessageBip322(message, d.address, key, d.pubkey, net) };
    } finally {
      key.fill(0);
    }
  }

  /** Decodes bytes a site wants broadcast, marking which outputs are ours. */
  async describeRaw(rawHex: string): Promise<RawTxSummary> {
    const l = await this.load(false, FRESH_MS);
    const d = describeRawTx(rawHex, l.net);
    return {
      txid: d.txid,
      vsize: d.vsize,
      inputs: d.inputs,
      outputs: d.outputs.map((o) => ({
        ...(o.address ? { address: o.address } : {}),
        value: o.value.toString(),
        mine: o.address !== undefined && l.owned.has(o.address),
      })),
      total: d.total.toString(),
    };
  }

  async sitePushTx(rawHex: string): Promise<string> {
    return this.client(await this.net()).broadcast(rawHex.trim());
  }

  /**
   * Points the relay client at the configured server, with the operator key
   * if this wallet has one.
   *
   * Both come from settings and both have to be set before any relay call,
   * so they are read together rather than left to be remembered separately
   * at a dozen call sites.
   */
  private async useRelay(): Promise<void> {
    const s = await this.settings();
    this.prices.setBase(s.relayUrl ?? DEFAULT_RELAY);
    this.prices.setOperatorSecret(s.operatorSecret ?? "");
    this.relayAccount.setBase(s.relayUrl ?? DEFAULT_RELAY);
  }

  // ---- price alerts --------------------------------------------------------

  /**
   * Alerts are not per wallet: the price is the price, whichever wallet is
   * open. They are checked on the same timer that looks for payments, so a
   * wallet nobody has opened all day still says something when PRL moves.
   */
  async priceAlerts(): Promise<PriceAlert[]> {
    const raw = await this.platform.storage.get("alerts");
    return raw ? (JSON.parse(raw) as PriceAlert[]) : [];
  }

  async addPriceAlert(direction: "above" | "below", price: number): Promise<PriceAlert[]> {
    if (!Number.isFinite(price) || price <= 0) throw new ServiceError("bad-setting", "That is not a price.");
    const alerts = await this.priceAlerts();
    if (alerts.filter((a) => a.firedAt === undefined).length >= MAX_ALERTS) {
      throw new ServiceError("too-many", `${MAX_ALERTS} alerts at a time is plenty. Remove one first.`);
    }
    const alert: PriceAlert = {
      id: Math.random().toString(36).slice(2, 10),
      direction,
      price,
      created: Math.floor(this.platform.clock.now() / 1000),
    };
    const next = [alert, ...alerts];
    await this.platform.storage.set("alerts", JSON.stringify(next));
    return next;
  }

  async removePriceAlert(id: string): Promise<PriceAlert[]> {
    const next = (await this.priceAlerts()).filter((a) => a.id !== id);
    await this.platform.storage.set("alerts", JSON.stringify(next));
    return next;
  }

  /** Fires any alert the price has crossed. Called on the watch timer. */
  private async checkPriceAlerts(): Promise<void> {
    const alerts = await this.priceAlerts();
    const waiting = alerts.filter((a) => a.firedAt === undefined);
    if (waiting.length === 0) return;
    await this.useRelay();
    const price = await this.prices.get();
    if (!price) return;
    const now = Math.floor(this.platform.clock.now() / 1000);
    let fired = false;
    for (const a of waiting) {
      const crossed = a.direction === "above" ? price.usdPerPrl >= a.price : price.usdPerPrl <= a.price;
      if (!crossed) continue;
      a.firedAt = now;
      fired = true;
      await this.platform.alerts?.notify(
        "PRL price alert",
        `PRL is ${a.direction} ${a.price} USDT. It is ${price.usdPerPrl.toFixed(4)} now.`,
      );
    }
    if (fired) await this.platform.storage.set("alerts", JSON.stringify(alerts));
  }

  // ---- watching for payments ----------------------------------------------

  /**
   * Looks for PRL that arrived while nobody was watching, and says so.
   *
   * Only runs while the wallet is unlocked, because the addresses to look at
   * come out of the vault. The badge counts payments still waiting for a
   * block, so an empty badge means nothing is in flight.
   */
  /** Everything the two-minute timer does, each guarded from the other. */
  async onWatchTimer(): Promise<void> {
    await this.checkPriceAlerts().catch(() => {});
    await this.checkFilledOrders().catch(() => {});
    await this.checkForPayments().catch(() => {});
  }

  /**
   * Says when an order has stopped waiting.
   *
   * A market order fills in seconds and nobody needs telling. A limit order
   * can sit for days, and the whole point of leaving one is that you are not
   * watching. Only the ids are remembered, so this cannot announce the same
   * fill twice, and it stays quiet on the first run like the payment watcher.
   */
  private async checkFilledOrders(): Promise<void> {
    const before = await this.platform.storage.get("orders.open");
    const view = await this.openOrders();
    if (!view?.open) return;
    const now = view.orders.map((o) => o.id);
    await this.platform.storage.set("orders.open", JSON.stringify(now));
    if (before === null) return; // first look: record, do not announce
    const was = JSON.parse(before) as number[];
    const gone = was.filter((id) => !now.includes(id));
    if (gone.length === 0) return;
    // Gone from the waiting list means filled or cancelled. The history says
    // which, and saying the wrong one would be worse than saying nothing.
    const done = (await this.orderHistory())?.orders ?? [];
    for (const id of gone.slice(0, 3)) {
      const o = done.find((x) => x.id === id);
      if (!o) continue;
      if (o.state === "cancel") continue; // they cancelled it; they know
      const amount = o.filled_amount ?? o.origin_amount;
      await this.platform.alerts?.notify(
        o.side === "buy" ? "Buy filled" : "Sell filled",
        `${amount} PRL${o.price ? ` at ${o.price} USDT` : ""}.`,
      );
    }
  }

  async checkForPayments(): Promise<void> {
    // Which wallet is active is kept in plain settings, so it can be read
    // while the vault is sealed. Asking activeWallet() here would read the
    // vault and throw, which is the one case this whole method exists for.
    const settings = await this.settings();
    const unlocked = await this.vault.isUnlocked();
    const id = settings.activeWalletId ?? (unlocked ? await this.activeId() : undefined);
    if (!id) return;
    const net = (settings.network ?? "mainnet") as NetworkId;
    const key = `seen.${id}.${net}`;
    const raw = await this.platform.storage.get(key);
    const seen = new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);

    let found: { txid: string; amount: bigint; confirmed: boolean; coinbase: boolean }[];
    let pending: number;
    try {
      const view = unlocked ? await this.watchUnlocked() : await this.watchLocked(id, net);
      if (!view) return;
      found = view.incoming;
      pending = view.pending;
    } catch {
      return; // network trouble is not worth a notification
    }

    // First run on a wallet only records what is already there: nobody wants
    // a notification for every payment they have ever had.
    if (raw === null) {
      await this.platform.storage.set(key, JSON.stringify(found.slice(0, 200).map((t) => t.txid)));
      return;
    }

    const fresh = found.filter((t) => !seen.has(t.txid));
    for (const t of fresh.slice(0, 3)) {
      await this.platform.alerts?.notify(
        t.coinbase ? "Mining reward" : "PRL received",
        `${formatPrl(t.amount)} PRL ${t.confirmed ? "confirmed" : "is on its way"}.`,
      );
    }
    if (fresh.length > 3) {
      await this.platform.alerts?.notify("PRL received", `${fresh.length} payments arrived.`);
    }
    if (fresh.length > 0) {
      const keep = [...found.map((t) => t.txid), ...seen].slice(0, 200);
      await this.platform.storage.set(key, JSON.stringify(keep));
    }
    await this.platform.alerts?.badge(pending > 0 ? String(pending) : "");
  }

  /** Unlocked: a normal scan, which also refreshes the watch list. */
  private async watchUnlocked() {
    const l = await this.load(true);
    const incoming = l.txs
      .filter((t) => t.direction === "received")
      .map((t) => ({ txid: t.txid, amount: t.net > 0n ? t.net : -t.net, confirmed: t.confirmations > 0, coinbase: t.coinbase }));
    return { incoming, pending: l.txs.filter((t) => t.confirmations === 0).length };
  }

  /**
   * Locked: the seed is sealed, so the addresses come from a list written
   * down at the last scan.
   *
   * Addresses are public: one cannot authorise anything, and knowing them
   * does not help anyone spend. What the list does reveal, to somebody who
   * can already read this browser profile, is that these addresses belong to
   * one wallet. That is the price of being told about a payment while the
   * wallet is locked, which for a mining wallet is most of the time.
   */
  private async watchLocked(id: string, net: NetworkId) {
    const raw = await this.platform.storage.get(`addrs.${id}.${net}`);
    if (!raw) return null; // never scanned unlocked, so nothing to watch yet
    const addresses = (JSON.parse(raw) as string[]).slice(0, WATCH_ADDRESS_LIMIT);
    if (addresses.length === 0) return null;
    const client = this.client(NETWORKS[net]);
    const incoming: { txid: string; amount: bigint; confirmed: boolean; coinbase: boolean }[] = [];
    const ours = new Set(addresses);
    let pending = 0;
    const seenTx = new Set<string>();

    // One page per address is enough: anything older than 25 transactions is
    // not news. Paced by the client, which is why this is not parallel.
    for (const address of addresses) {
      const page = await client.transactions(address, { pageSize: 25 });
      for (const tx of page.txs) {
        if (seenTx.has(tx.txid)) continue;
        seenTx.add(tx.txid);
        if (tx.confirmations === 0) pending++;
        // Value in, minus value out: positive means it paid this wallet.
        const inOurs = tx.vin.reduce((t, v) => t + (v.addresses.some((a) => ours.has(a)) ? v.value : 0n), 0n);
        const outOurs = tx.vout.reduce((t, v) => t + (v.addresses.some((a) => ours.has(a)) ? v.value : 0n), 0n);
        const net_ = outOurs - inOurs;
        if (net_ > 0n) {
          incoming.push({ txid: tx.txid, amount: net_, confirmed: tx.confirmations > 0, coinbase: tx.vin.some((v) => v.coinbase) });
        }
      }
    }
    incoming.sort((a, b) => (a.txid < b.txid ? -1 : 1));
    return { incoming, pending };
  }

  /** Written after every scan, so a locked wallet still knows where to look:
   *  the addresses that have been used, plus the next one of each kind. */
  private async rememberWatchList(id: string, net: NetworkId, l: Loaded): Promise<void> {
    const addresses = l.watch
      ? [l.watch]
      : [
          ...l.scan.used.map((u) => u.derived.address),
          ...(l.acct ? [l.acct.deriveAddress({ index: l.scan.nextReceiveIndex }).address] : []),
          ...(l.acct ? [l.acct.deriveAddress({ index: l.scan.nextChangeIndex, change: true }).address] : []),
        ];
    const unique = [...new Set(addresses)].slice(0, WATCH_ADDRESS_LIMIT);
    await this.platform.storage.set(`addrs.${id}.${net}`, JSON.stringify(unique));
  }

  // ---- mining --------------------------------------------------------------

  /** Miner mode pays out to the wallet's own address. Pinned on the first
   *  enable so an older wallet that pinned a different index keeps it. */
  async setMinerMode(enabled: boolean): Promise<AppState> {
    const id = await this.activeId();
    const cur = await this.miner(id);
    if (enabled && cur.payoutIndex === undefined) cur.payoutIndex = 0;
    await this.platform.storage.set(`miner.${id}`, JSON.stringify({ ...cur, enabled }));
    return this.state();
  }

  /**
   * Auto-sell settings, per wallet.
   *
   * Only the settings live here. The selling itself needs two things this
   * wallet cannot fake: an exchange connection, and the keys, because a sell
   * starts with a Pearl transaction this wallet has to sign. So it can only
   * ever run while the wallet is unlocked, and the screen says so rather
   * than letting someone believe payouts are being sold while they sleep.
   */
  async autoSell(): Promise<AutoSell> {
    const raw = await this.platform.storage.get(`autosell.${await this.activeId()}`);
    const saved = raw ? (JSON.parse(raw) as Partial<AutoSell>) : {};
    return {
      enabled: saved.enabled === true,
      threshold: saved.threshold ?? DEFAULT_AUTOSELL_THRESHOLD.toString(),
      percent: typeof saved.percent === "number" ? saved.percent : 100,
      ...(saved.lastRun ? { lastRun: saved.lastRun } : {}),
    };
  }

  async setAutoSell(enabled: boolean, threshold: string, percent: number): Promise<AutoSell> {
    let grains: bigint;
    try {
      grains = BigInt(threshold);
    } catch {
      throw new ServiceError("bad-setting", "That is not an amount.");
    }
    if (grains < MIN_AUTOSELL_THRESHOLD) {
      throw new ServiceError(
        "bad-setting",
        `Sell at ${formatPrl(MIN_AUTOSELL_THRESHOLD)} PRL or more. Smaller amounts cost more in fees than they are worth.`,
      );
    }
    if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
      throw new ServiceError("bad-setting", "Sell between 1 and 100 percent of what is mined.");
    }
    const current = await this.autoSell();
    const next: AutoSell = { ...current, enabled, threshold: grains.toString(), percent };
    await this.platform.storage.set(`autosell.${await this.activeId()}`, JSON.stringify(next));
    return next;
  }

  async miningView(tzOffsetMinutes: number, refresh = false): Promise<MiningView> {
    const id = await this.activeId();
    const miner = await this.miner(id);
    const nowSec = Math.floor(this.platform.clock.now() / 1000);
    const weekAgo = nowSec - 7 * 86_400;
    // Pull history until it reaches back a week, within a budget: a busy solo
    // miner can earn hundreds of rewards a day.
    const oldest = (x: { txs: WalletTx[] }) =>
      x.txs.reduce((m, t) => (t.time > 0 && t.time < m ? t.time : m), Number.POSITIVE_INFINITY);
    const l = await this.load(refresh);
    let history = { txs: l.txs, complete: l.historyComplete };
    if (miner.enabled && !history.complete && oldest(history) > weekAgo) {
      // Big pages, stopping per address once a week back is reached.
      history = await accountHistory(l.scan, this.client(l.net), {
        pageSize: MINING_PAGE_SIZE,
        maxPages: MINING_MAX_PAGES,
        stopBefore: weekAgo,
      });
    }
    const stats = miningStats(history.txs, { nowSec, tzOffsetMinutes });
    const coveredSince = !history.complete && oldest(history) > weekAgo ? oldest(history) : undefined;
    const payoutAddress = l.watch
      ?? (l.acct && miner.payoutIndex !== undefined ? l.acct.deriveAddress({ index: miner.payoutIndex }).address : undefined);
    return {
      enabled: miner.enabled,
      walletId: id,
      ...(payoutAddress ? { payoutAddress } : {}),
      today: { total: stats.today.total.toString(), count: stats.today.count },
      days: stats.days.map((d) => ({ start: d.start, total: d.total.toString(), count: d.count })),
      last7: stats.last7.toString(),
      // Averaging a partial week over 7 days would understate it: divide by
      // the time actually covered instead.
      dailyAverage: (coveredSince !== undefined
        ? (stats.last7 * 86_400n) / BigInt(Math.max(3_600, nowSec - coveredSince))
        : stats.dailyAverage
      ).toString(),
      payouts: stats.payouts.map((p) => ({ ...p, amount: p.amount.toString() })),
      historyComplete: history.complete,
      ...(coveredSince !== undefined ? { coveredSince } : {}),
    };
  }

  private async miner(id: string): Promise<{ enabled: boolean; payoutIndex?: number }> {
    const raw = await this.platform.storage.get(`miner.${id}`);
    return raw ? JSON.parse(raw) : { enabled: false };
  }

  // ---- reading -------------------------------------------------------------

  /**
   * A fresh scan for a timer, not a person: it does not hold off auto-lock.
   * The wallet screen calls this every two minutes while it is open.
   */
  async walletViewQuietly(): Promise<WalletView> {
    return this.vault.quietly(() => this.walletView(true));
  }

  async walletView(refresh = false): Promise<WalletView> {
    const l = await this.load(refresh);
    // One wallet, one address. Index 0 is what the owner sees on Receive, what
    // a pool is paid at, and what a connected site is told, so it never moves
    // under them. Higher indices are still scanned, so anything already
    // received at one stays visible and spendable.
    const receiveAddress = l.acct ? l.acct.deriveAddress({ index: 0 }).address : l.watch!;
    const wrapped = await this.wrapped(await this.activeId());
    const sum = (f: (u: ProtectedUtxo) => boolean) => l.utxos.filter(f).reduce((s, u) => s + u.value, 0n);
    return {
      walletId: await this.activeId(),
      network: l.net.id as NetworkId,
      confirmed: l.scan.confirmed.toString(),
      unconfirmed: l.scan.unconfirmed.toString(),
      spendable: sum((u) => !u.frozen && !u.immature && u.confirmations > 0).toString(),
      immature: sum((u) => u.immature).toString(),
      receiveAddress,
      ...(wrapped ? { wrappedAddress: wrapped.address, wrappedInTotal: wrapped.inTotal } : {}),
      watchOnly: !l.acct,
      protectedCount: l.utxos.filter((u) => u.freezeReason).length,
      txs: l.txs.map(wireTx),
      historyComplete: l.historyComplete,
      scannedAt: l.scannedAt,
    };
  }

  /** Wrapped PRL lives on Ethereum, where Oyster holds no keys. It watches
   *  one address per wallet and never signs for it. */
  async setWrappedAddress(address: string | null): Promise<{ address?: string }> {
    const id = await this.activeId();
    if (address === null) {
      await this.platform.storage.delete(`wrapped.${id}`);
      return {};
    }
    let checksummed: string;
    try {
      checksummed = normalizeEvmAddress(address);
    } catch (e) {
      throw new ServiceError("bad-address", (e as Error).message);
    }
    const cur = await this.wrapped(id);
    await this.platform.storage.set(`wrapped.${id}`, JSON.stringify({ address: checksummed, inTotal: cur?.inTotal ?? false }));
    return { address: checksummed };
  }

  /** Stored as JSON. Older installs kept a bare address string. */
  private async wrapped(id: string): Promise<{ address: string; inTotal: boolean } | undefined> {
    const raw = await this.platform.storage.get(`wrapped.${id}`);
    if (!raw) return undefined;
    if (!raw.startsWith("{")) return { address: raw, inTotal: false };
    const p = JSON.parse(raw) as { address: string; inTotal?: boolean };
    return { address: p.address, inTotal: p.inTotal === true };
  }

  private async wrappedAddress(id: string): Promise<string | undefined> {
    return (await this.wrapped(id))?.address;
  }

  /** Whether wPRL counts towards the portfolio total. Off until asked for:
   *  it is a different chain, and some owners want the two kept apart. */
  async setWrappedInTotal(include: boolean): Promise<{ include: boolean }> {
    const id = await this.activeId();
    const cur = await this.wrapped(id);
    if (!cur) throw new ServiceError("no-address", "Watch an Ethereum address first.");
    await this.platform.storage.set(`wrapped.${id}`, JSON.stringify({ address: cur.address, inTotal: include }));
    return { include };
  }

  // ---- coins, keys, notes, history ----------------------------------------

  /** Every coin the wallet holds, newest first. What "coin control" acts on. */
  async coins(): Promise<Coin[]> {
    const l = await this.load(false, FRESH_MS);
    return [...l.utxos]
      .sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0))
      .map((u) => ({
        outpoint: `${u.txid}:${u.vout}`,
        txid: u.txid,
        vout: u.vout,
        address: u.address,
        value: u.value.toString(),
        confirmations: u.confirmations,
        coinbase: u.coinbase,
        immature: u.immature,
        frozen: u.frozen,
        ...(u.freezeReason ? { freezeReason: u.freezeReason } : {}),
      }));
  }

  /** The account's public key. It watches, it cannot spend, and it shows
   *  every address this wallet will ever use, so it is still private. */
  async exportXpub(walletId?: string): Promise<{ xpub: string; path: string }> {
    const contents = await this.vault.read();
    const w = walletId ? contents.wallets.find((x) => x.id === walletId) : await this.activeWallet();
    if (!w) throw new ServiceError("no-wallet", "That wallet is no longer in Oyster.");
    if (w.source.kind !== "seed") {
      throw new ServiceError("watch-only", "A watch-only wallet follows one address and has no account key.");
    }
    const net = await this.net();
    const acct = await this.account(w.id, net);
    if (!acct) throw new ServiceError("watch-only", "This wallet has no account key.");
    return { xpub: acct.xpub, path: `m/86'/${net.coinType}'/${w.source.account}'` };
  }

  /** A note against a transaction, kept per wallet and network. */
  async txNotes(): Promise<Record<string, string>> {
    const id = await this.activeId();
    const net = await this.net();
    const raw = await this.platform.storage.get(`notes.${id}.${net.id}`);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  }

  async txNote(txid: string, note: string): Promise<Record<string, string>> {
    const id = await this.activeId();
    const net = await this.net();
    const notes = await this.txNotes();
    const trimmed = note.trim().slice(0, 200);
    if (trimmed) notes[txid] = trimmed;
    else delete notes[txid];
    await this.platform.storage.set(`notes.${id}.${net.id}`, JSON.stringify(notes));
    return notes;
  }

  /** The whole history as a spreadsheet, for accountants and tax years. */
  async historyCsv(): Promise<{ file: string; name: string }> {
    const l = await this.load(false, FRESH_MS);
    const notes = await this.txNotes();
    const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const rows = [["date", "txid", "direction", "amount_prl", "fee_prl", "confirmations", "counterparty", "note"].join(",")];
    for (const t of l.txs) {
      rows.push(
        [
          t.time > 0 ? new Date(t.time * 1000).toISOString() : "",
          t.txid,
          t.coinbase ? "mined" : t.direction,
          formatPrl(t.net),
          formatPrl(t.fee),
          String(t.confirmations),
          t.counterparty ?? "",
          notes[t.txid] ?? "",
        ]
          .map((c) => esc(String(c)))
          .join(","),
      );
    }
    const name = `oyster-history-${new Date().toISOString().slice(0, 10)}.csv`;
    return { file: rows.join("\n"), name };
  }

  // ---- address book --------------------------------------------------------

  /** Recipients, most recently paid first. Kept per network: a mainnet
   *  address means nothing on testnet. */
  async addressBook(): Promise<Contact[]> {
    return this.readBook(await this.net());
  }

  async saveContact(address: string, label: string): Promise<Contact[]> {
    const net = await this.net();
    decodeAddress(address, net); // throws AddressError for a bad one
    const book = await this.readBook(net);
    const trimmed = label.trim().slice(0, 40);
    const found = book.find((c) => c.address === address);
    if (found) {
      if (trimmed) found.label = trimmed;
      else delete found.label;
    } else {
      book.unshift({ address, ...(trimmed ? { label: trimmed } : {}), lastUsed: Math.floor(this.platform.clock.now() / 1000), count: 0 });
    }
    return this.writeBook(net, book);
  }

  async forgetContact(address: string): Promise<Contact[]> {
    const net = await this.net();
    return this.writeBook(net, (await this.readBook(net)).filter((c) => c.address !== address));
  }

  /** Called after a send goes out, so the list is a record of what happened
   *  rather than of what was typed. */
  private async rememberRecipient(address: string, net: PearlNetwork): Promise<void> {
    const book = await this.readBook(net);
    const found = book.find((c) => c.address === address);
    const now = Math.floor(this.platform.clock.now() / 1000);
    if (found) {
      found.lastUsed = now;
      found.count += 1;
    } else {
      book.unshift({ address, lastUsed: now, count: 1 });
    }
    await this.writeBook(net, book);
  }

  private async readBook(net: PearlNetwork): Promise<Contact[]> {
    const raw = await this.platform.storage.get(`book.${net.id}`);
    const book = raw ? (JSON.parse(raw) as Contact[]) : [];
    return book.sort((a, b) => b.lastUsed - a.lastUsed);
  }

  private async writeBook(net: PearlNetwork, book: Contact[]): Promise<Contact[]> {
    // Named entries are kept; unnamed ones are only a recent list.
    const named = book.filter((c) => c.label);
    const recent = book.filter((c) => !c.label).slice(0, 10);
    const keep = [...named, ...recent].sort((a, b) => b.lastUsed - a.lastUsed);
    await this.platform.storage.set(`book.${net.id}`, JSON.stringify(keep));
    return keep;
  }

  async validateAddress(address: string): Promise<{ valid: boolean; error?: string }> {
    try {
      decodeAddress(address, await this.net());
      return { valid: true };
    } catch (e) {
      return { valid: false, error: (e as Error).message };
    }
  }

  async feeOptions(): Promise<{ rates: Record<EstimatedTier, number> }> {
    const client = this.client(await this.net());
    const [fast, normal, slow] = await Promise.all([
      client.feeRate(FEE_TARGETS.fast),
      client.feeRate(FEE_TARGETS.normal),
      client.feeRate(FEE_TARGETS.slow),
    ]);
    // Estimates can come back inverted on a thin mempool; keep tiers ordered.
    return { rates: { fast, normal: Math.min(normal, fast), slow: Math.min(slow, normal, fast) } };
  }

  async txStatus(txid: string): Promise<{ confirmations: number; found: boolean }> {
    try {
      const tx = await this.client(await this.net()).transaction(txid);
      return { confirmations: tx.confirmations, found: true };
    } catch {
      return { confirmations: 0, found: false };
    }
  }

  // ---- spending ------------------------------------------------------------

  /** The rate a send will actually pay. A custom rate is the user's own
   *  number, checked against what the node will relay and what this wallet
   *  is willing to burn, so a slipped digit cannot pay a fortune in fees. */
  private async rateFor(tier: FeeTier, rate?: number): Promise<number> {
    if (tier !== "custom") return (await this.feeOptions()).rates[tier];
    if (rate === undefined || !Number.isFinite(rate)) {
      throw new ServiceError("bad-fee", "Enter a fee rate in sat/vB.");
    }
    if (rate < MIN_RELAY_SAT_PER_VB) {
      throw new ServiceError("bad-fee", `The network will not relay below ${MIN_RELAY_SAT_PER_VB} sat/vB.`);
    }
    if (rate > MAX_FEE_RATE) {
      throw new ServiceError("bad-fee", `${rate} sat/vB is far above anything Pearl needs. The most Oyster will pay is ${MAX_FEE_RATE}.`);
    }
    return rate;
  }

  async quoteSend(args: SendArgs): Promise<SendQuote> {
    const l = await this.load(false, FRESH_MS);
    const rate = await this.rateFor(args.tier, args.rate);
    return quote(this.plan(l, args, rate), rate);
  }

  /** What a Max send would actually pay out, so the amount field can show it
   *  before a recipient is typed. Every Pearl address is a taproot output of
   *  the same size, so the fee does not depend on who it goes to: planning
   *  against the wallet's own address gives the same number. */
  async maxSpend(tier: FeeTier, customRate?: number): Promise<{ amount: string; fee: string }> {
    const l = await this.load(false, FRESH_MS);
    const rate = await this.rateFor(tier, customRate);
    const to = l.acct ? l.acct.deriveAddress({ index: 0 }).address : l.watch!;
    const plan = this.plan(l, { to, max: true, tier }, rate);
    const q = quote(plan, rate);
    return { amount: q.amount, fee: q.fee };
  }

  /** Re-plans from a fresh scan rather than trusting a quote from the popup. */
  async send(args: SendArgs): Promise<{ txid: string; quote: SendQuote }> {
    const { txid, quote } = await this.sendAndClaim(args);
    return { txid, quote };
  }

  /**
   * A send, plus a claim on it: a signature by an address it spent from.
   *
   * The relay credits a sell's payment to whoever proves they made it, and
   * a txid alone proves nothing because anybody can read one off the chain.
   */
  private async sendAndClaim(
    args: SendArgs,
    claimFor?: string,
  ): Promise<{ txid: string; quote: SendQuote; claim?: { from: string; signature: string } }> {
    const l = await this.load(true);
    const rate = await this.rateFor(args.tier, args.rate);
    const plan = this.plan(l, args, rate);
    const signed = signPlan(plan, signer(l), l.owned, l.net);
    const txid = await this.client(l.net).broadcast(signed.hex);
    if (txid !== signed.txid) {
      throw new ServiceError("txid-mismatch", `node reported ${txid}, expected ${signed.txid}`);
    }
    await this.rememberRecipient(args.to, l.net);
    // Change goes to the next change index; make sure later scans cover it.
    const id = await this.activeId();
    const net = l.net.id as NetworkId;
    const meta = await this.meta(id, net);
    await this.saveMeta(id, net, {
      ...meta,
      knownUsed: { ...meta.knownUsed, change: Math.max(meta.knownUsed.change, l.scan.nextChangeIndex) },
      // Shown until the indexer reports it. A payment that has left but
      // appears nowhere reads as a payment that was lost.
      broadcast: [
        ...(meta.broadcast ?? []),
        {
          txid,
          net: (-(plan.amount + plan.fee)).toString(),
          fee: plan.fee.toString(),
          to: plan.to,
          at: Math.floor(this.platform.clock.now() / 1000),
        },
      ],
    });
    // Signed before `loaded` is dropped, while the keys are to hand.
    const claim = claimFor ? claimWith(l, claimFor, txid, plan.inputs[0]!.address) : undefined;
    this.loaded = null;
    return { txid, quote: quote(plan, rate), ...(claim ? { claim } : {}) };
  }

  /** Quote for replacing a stuck send at a higher fee. Never below what the
   *  node requires: above the old rate, and at least the next-block estimate
   *  or 1.5x the old rate, whichever is higher. */
  async quoteSpeedUp(txid: string): Promise<SpeedUpQuote> {
    const { plan } = await this.bumpPlan(txid);
    return { txid, oldFee: plan.oldFee.toString(), newFee: plan.fee.toString(), feeRate: Number(plan.fee) / plan.vsize, addsInput: plan.inputs.length };
  }

  async speedUp(txid: string): Promise<{ txid: string; quote: SpeedUpQuote }> {
    const { plan, l } = await this.bumpPlan(txid, true);
    const signed = signPlan(plan, signer(l), l.owned, l.net);
    const newTxid = await this.client(l.net).broadcast(signed.hex);
    if (newTxid !== signed.txid) {
      throw new ServiceError("txid-mismatch", `node reported ${newTxid}, expected ${signed.txid}`);
    }
    await this.rememberBroadcast(
      { txid: newTxid, net: (-(plan.amount + plan.fee)).toString(), fee: plan.fee.toString(), to: plan.to },
      txid,
    );
    // The claim is signed while the keys are loaded, by an input this
    // replacement actually spends, so the relay can check it against the chain.
    const from = plan.inputs[0]!.address;
    await this.tellRelayOfReplacement(txid, newTxid, (me) => claimWith(l, me, newTxid, from));
    this.loaded = null;
    return {
      txid: newTxid,
      quote: { txid, oldFee: plan.oldFee.toString(), newFee: plan.fee.toString(), feeRate: Number(plan.fee) / plan.vsize, addsInput: plan.inputs.length },
    };
  }

  /**
   * Tells the relay that the payment carrying a sell has been replaced.
   *
   * A bump is a different transaction with a different id, and the old one
   * is evicted the moment the replacement confirms. The relay was told the
   * original, and without this it waits on a transaction that no longer
   * exists: the PRL arrives under an id it does not recognise, from a
   * change address nobody declared, so the deposit lands belonging to
   * nobody and the sell is never placed. That is not theoretical. It
   * happened on 2026-09-23 and took a hand-written command to unstick.
   *
   * Only when the relay is actually waiting on the transaction being
   * replaced, so an ordinary bump of an ordinary payment says nothing.
   *
   * Never fatal. The bump itself has already happened and succeeded, and
   * failing here must not turn a completed send into an error on screen.
   * The cost of it failing is the same manual fix as before.
   */
  private async tellRelayOfReplacement(
    oldTxid: string,
    newTxid: string,
    claim: (me: string) => { from: string; signature: string },
  ): Promise<void> {
    await tellRelayReplaced(await this.sellWatcher(claim), oldTxid, newTxid);
  }

  /**
   * The relay, bound to this wallet, or nothing when it cannot be reached.
   *
   * Nothing is an ordinary answer: the wallet may be locked, or the relay
   * down, and neither is a reason to fail the send that has already
   * happened.
   */
  private async sellWatcher(
    claim?: (me: string) => { from: string; signature: string },
  ): Promise<SellWatcher | undefined> {
    try {
      await this.useRelay();
      const { me, sign } = await this.asMe();
      return {
        me: () => this.relayAccount.me(me, sign),
        sellSent: async (txid: string) => {
          if (!claim) throw new ServiceError("no-claim", "Nothing to prove that payment with.");
          const c = claim(me);
          await this.relayAccount.sellSent(me, sign, txid, c.from, c.signature);
        },
        abandonSell: () => this.relayAccount.abandonSell(me, sign),
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Tells the relay to give up on a sell whose payment was cancelled.
   *
   * A cancel replaces the payment with one paying this wallet, so the PRL
   * never reaches the exchange at all. The relay would otherwise wait for
   * it for ever, and because only one sell may wait at a time, that locks
   * this wallet out of selling until somebody clears it by hand.
   *
   * Only when the relay is waiting on the transaction being cancelled, so
   * cancelling an ordinary payment says nothing.
   */
  private async tellRelayOfCancel(oldTxid: string): Promise<void> {
    await tellRelayCancelled(await this.sellWatcher(), oldTxid);
  }

  /** Cancel: the same replacement machinery, paying yourself instead. */
  async quoteCancel(txid: string): Promise<CancelQuote> {
    const { plan } = await this.bumpPlan(txid, false, true);
    return {
      txid,
      oldFee: plan.oldFee.toString(),
      newFee: plan.fee.toString(),
      returned: plan.amount.toString(),
      to: plan.to,
    };
  }

  async cancelSend(txid: string): Promise<{ txid: string; quote: CancelQuote }> {
    const { plan, l } = await this.bumpPlan(txid, true, true);
    const signed = signPlan(plan, signer(l), l.owned, l.net);
    const newTxid = await this.client(l.net).broadcast(signed.hex);
    if (newTxid !== signed.txid) {
      throw new ServiceError("txid-mismatch", `node reported ${newTxid}, expected ${signed.txid}`);
    }
    // A cancel pays this wallet, so nothing leaves but the fee.
    await this.rememberBroadcast(
      { txid: newTxid, net: (-plan.fee).toString(), fee: plan.fee.toString(), to: plan.to },
      txid,
    );
    await this.tellRelayOfCancel(txid);
    this.loaded = null;
    return {
      txid: newTxid,
      quote: { txid, oldFee: plan.oldFee.toString(), newFee: plan.fee.toString(), returned: plan.amount.toString(), to: plan.to },
    };
  }

  private async bumpPlan(txid: string, refresh = false, cancel = false) {
    const l = await this.load(refresh, FRESH_MS);
    const client = this.client(l.net);
    const tx = await client.transaction(txid);
    const fast = (await this.feeOptions()).rates.fast;
    try {
      const plan = (cancel ? planCancel : planBump)({
        tx,
        owned: l.owned,
        spendable: l.utxos.filter((u) => u.confirmations > 0),
        feeRate: (current) => Math.max(fast, current * 1.5 + 1),
        changeAddress: signer(l).deriveAddress({ index: l.scan.nextChangeIndex, change: true }).address,
        net: l.net,
        outputsSpent: tx.vout.some((o) => o.spent && o.addresses.some((a) => l.owned.has(a))),
      });
      return { plan, l };
    } catch (e) {
      if (e instanceof BumpError) {
        const why: Record<string, string> = {
          confirmed: cancel
            ? "This payment already confirmed. It cannot be cancelled."
            : "This payment already confirmed. Nothing to speed up.",
          "not-ours": `This payment was not sent from this wallet, so it cannot be ${cancel ? "cancelled" : "sped up"} here.`,
          shape: `Only payments sent from Oyster can be ${cancel ? "cancelled" : "sped up"}.`,
          "change-spent": `A newer payment already spends this one's change. ${cancel ? "Cancel" : "Speed up"} the newer payment instead.`,
          insufficient: cancel
            ? "After the higher fee there would be too little left to return."
            : "Not enough spendable PRL to pay the higher fee.",
          "fee-rate": e.message,
        };
        throw new ServiceError(`bump-${e.code}`, why[e.code] ?? e.message);
      }
      throw e;
    }
  }

  /** Fetch more history pages for every address, then rebuild the view. */
  async loadMoreHistory(): Promise<WalletView> {
    this.historyPages = Math.min(this.historyPages * 2, 64);
    return this.walletView(true);
  }

  async protectedCoins(): Promise<ProtectedCoin[]> {
    const l = await this.load(false);
    return l.utxos
      .filter((u) => u.freezeReason)
      .map((u) => ({ outpoint: outpoint(u), value: u.value.toString(), reason: u.freezeReason!, frozen: u.frozen }));
  }

  async setFrozen(op: string, frozen: boolean): Promise<ProtectedCoin[]> {
    const l = await this.load(false);
    const key = await this.unfrozenKey();
    const set = new Set<string>(JSON.parse((await this.platform.storage.get(key)) ?? "[]"));
    if (frozen) set.delete(op);
    else set.add(op);
    await this.platform.storage.set(key, JSON.stringify([...set]));
    l.utxos = applyFreezePolicy(l.utxos, set);
    return this.protectedCoins();
  }

  // ---- internals -----------------------------------------------------------

  private plan(l: Loaded, args: SendArgs, feeRate: number): SpendPlan {
    return planSpend({
      utxos: l.utxos,
      to: args.to.trim(),
      ...(args.max ? { max: true } : { amount: BigInt(args.amount ?? "0") }),
      feeRate,
      changeAddress: signer(l).deriveAddress({ index: l.scan.nextChangeIndex, change: true }).address,
      net: l.net,
      ...(args.only && args.only.length > 0 ? { only: args.only } : {}),
    });
  }

  private async load(refresh: boolean, maxAge = Number.POSITIVE_INFINITY): Promise<Loaded> {
    const id = await this.activeId();
    const net = await this.net();
    const key = `${id}:${net.id}`;
    const fresh = this.loaded && this.loaded.key === key && this.platform.clock.now() - this.loaded.scannedAt < maxAge;
    if (!refresh && fresh) return this.loaded!;
    if (this.scanning) return this.scanning;
    this.scanning = this.scan(id, net).finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  private async scan(id: string, net: PearlNetwork): Promise<Loaded> {
    const wallet = (await this.vault.read()).wallets.find((w) => w.id === id);
    if (!wallet) throw new ServiceError("no-wallet", "That wallet is no longer in Oyster.");
    const acct = await this.account(id, net);
    const client = this.client(net);
    const netId = net.id as NetworkId;
    const meta = await this.meta(id, netId);

    let scan: AccountScan;
    let watch: string | undefined;
    if (wallet.source.kind === "watch") {
      watch = wallet.source.address;
      try {
        decodeAddress(watch, net);
      } catch {
        throw new ServiceError("watch-network", `This watch-only wallet follows an address on another network. Switch the network in Settings to see it.`);
      }
      // One address, no derivation: present it as a one-address account.
      const summary = await client.summary(watch);
      const derived: DerivedAddress = { address: watch, path: "watch", index: 0, change: false, pubkey: new Uint8Array() };
      const used = summary.txCount > 0 || summary.unconfirmedTxCount > 0 ? [{ derived, summary }] : [];
      scan = { used, nextReceiveIndex: 0, nextChangeIndex: 0, confirmed: summary.balance, unconfirmed: summary.unconfirmed };
    } else {
      scan = await scanAccount(acct!, client, {
        gapLimit: meta.needsDeepScan ? OYSTER_RECOVERY_GAP : DEFAULT_GAP_LIMIT,
        knownUsed: meta.knownUsed,
      });
    }
    await this.saveMeta(id, netId, {
      ...meta,
      needsDeepScan: false,
      knownUsed: {
        receive: Math.max(meta.knownUsed.receive, scan.nextReceiveIndex - 1),
        change: Math.max(meta.knownUsed.change, scan.nextChangeIndex - 1),
      },
      lastBalance: (scan.confirmed + scan.unconfirmed).toString(),
      firstAddress: watch ?? acct!.deriveAddress({ index: 0 }).address,
    });

    const funded = scan.used.filter((a) => a.summary.balance > 0n || a.summary.unconfirmed !== 0n);
    const raw: Awaited<ReturnType<BlockbookClient["utxos"]>> = [];
    await inBatches(funded, LOOKUP_CONCURRENCY, async (a) => {
      raw.push(...(await client.utxos(a.derived.address)));
    });
    const unfrozen = new Set<string>(JSON.parse((await this.platform.storage.get(await this.unfrozenKey())) ?? "[]"));
    const history = await accountHistory(scan, client, { maxPages: this.historyPages });

    /**
     * Payments broadcast but not yet reported back by the indexer.
     *
     * Shown in their own right until it catches up, then dropped. A payment
     * that has left the wallet and appears nowhere reads as a payment that
     * was lost, and the reassurance is needed exactly in the seconds after
     * sending, which is the window the indexer has not covered yet.
     *
     * Anything older than a day is forgotten regardless. By then it has
     * either confirmed, or been replaced, or fallen out of every mempool,
     * and none of those are served by still showing it as on its way.
     */
    const seen = new Set(history.txs.map((t) => t.txid));
    const dayAgo = Math.floor(this.platform.clock.now() / 1000) - 86_400;
    const waiting = (meta.broadcast ?? []).filter((b) => b.at > dayAgo);
    const stillWaiting = waiting.filter((b) => !seen.has(b.txid));
    if ((meta.broadcast ?? []).length !== stillWaiting.length) {
      const current = await this.meta(id, netId);
      await this.saveMeta(id, netId, { ...current, broadcast: stillWaiting });
    }
    for (const b of stillWaiting) {
      history.txs.unshift({
        txid: b.txid,
        time: b.at,
        confirmations: 0,
        net: BigInt(b.net),
        fee: BigInt(b.fee),
        direction: "sent",
        coinbase: false,
        counterparty: b.to,
      });
    }

    // Our own unconfirmed change is spendable: nobody else can replace it.
    const ours = new Set(history.txs.filter((t) => t.direction !== "received").map((t) => t.txid));
    for (const u of raw) if (u.confirmations === 0 && ours.has(u.txid)) u.trusted = true;

    const owned = new Map<string, DerivedAddress>(scan.used.map((a) => [a.derived.address, a.derived]));
    const loaded: Loaded = {
      key: `${id}:${net.id}`,
      net,
      acct,
      ...(watch ? { watch } : {}),
      scan,
      utxos: applyFreezePolicy(raw, unfrozen),
      txs: history.txs,
      historyComplete: history.complete,
      owned,
      scannedAt: this.platform.clock.now(),
    };
    this.loaded = loaded;
    // So a locked wallet still knows which addresses to watch.
    await this.rememberWatchList(id, net.id as NetworkId, loaded);
    return loaded;
  }

  private async account(id: string, net: PearlNetwork): Promise<AccountKeys | null> {
    const key = `${id}:${net.id}`;
    let acct = this.accounts.get(key);
    if (!acct) {
      const contents = await this.vault.read();
      const wallet = contents.wallets.find((w) => w.id === id);
      if (!wallet) throw new ServiceError("no-wallet", "That wallet is no longer in Oyster.");
      if (wallet.source.kind === "watch") return null;
      const seedId = wallet.source.seedId;
      const seed = contents.seeds.find((x) => x.id === seedId);
      if (!seed) throw new ServiceError("no-seed", "This wallet's seed phrase is missing from the vault.");
      acct = accountFromSeed(seedFromMnemonic(seed.mnemonic), net, wallet.source.account);
      this.accounts.set(key, acct);
    }
    return acct;
  }

  private async activeWallet() {
    const { wallets } = await this.vault.read();
    const id = (await this.settings()).activeWalletId;
    const w = wallets.find((x) => x.id === id) ?? wallets[0];
    if (!w) throw new ServiceError("no-wallet", "no wallet in the vault");
    return w;
  }

  private async activeId(): Promise<string> {
    return (await this.activeWallet()).id;
  }

  private forget(): void {
    this.accounts.clear();
    this.loaded = null;
    this.historyPages = 1;
    // The session goes with the keys. It is a bearer credential that can
    // spend a balance, so keeping it past a lock would mean locking the
    // wallet did not lock the money.
    this.relayAccount.forget();
  }

  private async net(): Promise<PearlNetwork> {
    return NETWORKS[(await this.settings()).network];
  }

  private client(net: PearlNetwork): BlockbookClient {
    let c = this.clients.get(net.id);
    if (!c) {
      c = new BlockbookClient(net, this.platform.fetch);
      this.clients.set(net.id, c);
    }
    return c;
  }

  private async settings(): Promise<Settings> {
    const raw = await this.platform.storage.get("settings");
    return raw ? (JSON.parse(raw) as Settings) : { network: "mainnet" };
  }

  private async saveSettings(s: Settings): Promise<void> {
    await this.platform.storage.set("settings", JSON.stringify(s));
  }

  /**
   * Remembers a payment that has been broadcast, so it shows at once.
   *
   * `replaces` is for a speed-up or a cancel: the old transaction will
   * never confirm, and leaving it listed would show one payment as two.
   */
  private async rememberBroadcast(
    entry: { txid: string; net: string; fee: string; to: string },
    replaces?: string,
  ): Promise<void> {
    const id = await this.activeId();
    const netId = (await this.settings()).network;
    const meta = await this.meta(id, netId);
    const kept = (meta.broadcast ?? []).filter((b) => b.txid !== replaces);
    await this.saveMeta(id, netId, {
      ...meta,
      broadcast: [...kept, { ...entry, at: Math.floor(this.platform.clock.now() / 1000) }],
    });
  }

  private async meta(id: string, net: NetworkId): Promise<WalletMeta> {
    const raw = await this.platform.storage.get(`wallet.${id}.${net}`);
    return raw ? { ...emptyMeta(), ...(JSON.parse(raw) as WalletMeta) } : emptyMeta();
  }

  private async saveMeta(id: string, net: NetworkId, m: WalletMeta): Promise<void> {
    await this.platform.storage.set(`wallet.${id}.${net}`, JSON.stringify(m));
  }

  private async unfrozenKey(): Promise<string> {
    return `unfrozen.${await this.activeId()}.${(await this.settings()).network}`;
  }
}

/**
 * Every failure the popup can show, in words a user can act on: what went
 * wrong, and what to do next. Internal detail stays in `code` for debugging.
 */
export function toServiceError(e: unknown): { code: string; message: string } {
  if (e instanceof ServiceError) return { code: e.code, message: e.message };

  if (e instanceof VaultError) {
    const messages: Record<string, string> = {
      "wrong-password": "That password is not right.",
      locked: "Oyster locked itself. Unlock it to continue.",
      "weak-password": "Use at least 8 characters for your password.",
      missing: "There is no wallet on this device yet.",
      exists: "A wallet already exists on this device.",
      corrupt: "The wallet data on this device could not be read. Restore it from your seed phrase.",
    };
    return { code: e.code, message: messages[e.code] ?? e.message };
  }

  if (e instanceof SpendError) {
    const d = e.detail;
    const held: string[] = [];
    if (d.frozen > 0n) held.push(`${formatPrl(d.frozen)} PRL is protected`);
    if (d.immature > 0n) held.push(`${formatPrl(d.immature)} PRL in mining rewards is still maturing`);
    if (d.unconfirmed > 0n) held.push(`${formatPrl(d.unconfirmed)} PRL is still waiting for a block`);
    const why = held.length ? ` ${held.join(", ")}.` : "";
    const messages: Record<string, string> = {
      insufficient: `Not enough spendable PRL for this amount plus the network fee. You can spend ${formatPrl(d.spendable)} PRL right now.${why}`,
      "no-spendable": `Nothing is spendable right now.${why || " This wallet is empty."}`,
      dust: "That amount is too small to send. The minimum is 0.00000546 PRL.",
      "fee-rate": "The network fee estimate looks wrong. Try again in a minute.",
    };
    return { code: `spend-${e.code}`, message: messages[e.code] ?? e.message };
  }

  if (e instanceof AddressError) {
    return { code: "bad-address", message: `That address will not work: ${e.message}.` };
  }

  if (e instanceof BlockbookError) {
    if (e.status === 429 || /rate limit/i.test(e.message)) {
      return { code: "indexer-busy", message: "The Pearl network service is busy. Wait a moment and try again." };
    }
    if (/rejected the transaction/i.test(e.message)) {
      return { code: "tx-rejected", message: `The network refused this payment. Nothing was sent. (${e.message.replace(/^node rejected the transaction: /, "")})` };
    }
    if (e.status !== undefined && e.status >= 500) {
      return { code: "indexer-down", message: "The Pearl network service is having problems. Try again in a few minutes." };
    }
    return { code: "indexer", message: `The Pearl network service returned an error: ${e.message}` };
  }

  // fetch() rejects with a TypeError when the network is unreachable.
  if (e instanceof TypeError && /fetch|network/i.test(e.message)) {
    return { code: "offline", message: "Could not reach the Pearl network. Check your internet connection." };
  }

  return { code: "error", message: e instanceof Error ? e.message : String(e) };
}

function clampRate(r: number): number {
  if (!Number.isFinite(r)) return MIN_RELAY_SAT_PER_VB;
  return Math.min(MAX_FEE_RATE, Math.max(MIN_RELAY_SAT_PER_VB, r));
}

function hexOf(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** The keys to sign with, or a clear refusal for a watch-only wallet. */
/**
 * Signs "this payment is mine" with the key of `from`, an address the
 * payment spent. What the relay needs before it credits a sell's payment.
 */
function claimWith(l: Loaded, account: string, txid: string, from: string): { from: string; signature: string } {
  const d = l.owned.get(from);
  if (!d) throw new ServiceError("not-ours", "That payment did not spend from this wallet.");
  const key = signer(l).privateKey({ index: d.index, change: d.change });
  try {
    return { from, signature: signMessageBip322(sellClaimMessage(account, txid), from, key, d.pubkey, l.net) };
  } finally {
    key.fill(0);
  }
}

function signer(l: Loaded): AccountKeys {
  if (!l.acct) {
    throw new ServiceError("watch-only", "This is a watch-only wallet. It can show the balance but cannot send.");
  }
  return l.acct;
}

function emptyMeta(): WalletMeta {
  return { knownUsed: { receive: -1, change: -1 }, needsDeepScan: false };
}

function quote(plan: SpendPlan, feeRate: number): SendQuote {
  return {
    to: plan.to,
    amount: plan.amount.toString(),
    fee: plan.fee.toString(),
    total: (plan.amount + plan.fee).toString(),
    feeRate,
    vsize: plan.vsize,
    excluded: plan.excluded,
  };
}

function wireTx(t: WalletTx): WireTx {
  return {
    txid: t.txid,
    ...(t.height !== undefined ? { height: t.height } : {}),
    time: t.time,
    confirmations: t.confirmations,
    net: t.net.toString(),
    fee: t.fee.toString(),
    direction: t.direction,
    coinbase: t.coinbase,
    ...(t.counterparty ? { counterparty: t.counterparty } : {}),
  };
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
