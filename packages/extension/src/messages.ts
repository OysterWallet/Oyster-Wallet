/**
 * The popup <-> background contract.
 *
 * The background owns the vault, every key and every network call. The popup
 * is a view: it is destroyed whenever it closes and is never trusted with a
 * private key. The only secret that ever reaches it is a seed phrase the user
 * is looking at on purpose (backup during onboarding, export later).
 *
 * Extension messaging is JSON, so amounts travel as decimal grain strings.
 */

export type NetworkId = "mainnet" | "testnet2";
export type FeeTier = "slow" | "normal" | "fast" | "custom";
/** The three the indexer estimates. "custom" carries its own rate instead. */
export type EstimatedTier = Exclude<FeeTier, "custom">;
export type Theme = "system" | "light" | "dark";
export type ChartRange = "1D" | "1W" | "1M" | "3M" | "ALL";
export const CHART_RANGES: readonly ChartRange[] = ["1D", "1W", "1M", "3M", "ALL"];

/** PRL price, as served by Oyster's relay. */
export interface PriceView {
  usdPerPrl: number;
  change24hPct: number;
  /** In USDT, when the source reports it. */
  volume24h?: number;
  /** "safetrade" or "coingecko": shown when it is not the exchange price. */
  source: string;
  asOf: string;
  stale: boolean;
}

/** One price level in the order book. */
export interface DepthLevel {
  price: number;
  amount: number;
}

export interface DepthView {
  asks: DepthLevel[];
  bids: DepthLevel[];
  asOf: string;
  stale: boolean;
}

/** A trade that happened on the exchange, for the tape. */
export interface MarketTrade {
  id: number;
  price: number;
  amount: number;
  t: number;
  side?: "buy" | "sell";
}

/** What an order would cost, from walking the book rather than the ticker. */
export interface OrderQuote {
  side: "buy" | "sell";
  /** PRL that would trade. */
  amount: number;
  /** USDT that would change hands. */
  cost: number;
  avgPrice: number;
  worstPrice: number;
  /** The book ran out before the order filled. */
  partial: boolean;
  stale: boolean;
  asOf: string;
}

/** "Tell me when PRL crosses this." */
export interface PriceAlert {
  id: string;
  /** Above or below, in USDT per PRL. */
  direction: "above" | "below";
  price: number;
  created: number;
  /** Set once it has fired; a fired alert is kept until dismissed so the
   *  reason it fired is still readable. */
  firedAt?: number;
}

/** Selling mining payouts as they arrive, without being asked each time. */
export interface AutoSell {
  enabled: boolean;
  /** Grains. Nothing is sold until the mined balance reaches this, so a
   *  trickle of small payouts does not become a trickle of small trades. */
  threshold: string;
  /** How much of what is above the threshold to sell, in percent. */
  percent: number;
  /** Unix seconds of the last automatic sell, when there has been one. */
  lastRun?: number;
}

/** An order sitting on the exchange, waiting to fill. */
export interface OpenOrder {
  id: number;
  market: string;
  side: "buy" | "sell";
  state: string;
  /** Limit price in USDT. Absent on a market order. */
  price?: string;
  /** PRL the order was placed for. */
  origin_amount: string;
  /**
   * How much of origin_amount has filled. The exchange reports no remaining
   * field and no average price, so what is left has to be worked out here.
   */
  filled_amount?: string;
  trades_count?: number;
  created_at?: string;
}

/**
 * One fill on the exchange.
 *
 * Separate from OpenOrder because an order cannot say what it cost: its
 * average price is always "0", and a market order's price is a limit it
 * never had. This is the only honest source of what a trade came to.
 */
export interface AccountTrade {
  id: number;
  side: "buy" | "sell";
  /** PRL that traded. */
  amount: string;
  /** USDT per PRL, as executed. */
  price: string;
  /** USDT that changed hands. */
  total: string;
  /** What the exchange took, in the currency received. */
  fee: string;
  /** "prl" on a buy, "usdt" on a sell. */
  feeCurrency: string;
  orderId: number;
  /** Unix seconds. */
  t: number;
}

export interface TradesView {
  open: boolean;
  trades: AccountTrade[];
  why?: string;
}

export interface OrdersView {
  /** False when this relay is not acting on an exchange account yet. */
  open: boolean;
  orders: OpenOrder[];
  why?: string;
}

/**
 * Chains a user may nominate an address on.
 *
 * Only the ones where USDT moves in *both* directions and moving it is
 * worth doing. Money can be deposited from more chains than this, but it
 * cannot be sent back on them, and offering a box to type an address into
 * would promise a way out that does not exist.
 *
 * Ethereum is not here, though the exchange supports it. It will not send
 * less than 50 USDT and charges 3 to do it, and mainnet gas for the
 * transfer afterwards is dollars rather than cents. Somebody who deposits
 * from Ethereum would find they had to have 50 USDT before they could get
 * any of it back, which is a trap rather than a chain. Base does the same
 * job at a fee of 1 and a minimum of 1 if it is ever wanted.
 */
export const CASH_CHAINS = [
  { id: "spl-key", name: "Solana", kind: "solana" },
  { id: "arbitrum-tokens", name: "Arbitrum", kind: "evm" },
  { id: "bsc-tokens", name: "BNB Chain", kind: "evm" },
] as const;
export type CashChainId = (typeof CASH_CHAINS)[number]["id"];

/**
 * SafeTrade's name for the Pearl chain.
 *
 * Not in CASH_CHAINS, because that list is the chains USDT moves on in both
 * directions. PRL goes one way only: to the exchange, so it can be sold.
 * What is bought comes back as an ordinary Pearl payment to this wallet.
 */
export const PEARL_CHAIN = "pearl-tokens";

/** A currency the exchange takes as a deposit, and on which chains. */
export interface DepositMethod {
  currency: string;
  name: string;
  networks: { id: string; name: string; minDeposit?: string; confirmations?: number; depositFee?: string }[];
}

/** Where to send USDT on one chain, once the relay can credit it. */
export interface DepositAddress {
  open: boolean;
  address?: string;
  network?: string;
  /** "usdt" everywhere but the Pearl chain, where it is "prl". */
  currency?: string;
  /** The least worth sending, in whole units of that currency. Shown beside
   *  the address, because that is the moment somebody decides how much to
   *  send. For PRL it is the exchange's smallest order: send less and it
   *  arrives and cannot be sold. */
  minimum?: string;
  /**
   * The address is not proved yet. Its first deposit has to be exactly
   * `amount` USDT, from the saved address; after that, any amount works.
   */
  prove?: { amount: string; expires?: number };
  why?: string;
}

/**
 * One thing that moved this account's money on the relay.
 *
 * The ledger's own entries. A deposit, a buy, a fee, a withdrawal and an
 * adjustment are all the same kind of fact, and each screen decides which
 * it cares about. Signed amounts: negative is money leaving, and the sign
 * is the whole meaning of a row.
 */
export interface CashEntry {
  asset: "usdt" | "prl";
  /** Smallest unit, exact, as a string. */
  amount: string;
  kind: string;
  ref: string;
  note?: string;
  /** Unix milliseconds. */
  at: number;
}

/**
 * Where this account could take USDT out to, and how much is free.
 *
 * The destinations are not a choice of address, only of chain. Each one is
 * an address this wallet has already sent USDT from, which is the only
 * place the relay will send it back to.
 */
export interface WithdrawInfo {
  /** USDT millionths free to withdraw, after anything an order set aside. */
  available: string;
  /** The least the relay will send, in millionths. */
  minimum: string;
  /**
   * One per chain they have sent USDT from. Empty means nowhere to send.
   *
   * `fee` is what the exchange charges to move USDT out on that chain,
   * charged on top of what is withdrawn. It differs per chain, so it
   * belongs here rather than as one number covering all of them.
   */
  destinations: { address: string; chain: string; fee: string }[];
}

/**
 * What the relay holds for this wallet.
 *
 * Amounts are strings in the smallest unit, PRL in grains and USDT in
 * millionths. They stay strings the whole way to the screen: these are
 * exact integers, and a JSON number would round the large ones.
 */
export interface AccountView {
  address: string;
  usdt: string;
  prl: string;
  /**
   * Of `prl`, what was bought with "Keep on exchange": it stays there, ready
   * to sell at once, until "Send to my wallet" releases it.
   */
  kept: string;
  /**
   * PRL that is theirs but is not in the wallet yet.
   *
   * A buy credits a balance on the relay and then leaves again as a payment
   * to the wallet. In between the money is real, owed, and nowhere the
   * person can see it, which is exactly when they most want to be told
   * something. "settling" is before it has been broadcast, "sending" after.
   */
  incoming?: { prl: string; stage: "settling" | "sending"; txid?: string };
  /**
   * PRL that has left the wallet and is not money yet.
   *
   * The mirror of `incoming`, and the wait is longer: the exchange will not
   * count a PRL deposit until ten blocks have passed. For that half hour the
   * coins are gone from the wallet and nothing has arrived to replace them,
   * which is the worst thing a wallet can show somebody in silence.
   */
  selling?: { prl: string; stage: "waiting" | "sending" | "selling"; txid?: string };
  /**
   * USDT on its way out of Oyster.
   *
   * Debited when the withdrawal is planned, so the balance drops before
   * anything is signed and stays down until it lands. "held" is its own
   * stage because it means the relay gave up and a person has to look:
   * telling somebody their money is on its way when it is stuck is worse
   * than saying nothing at all.
   */
  withdrawing?: { usdt: string; stage: "waiting" | "sending" | "held"; chain: string; txid?: string };
  senders: { address: string; chain: string }[];
}

/** One of this account's own orders, as the relay describes it. */
export interface MyOrder {
  id: number;
  side: "buy" | "sell";
  market: string;
  state: string;
  /** PRL in grains, exact. */
  amount: string;
  /** The same amount as a decimal, for showing. */
  amountPrl: string;
  /** What it set aside: USDT millionths on a buy, PRL grains on a sell. */
  reserved: string;
  reservedAsset: string;
  note?: string;
  /** A buy whose PRL stays on the exchange. */
  keep?: boolean;
  created: number;
}

export interface MyOrdersView {
  market: string;
  open: MyOrder[];
  history: MyOrder[];
  /**
   * What is left after open orders have set their money aside.
   *
   * The number a screen should offer to spend. Offering the whole balance
   * would be offering money the relay will refuse, because an open order is
   * already holding part of it.
   */
  spendable: { usdt: string; prl: string };
}

export interface CashView {
  methods: DepositMethod[];
  /** "safetrade" when the exchange answered, "fallback" when it did not. */
  source: string;
  /** False until the relay has an account that can be credited. */
  open: boolean;
}

/** Wrapped PRL held at the watched Ethereum address, read by the relay. */
export interface WrappedView {
  address: string;
  /** Raw integer units, as a string. wPRL uses 8 decimals, like PRL. */
  balance: string;
  decimals: number;
  asOf: string;
  /** Which Ethereum endpoint answered, for the "read from" line. */
  rpc: string;
}

/** One period of trading, for the candle view. */
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface ChartView {
  range: ChartRange;
  source: string;
  points: { t: number; v: number }[];
  /** Present when the source publishes open, high and low as well. */
  candles?: Candle[];
  changePct: number;
  asOf: string;
  stale: boolean;
}
export const AUTO_LOCK_CHOICES = [1, 5, 15, 30, 60] as const;

export type WalletColor = "teal" | "amber" | "red" | "violet" | "slate" | "ink";
export const WALLET_COLOR_KEYS: readonly WalletColor[] = ["teal", "amber", "red", "violet", "slate", "ink"];

export interface WalletSummary {
  id: string;
  name: string;
  color: WalletColor;
  kind: "seed" | "watch";
  /** "seed 1", "seed 2", or "watch only". */
  sourceLabel: string;
  /** First receive address, once scanned (always, for watch-only). */
  address?: string;
  /** Grains, from the last scan on the current network. */
  balance?: string;
  /** Miner mode is on for this wallet. */
  miner: boolean;
}

export interface WalletDetails extends WalletSummary {
  address: string;
  /** BIP-86 account path, for seed wallets. */
  path?: string;
  /** Removing it deletes a seed phrase from this device. */
  removesSeed: boolean;
  isOnly: boolean;
}

export interface MiningView {
  enabled: boolean;
  walletId: string;
  /** Pinned when miner mode is turned on; for watch-only, the watched address. */
  payoutAddress?: string;
  today: { total: string; count: number };
  /** Seven local days, oldest first, today last. `start` is unix seconds. */
  days: { start: number; total: string; count: number }[];
  last7: string;
  dailyAverage: string;
  payouts: {
    txid: string;
    amount: string;
    time: number;
    confirmations: number;
    blockReward: boolean;
    status: "confirming" | "maturing" | "confirmed";
  }[];
  historyComplete: boolean;
  /** Set when history could not reach back 7 days (a very busy address):
   *  the stats cover only from this time (unix seconds). */
  coveredSince?: number;
}

/** A pending request from a website, shown in the approval window. */
export type ApprovalRequest =
  | { id: string; origin: string; kind: "connect" }
  | { id: string; origin: string; kind: "send"; to: string; amount: string; feeRate?: number }
  | { id: string; origin: string; kind: "signMessage"; message: string }
  | { id: string; origin: string; kind: "pushTx"; rawHex: string; tx: RawTxSummary };

/** A raw transaction a site wants broadcast, decoded so it can be read. */
export interface RawTxSummary {
  txid: string;
  vsize: number;
  inputs: number;
  outputs: { address?: string; value: string; mine: boolean }[];
  total: string;
}

export interface ConnectedSite {
  origin: string;
  connectedAt: number;
}

export type AddWalletArgs = {
  name: string;
  color?: WalletColor;
  mode: { kind: "next" } | { kind: "import"; mnemonic: string } | { kind: "watch"; address: string };
};

/** Where the wallet opens: the usual popup, or a panel down the side of the
 *  window that stays put while you browse. */
export type UiMode = "popup" | "sidepanel";
export const UI_MODES: readonly UiMode[] = ["popup", "sidepanel"];

export interface AppState {
  hasVault: boolean;
  unlocked: boolean;
  network: NetworkId;
  wallets: WalletSummary[];
  activeWalletId?: string;
  autoLockMinutes: number;
  theme: Theme;
  /** Where price data comes from; the VPS relay once deployed. */
  relayUrl: string;
  /** Whether an operator key is set, never the key itself: the popup has no
   *  business holding it, and it would sit in a message log if it did. */
  hasOperatorKey: boolean;
  /** The address this person sends cash from, and gets it back at, per chain. */
  cashAddresses: Partial<Record<CashChainId, string>>;
  uiMode: UiMode;
  /** False on browsers with no side panel, where the choice is hidden. */
  sidePanelSupported: boolean;
}

export interface WireTx {
  txid: string;
  height?: number;
  time: number;
  confirmations: number;
  net: string;
  fee: string;
  direction: "received" | "sent" | "self";
  coinbase: boolean;
  /** For sends: the first output not paying this wallet. */
  counterparty?: string;
}

export interface WalletView {
  walletId: string;
  network: NetworkId;
  confirmed: string;
  unconfirmed: string;
  /** Spendable right now: confirmed, mature, not protected. */
  spendable: string;
  receiveAddress: string;
  /** Ethereum address being watched for wrapped PRL, if the owner gave one. */
  wrappedAddress?: string;
  /** Whether that wPRL counts towards the portfolio total on the home screen. */
  wrappedInTotal?: boolean;
  /** Watch-only: balance and history, but no sending. */
  watchOnly: boolean;
  protectedCount: number;
  immature: string;
  txs: WireTx[];
  historyComplete: boolean;
  scannedAt: number;
}

/** Somewhere you have paid before, so it need not be pasted again. */
export interface Contact {
  address: string;
  label?: string;
  /** Unix seconds of the last payment to it. */
  lastUsed: number;
  count: number;
}

/** One coin in the wallet, for the coin list and for picking what to spend. */
export interface Coin {
  /** "txid:vout", the id used when choosing coins to spend. */
  outpoint: string;
  txid: string;
  vout: number;
  address: string;
  value: string;
  confirmations: number;
  coinbase: boolean;
  immature: boolean;
  frozen: boolean;
  freezeReason?: string;
}

export interface FeeOptions {
  /** sat/vB per tier, already floored at the relay minimum. */
  rates: Record<EstimatedTier, number>;
}

export interface SendQuote {
  to: string;
  amount: string;
  fee: string;
  total: string;
  feeRate: number;
  vsize: number;
  excluded: { frozen: number; immature: number; unconfirmed: number };
}

/** What cancelling a pending payment would do: pay a higher fee and send the
 *  amount back to an address of your own, so the original cannot confirm. */
export interface CancelQuote {
  txid: string;
  oldFee: string;
  newFee: string;
  /** What comes back to you, after the replacement's fee. */
  returned: string;
  to: string;
}

export interface SpeedUpQuote {
  txid: string;
  oldFee: string;
  newFee: string;
  feeRate: number;
  /** Inputs in the replacement; more than the original means a coin was added. */
  addsInput: number;
}

export interface ProtectedCoin {
  outpoint: string;
  value: string;
  reason: "inscription" | "small-output";
  frozen: boolean;
}

export interface SendArgs {
  to: string;
  /** Grains. Omit with max: true. */
  amount?: string;
  max?: boolean;
  tier: FeeTier;
  /** sat/vB, required when tier is "custom" and ignored otherwise. */
  rate?: number;
  /** Coin control: spend exactly these outpoints. */
  only?: string[];
}

export type Request =
  | { type: "state" }
  | { type: "generateMnemonic" }
  | { type: "validateMnemonic"; mnemonic: string }
  | { type: "createVault"; password: string; mnemonic: string; imported: boolean; replace?: boolean }
  | { type: "unlock"; password: string }
  | { type: "lock" }
  | { type: "lockState" }
  | { type: "setNetwork"; network: NetworkId }
  | { type: "walletView"; refresh?: boolean; background?: boolean }
  | { type: "validateAddress"; address: string }
  | { type: "setWrappedAddress"; address: string | null }
  | { type: "wrappedBalance" }
  | { type: "cash" }
  | { type: "depth" }
  | { type: "marketTrades" }
  | { type: "orderQuote"; side: "buy" | "sell"; amount?: number; spend?: number }
  | { type: "openOrders" }
  | { type: "orderHistory" }
  | { type: "accountTrades" }
  | { type: "cancelOrder"; id: number }
  // The account the relay keeps for this wallet. Everything here needs a
  // session, which needs a signature, which needs the wallet unlocked.
  | { type: "myAccount" }
  | { type: "myOrders" }
  | { type: "placeOrder"; side: "buy" | "sell"; amount: string; price: string; keep?: boolean }
  | { type: "releasePrl" }
  | { type: "cancelMyOrder"; id: number }
  // Selling PRL still in this wallet: the relay records it, the wallet
  // sends the PRL, the relay sells it when the exchange counts it.
  | { type: "placeSell"; amount: string }
  // Taking USDT out, to the address it was sent from. There is no
  // destination to pass: the relay looks it up, and the signer refuses
  // any address its owner has not declared.
  | { type: "withdrawInfo" }
  | { type: "accountHistory" }
  | { type: "withdraw"; chain: string; amount: string }
  | { type: "maxSpend"; tier: FeeTier; rate?: number }
  | { type: "setWrappedInTotal"; include: boolean }
  | { type: "setUiMode"; mode: UiMode }
  | { type: "feeOptions" }
  | { type: "quoteSend"; args: SendArgs }
  | { type: "send"; args: SendArgs }
  | { type: "txStatus"; txid: string }
  | { type: "quoteSpeedUp"; txid: string }
  | { type: "speedUp"; txid: string }
  | { type: "quoteCancel"; txid: string }
  | { type: "cancelSend"; txid: string }
  | { type: "loadMoreHistory" }
  | { type: "protectedCoins" }
  | { type: "setFrozen"; outpoint: string; frozen: boolean }
  | { type: "exportSeed"; password: string; walletId?: string }
  | { type: "coins" }
  | { type: "exportXpub"; walletId?: string }
  | { type: "txNote"; txid: string; note: string }
  | { type: "txNotes" }
  | { type: "historyCsv" }
  | { type: "addressBook" }
  | { type: "saveContact"; address: string; label: string }
  | { type: "forgetContact"; address: string }
  | { type: "exportBackup"; password: string }
  | { type: "importBackup"; file: string; password: string }
  | { type: "switchWallet"; id: string }
  | { type: "addWallet"; args: AddWalletArgs }
  | { type: "updateWallet"; id: string; name?: string; color?: WalletColor }
  | { type: "removeWallet"; id: string; acknowledgeSeedDeletion?: boolean }
  | { type: "walletDetails"; id: string }
  | { type: "miningView"; tzOffsetMinutes: number; refresh?: boolean }
  | { type: "setMinerMode"; enabled: boolean }
  | { type: "priceAlerts" }
  | { type: "addPriceAlert"; direction: "above" | "below"; price: number }
  | { type: "removePriceAlert"; id: string }
  | { type: "autoSell" }
  | { type: "setAutoSell"; enabled: boolean; threshold: string; percent: number }
  | { type: "approvalGet"; id: string }
  | { type: "approvalQuote"; id: string }
  | { type: "approvalResolve"; id: string; approved: boolean }
  | { type: "siteAccount" }
  | { type: "listSites" }
  | { type: "price" }
  | { type: "chart"; range: ChartRange }
  | { type: "setRelayUrl"; url: string }
  | { type: "setOperatorKey"; secret: string }
  | { type: "setCashAddress"; chain: CashChainId; address: string }
  | { type: "depositAddress"; chain: CashChainId | typeof PEARL_CHAIN }
  | { type: "disconnectSite"; origin: string }
  | { type: "setAutoLock"; minutes: number }
  | { type: "setTheme"; theme: Theme }
  | { type: "changePassword"; oldPassword: string; newPassword: string };

export interface Responses {
  state: AppState;
  generateMnemonic: { mnemonic: string };
  validateMnemonic: { valid: boolean; words: number };
  createVault: AppState;
  unlock: AppState;
  lock: AppState;
  lockState: { hasVault: boolean; unlocked: boolean };
  setNetwork: AppState;
  walletView: WalletView;
  validateAddress: { valid: boolean; error?: string };
  setWrappedAddress: { address?: string };
  wrappedBalance: WrappedView | null;
  cash: CashView | null;
  depth: DepthView | null;
  marketTrades: MarketTrade[] | null;
  orderQuote: OrderQuote | null;
  openOrders: OrdersView | null;
  orderHistory: OrdersView | null;
  accountTrades: TradesView | null;
  cancelOrder: { cancelled: boolean };
  // Null when the wallet is locked or the relay cannot be reached. A screen
  // that cannot read a balance shows that it cannot, rather than a zero.
  myAccount: AccountView | null;
  myOrders: MyOrdersView | null;
  placeOrder: MyOrder;
  releasePrl: { released: string };
  cancelMyOrder: MyOrder;
  placeSell: { txid: string; sellId: number };
  withdrawInfo: WithdrawInfo | null;
  accountHistory: CashEntry[] | null;
  withdraw: { id: number; chain: string; destination: string; amount: string; state: string };
  maxSpend: { amount: string; fee: string };
  setWrappedInTotal: { include: boolean };
  setUiMode: AppState;
  feeOptions: FeeOptions;
  quoteSend: SendQuote;
  send: { txid: string; quote: SendQuote };
  txStatus: { confirmations: number; found: boolean };
  quoteSpeedUp: SpeedUpQuote;
  speedUp: { txid: string; quote: SpeedUpQuote };
  quoteCancel: CancelQuote;
  cancelSend: { txid: string; quote: CancelQuote };
  loadMoreHistory: WalletView;
  protectedCoins: ProtectedCoin[];
  setFrozen: ProtectedCoin[];
  exportSeed: { mnemonic: string };
  coins: Coin[];
  exportXpub: { xpub: string; path: string };
  txNote: Record<string, string>;
  txNotes: Record<string, string>;
  historyCsv: { file: string; name: string };
  addressBook: Contact[];
  saveContact: Contact[];
  forgetContact: Contact[];
  exportBackup: { file: string; name: string };
  importBackup: AppState;
  switchWallet: AppState;
  addWallet: AppState;
  updateWallet: AppState;
  removeWallet: AppState;
  walletDetails: WalletDetails;
  miningView: MiningView;
  setMinerMode: AppState;
  priceAlerts: PriceAlert[];
  addPriceAlert: PriceAlert[];
  removePriceAlert: PriceAlert[];
  autoSell: AutoSell;
  setAutoSell: AutoSell;
  approvalGet: ApprovalRequest;
  approvalQuote: SendQuote & { inputs: number; outputs: number };
  approvalResolve: { result?: unknown };
  siteAccount: { address: string; walletName: string; network: NetworkId };
  listSites: ConnectedSite[];
  price: PriceView | null;
  chart: ChartView | null;
  setRelayUrl: AppState;
  setOperatorKey: AppState;
  setCashAddress: AppState;
  depositAddress: DepositAddress;
  disconnectSite: ConnectedSite[];
  setAutoLock: AppState;
  setTheme: AppState;
  changePassword: AppState;
}

export type Reply<T extends Request["type"]> =
  | { ok: true; value: Responses[T] }
  | { ok: false; error: { code: string; message: string } };
