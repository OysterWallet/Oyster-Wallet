import { buildPaymentUri, FEE_ADDRESS } from "@pearl-wallet/core";
import encodeQR from "qr";
import { useEffect, useMemo, useState } from "react";
import { browser } from "wxt/browser";
import { CHART_RANGES, type AccountView, type CancelQuote, type CashEntry, type Coin, type TradesView, type ChartRange, type ChartView, type NetworkId, type PriceView, type SpeedUpQuote, type WalletView, type WireTx, type WrappedView } from "../../messages";
import { ChartStyleToggle, PriceChart, pointLabel, RANGE_TAIL, readDenom, usdt, usdtPrice, writeDenom, type ChartStyle, type Denom, type HoverPoint } from "../chart";
import { Button, Callout, CoinIcon, EthMark, Header, Icon, ICONS, Logo, PrlMark, TabBar, type Tab } from "../components";
import { ago, parseAmount, prl, prlExact, shortAddr, shortTxid } from "../format";
import { call, RpcError } from "../rpc";

const EXPLORER: Record<NetworkId, string> = {
  mainnet: "https://explorer.pearlresearch.ai/tx/{txid}?network=mainnet",
  testnet2: "https://blockbook.testnet.pearlresearch.ai/tx/{txid}",
};

const EXPLORER_ADDR: Record<NetworkId, string> = {
  mainnet: "https://explorer.pearlresearch.ai/address/{addr}?network=mainnet",
  testnet2: "https://blockbook.testnet.pearlresearch.ai/address/{addr}",
};

export function openExplorer(network: NetworkId, txid: string) {
  void browser.tabs.create({ url: EXPLORER[network].replace("{txid}", txid) });
}

export function openAddress(network: NetworkId, address: string) {
  void browser.tabs.create({ url: EXPLORER_ADDR[network].replace("{addr}", address) });
}

function ActionButton({ label, icon, tone, disabled, title, onClick }: {
  label: string; icon: string; tone?: "buy" | "sell"; disabled?: boolean; title?: string; onClick?: () => void;
}) {
  return (
    <button type="button" className={`action${tone ? ` ${tone}` : ""}`} disabled={disabled} title={title} onClick={onClick}>
      <span className="ring"><Icon d={icon} size={20} /></span>
      {label}
    </button>
  );
}

/** A holding on the home screen: what it is on the left, what it is worth on
 *  the right. Not a button until there is somewhere for it to go. */
function AssetRow({ icon, name, sub, value, unit, dim, quiet, onOpen }: {
  icon: React.ReactNode; name: string; sub: string; value?: string; unit?: string; dim?: boolean; quiet?: boolean; onOpen?: () => void;
}) {
  const Tag = onOpen ? "button" : "div";
  return (
    <Tag {...(onOpen ? { type: "button" as const, onClick: onOpen } : {})} className="list-row"
      style={{ padding: "0 12px", cursor: onOpen ? "pointer" : "default", opacity: dim ? 0.6 : 1 }}>
      {icon}
      <span className="main">
        <span className="t">{name}</span>
        <span className="s">{sub}</span>
      </span>
      <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", flexShrink: 0 }}>
        {value && <span className="mono" style={{ fontSize: 13.5, color: quiet ? "var(--text-3)" : "var(--text)" }}>{value}</span>}
        {unit && <span className="s" style={{ fontSize: 12, color: "var(--text-3)" }}>{unit}</span>}
      </span>
      {onOpen && <Icon d={ICONS.chevron} size={15} />}
    </Tag>
  );
}

export function TxRow({ tx, price, onOpen }: { tx: WireTx; price?: PriceView; onOpen: () => void }) {
  const pending = tx.confirmations === 0;
  const incoming = tx.direction === "received";
  const title = tx.direction === "self" ? "Moved between your addresses" : incoming ? "Received" : "Sent";
  // A payment to the fee wallet is not a mystery transfer to a stranger: it
  // is this wallet's own trading fee, and it should say so.
  const toFee = tx.counterparty === FEE_ADDRESS.mainnet || tx.counterparty === FEE_ADDRESS.testnet2;
  const sub = tx.coinbase
    ? "Mining reward"
    : toFee
      ? "Oyster trading fee"
      : incoming
        ? "Payment"
        : tx.counterparty
          ? `To ${shortAddr(tx.counterparty, 8, 5)}`
          : "Payment";
  return (
    <button type="button" className="list-row" style={{ padding: 0 }} onClick={onOpen}>
      <span className="dot-icon"><Icon d={incoming ? ICONS.receive : ICONS.send} size={17} /></span>
      <span className="main">
        <span className="t">{title}{pending && <span className="chip warn">pending</span>}</span>
        <span className="s">{sub} · {pending ? "waiting for a block" : ago(tx.time)}</span>
      </span>
      <span className={`mono ${BigInt(tx.net) > 0n ? "pos" : ""}`} style={{ fontSize: 13 }}>
        {BigInt(tx.net) > 0n ? "+" : ""}
        {/* Whichever unit the owner reads in, from the same setting Home
            uses, so one tap changes the whole wallet rather than one line. */}
        {readDenom() === "usdt" && price
          ? usdt((Number(tx.net) / 1e8) * price.usdPerPrl)
          : prl(tx.net)}
      </span>
    </button>
  );
}

/**
 * How long a sell has left before the exchange will count it.
 *
 * SafeTrade waits ten blocks before a PRL deposit becomes a balance it
 * will trade. Pearl aims at a block every three minutes, so the whole wait
 * is about half an hour.
 *
 * Driven by the confirmation count rather than a clock started when the
 * coins were sent. A clock is an estimate pretending to be a deadline: it
 * reaches zero whether or not anything happened, and the one time that
 * matters is the time blocks came slowly, which is exactly when it would
 * lie. Confirmations cannot lie, and a chain that has stalled shows as a
 * bar that has stopped instead of a countdown that has not.
 */
const EXCHANGE_BLOCKS = 10;
const BLOCK_MINUTES = 3;

/**
 * Whether this is the popup rather than the side panel.
 *
 * Both entrypoints render the same app, so the document is the only thing
 * that differs. It matters for where money in transit is announced: the
 * popup is a short box somebody opens, glances at and closes, so anything
 * below the asset rows may never be seen, while the panel is tall enough
 * that the foot of the screen is still on it.
 */
const IN_POPUP = !location.pathname.includes("sidepanel");

function SellProgress({ confirmations }: { confirmations: number }) {
  const done = Math.max(0, Math.min(EXCHANGE_BLOCKS, confirmations));
  const left = EXCHANGE_BLOCKS - done;
  const minutes = left * BLOCK_MINUTES;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 8 }}>
      <div style={{ height: 6, borderRadius: 3, background: "var(--divider)", overflow: "hidden" }}>
        <div style={{ width: `${Math.max(4, (done / EXCHANGE_BLOCKS) * 100)}%`, height: 6, background: "var(--accent)", transition: "width .4s" }} />
      </div>
      <div className="mono" style={{ display: "flex", justifyContent: "space-between", fontSize: 11, opacity: 0.8 }}>
        <span>{done} of {EXCHANGE_BLOCKS} blocks</span>
        <span>{left === 0 ? "any moment now" : `about ${minutes} ${minutes === 1 ? "minute" : "minutes"} left`}</span>
      </div>
    </div>
  );
}

/** Line or candles, remembered the same way. */
const STYLE_KEY = "oyster.chartStyle";
function readStyle(): ChartStyle {
  try { return localStorage.getItem(STYLE_KEY) === "candles" ? "candles" : "line"; } catch { return "line"; }
}

/**
 * When the balance was last read from the chain.
 *
 * Re-rendered on its own clock so "just now" becomes "1 min ago" while the
 * screen sits open, which is the whole point: a balance with no age on it
 * reads as live whether it is or not.
 */
function LastUpdated({ at, refreshing }: { at: number; refreshing?: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="muted" style={{ fontSize: 11, textAlign: "center", marginTop: "auto", paddingTop: 4 }}>
      {refreshing ? "Updating…" : `Last updated ${ago(Math.floor(at / 1000), now)}`}
    </span>
  );
}

export function Home({
  view, network, walletName, error, refreshing, price, chart, range, onRange, wrapped, cashUsdt, keptPrl, incoming, selling, withdrawing,
  onTab, onSend, onReceive, onLock, onRefresh, onWalletMenu, onMining, onToken, onWrapped, onCash, onBuy, onSell,
}: {
  view?: WalletView; network: NetworkId; walletName: string; error?: string; refreshing?: boolean;
  price?: PriceView; chart?: ChartView; range: ChartRange; onRange: (r: ChartRange) => void; wrapped?: WrappedView;
  /** USDT cash, which counts towards the portfolio like anything else. */
  cashUsdt?: number;
  /** Grains of PRL kept on the exchange. Theirs, so counted with the wallet's PRL. */
  keptPrl?: bigint;
  /** PRL bought but not yet in the wallet. See `AccountView.incoming`. */
  incoming?: AccountView["incoming"];
  /** PRL sold but not yet money. See `AccountView.selling`. */
  selling?: AccountView["selling"];
  /** USDT on its way out. See `AccountView.withdrawing`. */
  withdrawing?: AccountView["withdrawing"];
  onTab: (t: Tab) => void; onSend: () => void; onReceive: () => void; onLock: () => void;
  onRefresh: () => void; onWalletMenu: () => void; onMining: () => void; onToken: () => void; onWrapped: () => void;
  onCash: () => void; onBuy: () => void; onSell: () => void;
}) {
  const balance = view ? BigInt(view.confirmed) + BigInt(view.unconfirmed) : 0n;
  const empty = view && balance === 0n && view.txs.length === 0;
  const unconfirmed = view ? BigInt(view.unconfirmed) : 0n;
  const immature = view ? BigInt(view.immature) : 0n;

  // Scrubbing the chart rewrites the headline: the portfolio as it was at that
  // moment, and the change from the start of the range up to it.
  const [hover, setHover] = useState<HoverPoint | null>(null);
  const [denom, setDenom] = useState<Denom>(readDenom);
  const [style, setStyle] = useState<ChartStyle>(readStyle);
  const points = chart?.points ?? [];
  const held = Number(balance) / 1e8;
  const at = hover ?? undefined;
  const unitPrice = at?.v ?? price?.usdPerPrl;
  const first = points[0]?.v;
  const wrappedUnits = wrapped ? Number(BigInt(wrapped.balance)) / 10 ** wrapped.decimals : undefined;
  // wPRL counts towards the total only when its page says so: it is a
  // different chain, and some owners want the two kept apart.
  const withWrapped = view?.wrappedInTotal === true && wrappedUnits !== undefined && wrappedUnits > 0;
  // PRL kept on the exchange is theirs as much as what is in this wallet.
  const kept = keptPrl ?? 0n;
  const keptUnits = Number(kept) / 1e8;
  const counted = held + keptUnits + (withWrapped ? wrappedUnits! : 0);
  // Cash is part of the portfolio, not a separate thing sitting beside it.
  // It is counted in USDT directly rather than converted through a price.
  const cashValue = cashUsdt ?? 0;
  /**
   * The wallet's own record of the payment carrying a sell.
   *
   * The relay says which transaction it is; the confirmation count comes
   * from here, because this wallet already follows its own transactions
   * and the relay cannot see one until the exchange does. Missing when the
   * history has not loaded yet, which just means no bar rather than a bar
   * reading zero.
   */
  const sellTx = selling?.txid ? view?.txs.find((t) => t.txid === selling.txid) : undefined;
  const pct = at && first ? ((at.v - first) / first) * 100 : chart?.changePct ?? price?.change24hPct;
  // Derived from the percentage so the two halves of the line always agree,
  // even when the live price has moved past the chart's last point.
  const diff = first !== undefined && pct !== undefined ? (pct / 100) * first * counted : undefined;
  const when = at ? pointLabel(at.t, range) : RANGE_TAIL[range] ?? "";
  const inUsdt = denom === "usdt" && unitPrice !== undefined;
  const flip = () => {
    if (unitPrice === undefined) return;
    const next: Denom = denom === "usdt" ? "prl" : "usdt";
    setDenom(next);
    writeDenom(next);
  };

  /**
   * Money that has left one place and not arrived at the other.
   *
   * Rendered at the top in the popup and at the foot in the side panel.
   * The popup is a short box somebody opens, glances at and closes, so
   * anything under the asset rows may never be seen at all, and a buy or
   * a sell in flight is the one thing they opened it to check.
   */
  const moneyInTransit = (
    <>
        {incoming && BigInt(incoming.prl) > 0n && (
          /**
           * PRL that is bought and owed but not here yet.
           *
           * Between the fill and the payment landing there is nothing on
           * this screen that moves, and the balance is the old one. Saying
           * so is the difference between waiting and thinking it failed.
           */
          <button type="button" onClick={() => onTab("activity")}
            style={{ border: "none", padding: 0, background: "none", textAlign: "left", cursor: "pointer" }}>
            <Callout kind="info" icon={ICONS.clock}>
              {prl(BigInt(incoming.prl))} PRL is on the way.{" "}
              {incoming.stage === "sending"
                ? "It has been sent and is waiting for a block."
                : "Oyster is preparing the payment to this wallet."}
            </Callout>
          </button>
        )}
        {selling && BigInt(selling.prl) > 0n && (
          /**
           * The other side of the same silence.
           *
           * A sell takes the coins out of the wallet long before any money
           * comes back: the exchange will not count the deposit for ten
           * blocks. Without a line here the balance simply drops and
           * nothing explains it, which is worse than waiting.
           */
          <button type="button" onClick={() => onTab("activity")}
            style={{ border: "none", padding: 0, background: "none", textAlign: "left", cursor: "pointer" }}>
            <Callout kind="info" icon={ICONS.clock}>
              {selling.stage === "selling"
                ? `${prl(BigInt(selling.prl))} PRL is on the market. The USDT lands in your buying power once it sells.`
                : selling.stage === "sending"
                  ? `${prl(BigInt(selling.prl))} PRL is on its way to the exchange. It sells once it arrives.`
                  : `${prl(BigInt(selling.prl))} PRL is waiting to be sent for selling.`}
              {/* Only while it is confirming. Once it is on the market the
                  wait is for a buyer, which no timer can predict. */}
              {selling.stage === "sending" && sellTx && <SellProgress confirmations={sellTx.confirmations} />}
            </Callout>
          </button>
        )}
        {withdrawing && BigInt(withdrawing.usdt) > 0n && (
          /**
           * USDT that has left the balance and not arrived anywhere.
           *
           * Debited when the withdrawal is planned, so buying power drops
           * before anything is signed. "held" is said differently on
           * purpose: it means the relay gave up and nothing further will
           * happen on its own, and telling somebody their money is on its
           * way when it is stuck is worse than telling them nothing.
           */
          <Callout kind={withdrawing.stage === "held" ? "warn" : "info"} icon={ICONS.clock}>
            {withdrawing.stage === "held" ? (
              <>
                {usdt(Number(BigInt(withdrawing.usdt)) / 1e6)} USDT could not be sent and is on hold. Nothing further
                happens on its own. Ask support to release it, and the money goes back to your buying power so you can
                try again.
              </>
            ) : withdrawing.stage === "sending" ? (
              <>{usdt(Number(BigInt(withdrawing.usdt)) / 1e6)} USDT has been sent to your wallet and is confirming.</>
            ) : (
              <>{usdt(Number(BigInt(withdrawing.usdt)) / 1e6)} USDT is on its way to your wallet. It is signed and sent within a minute or so.</>
            )}
          </Callout>
        )}
    </>
  );

  return (
    <div className="screen">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", height: 54, padding: "0 8px 0 16px", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Logo size={28} />
          <button type="button" onClick={onWalletMenu} aria-haspopup="dialog"
            style={{ display: "flex", alignItems: "center", gap: 6, height: 36, padding: "0 10px 0 12px", border: "1px solid var(--border)", borderRadius: 18, background: "var(--surface)", fontSize: 13, fontWeight: 600, cursor: "pointer", maxWidth: 170 }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{walletName}</span>
            <Icon d={ICONS.down} size={14} />
          </button>
        </div>
        <div style={{ display: "flex", alignItems: "center" }}>
          <span className="chip info">{network}</span>
          <button type="button" className="icon-btn" aria-label="Refresh" onClick={onRefresh} disabled={refreshing}>
            <Icon d={ICONS.refresh} size={18} />
          </button>
          <button type="button" className="icon-btn" aria-label="Lock wallet" onClick={onLock}>
            <Icon d={ICONS.lock} size={19} />
          </button>
        </div>
      </div>

      <div className="body" style={{ gap: 12, padding: "0 16px 8px" }}>
        {IN_POPUP && moneyInTransit}
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span className="eyebrow">{price ? "Portfolio" : "Balance"}</span>
          <button type="button" onClick={flip} disabled={unitPrice === undefined}
            title={unitPrice === undefined ? undefined : inUsdt ? "Show it in PRL" : "Show it in USDT"}
            style={{ display: "flex", alignItems: "baseline", gap: 8, alignSelf: "flex-start", padding: 0, border: "none", background: "none", color: "var(--text)", textAlign: "left", cursor: unitPrice === undefined ? "default" : "pointer" }}>
            <span style={{ fontFamily: "var(--serif)", fontSize: 36, lineHeight: 1.05, letterSpacing: "-0.02em" }}>
              {!view
                ? "…"
                : inUsdt
                  ? usdt(counted * unitPrice! + cashValue)
                  : withWrapped
                    ? counted.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 })
                    : prl(balance)}
            </span>
            <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-2)" }}>{inUsdt ? "USDT" : "PRL"}</span>
          </button>
          {/* The change and the chart's shape on one line. They belong
              together: both are about the chart below, and giving the
              toggle a row of its own pushed the chart down for a control
              most people set once. */}
          <div className="muted" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, fontSize: 13, minHeight: 26 }}>
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {!view ? (
              error ? "Could not reach the network" : "Checking the network"
            ) : refreshing && !at ? (
              "Updating…"
            ) : price && diff !== undefined && pct !== undefined ? (
              <span className="mono" style={{ fontSize: 12.5, color: pct >= 0 ? "var(--accent)" : "var(--danger-text)" }}>
                {!inUsdt && unitPrice !== undefined && <span className="muted">≈ {usdt(counted * unitPrice + cashValue)} USDT · </span>}
                {inUsdt && held > 0 ? `${pct >= 0 ? "+" : "-"}${usdt(Math.abs(diff))} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)` : `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`}
                <span className="muted"> · {when}</span>
              </span>
            ) : (
              `${view.watchOnly ? "Confirmed" : "Spendable"} ${prl(view.spendable)} PRL`
            )}
            </span>
            {price && (
              <ChartStyleToggle style={style} disabled={!chart?.candles} onStyle={(s) => {
                setStyle(s);
                try { localStorage.setItem(STYLE_KEY, s); } catch { /* private mode */ }
              }} />
            )}
          </div>
        </div>

        {price && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <PriceChart chart={chart} hover={hover?.index ?? null} onHover={setHover} style={style} axis />
            <div style={{ display: "flex", gap: 2, justifyContent: "space-between" }}>
              {CHART_RANGES.map((r) => (
                <button key={r} type="button" className="pill" aria-pressed={r === range}
                  onClick={() => { setHover(null); onRange(r); }}>
                  {r}
                </button>
              ))}
            </div>
            {!chart && <span className="muted" style={{ fontSize: 11 }}>Fetching the {range} chart…</span>}
            {price.stale && <span className="muted" style={{ fontSize: 11 }}>Price may be out of date.</span>}
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: 4, padding: "2px 0" }}>
          <ActionButton label="Buy" icon={ICONS.plus} tone="buy" onClick={onBuy} />
          <ActionButton label="Sell" icon={ICONS.minus} tone="sell" onClick={onSell}
            disabled={!view || view.watchOnly || BigInt(view.spendable) === 0n}
            title={view?.watchOnly ? "Watch-only wallets have nothing to sell" : undefined} />
          <ActionButton label="Send" icon={ICONS.send} disabled={!view || view.watchOnly || BigInt(view.spendable) === 0n}
            title={view?.watchOnly ? "Watch-only wallets cannot send" : undefined} onClick={onSend} />
          <ActionButton label="Receive" icon={ICONS.receive} onClick={onReceive} />
        </div>

        {price && view && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6 }}>
            <div style={{ border: "1px solid var(--border)", borderRadius: 12, background: "var(--surface)", overflow: "hidden" }}>
              {/* Cash first, the way the design has it: what you can spend
                  before what you hold. */}
              <AssetRow
                icon={
                  // Its own mark, the way each coin has one. A fixed
                  // near-black rather than a theme token, so it reads the
                  // same in either theme.
                  <span className="dot-icon" style={{ background: "#0c0d10", color: "#f5f6f7" }}>
                    <Icon d={ICONS.cash} size={18} />
                  </span>
                }
                name="Buying power" sub="USDT cash" onOpen={onCash}
                value={usdt(cashValue)} unit="USDT" quiet={cashValue === 0} />
              <AssetRow icon={<CoinIcon mark={<PrlMark />} />} name="Pearl" onOpen={onToken}
                sub={`${prl(balance + kept)} PRL${kept > 0n ? ` (${prl(kept)} on exchange)` : ""}`}
                value={usdt((held + keptUnits) * price.usdPerPrl)} unit={`${usdtPrice(price.usdPerPrl)} USDT`} />
              <AssetRow icon={<CoinIcon mark={<PrlMark />} badge={<EthMark size={9} />} />} onOpen={onWrapped}
                name="Wrapped Pearl" quiet={!wrappedUnits}
                sub={wrappedUnits !== undefined ? `${wrappedUnits.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 })} wPRL` : "wPRL on Ethereum"}
                {...(wrappedUnits !== undefined ? { value: usdt(wrappedUnits * price.usdPerPrl) } : {})}
                unit={view.wrappedAddress
                  ? (wrappedUnits === undefined ? "Balance unavailable" : shortAddr(view.wrappedAddress, 6, 4))
                  : "Not connected"} />
            </div>
          </div>
        )}

        {!IN_POPUP && moneyInTransit}
        {view?.watchOnly && (
          <Callout kind="info" icon={ICONS.eye}>Watch only. Oyster follows this address without its keys, so it can show the balance but never send.</Callout>
        )}
        {error && (
          <>
            <Callout kind="danger">{error}</Callout>
            {!view && <Button variant="secondary" onClick={onRefresh} disabled={refreshing}>{refreshing ? "Trying again…" : "Try again"}</Button>}
          </>
        )}
        {unconfirmed !== 0n && (
          <Callout kind="warn" icon={ICONS.clock}>
            {unconfirmed > 0n ? `${prl(unconfirmed)} PRL arriving, waiting for a block.` : `${prl(-unconfirmed)} PRL leaving, waiting for a block.`}
          </Callout>
        )}
        {immature > 0n && (
          <Callout kind="info" icon={ICONS.chip}>
            {prl(immature)} PRL in mining rewards is maturing. Rewards can be spent 100 blocks after they are mined, about 5 hours.
          </Callout>
        )}
        {view && view.protectedCount > 0 && (
          <Callout kind="info" icon={ICONS.shield}>
            {view.protectedCount} small {view.protectedCount === 1 ? "output is" : "outputs are"} protected in case they carry PRC-20 tokens. Manage them in Settings.
          </Callout>
        )}

        {empty && (
          <button type="button" onClick={onMining} style={{ border: "none", padding: 0, background: "none", textAlign: "left", cursor: "pointer" }}>
            <Callout kind="info" icon={ICONS.chip}>
              Mining PRL? Turn on miner mode to get a fixed payout address for your pool, and payouts land here on their own.
            </Callout>
          </button>
        )}

        {view && <LastUpdated at={view.scannedAt} refreshing={refreshing} />}
      </div>
      <TabBar active="wallet" onTab={onTab} />
    </div>
  );
}

/** Dark modules on a white card in both themes: many scanners cannot read an
 *  inverted (light-on-dark) code. Quiet zone of 2 modules inside the card. */
function Qr({ text, size = 196 }: { text: string; size?: number }) {
  const cells = useMemo(() => encodeQR(text, "raw", { ecc: "medium", border: 2 }), [text]);
  const n = cells.length;
  const path = cells
    .flatMap((row, y) => row.map((on, x) => (on ? `M${x} ${y}h1v1h-1z` : "")))
    .join("");
  return (
    <svg viewBox={`0 0 ${n} ${n}`} width={size} height={size} role="img" aria-label="QR code of your address"
      shapeRendering="crispEdges" style={{ background: "#ffffff", borderRadius: 12, border: "1px solid var(--border)", alignSelf: "center", flexShrink: 0 }}>
      <path d={path} fill="#14161d" />
    </svg>
  );
}

/** One wallet, one address. No picking between derived addresses here: the
 *  address on this screen is the wallet's address, the same one pools and
 *  connected sites are given. */
export function Receive({ address, network, walletName, onBack }: {
  address?: string; network: NetworkId; walletName: string; onBack: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [asking, setAsking] = useState(false);
  const [amount, setAmount] = useState("");
  const [label, setLabel] = useState("");

  // With an amount, the QR carries a pearl: request rather than a bare
  // address, so the payer does not type the number themselves. The address
  // alone still works for any wallet that cannot read the link.
  const grains = amount.trim() ? parseAmount(amount) : null;
  const amountOk = !amount.trim() || (grains !== null && grains > 0n);
  const payload =
    address && asking && grains !== null && grains > 0n
      ? buildPaymentUri({ address, amount: grains, ...(label.trim() ? { label: label.trim().slice(0, 80) } : {}) })
      : address;

  const copy = async () => {
    if (!payload) return;
    await navigator.clipboard.writeText(payload);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="screen">
      <Header title="Receive PRL" onBack={onBack} />
      <div className="body">
        {payload ? <Qr text={payload} /> : <div style={{ width: 196, height: 196, alignSelf: "center" }} />}
        <div className="field">
          <span className="label">{walletName}{network === "mainnet" ? "" : ` · ${network}`}</span>
          <div className="mono" style={{ padding: 12, border: "1px solid var(--border)", borderRadius: 10, background: "var(--surface)", fontSize: 12.5, lineHeight: 1.55, wordBreak: "break-all", userSelect: "all" }}>
            {payload ?? "…"}
          </div>
        </div>
        {asking ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="field">
              <label htmlFor="askamt" className="label">Amount to ask for</label>
              <div className="input">
                <input id="askamt" inputMode="decimal" value={amount} placeholder="0.0000" autoFocus
                  onChange={(e) => setAmount(e.target.value)} />
                <span style={{ fontWeight: 600, color: "var(--text-2)" }}>PRL</span>
              </div>
              {!amountOk && <span className="error-text">That is not an amount.</span>}
            </div>
            <div className="field">
              <label htmlFor="asklabel" className="label">What it is for, optional</label>
              <div className="input">
                <input id="asklabel" value={label} maxLength={80} placeholder="Invoice 7" onChange={(e) => setLabel(e.target.value)} />
              </div>
            </div>
            <button type="button" onClick={() => { setAsking(false); setAmount(""); setLabel(""); }}
              style={{ alignSelf: "flex-start", padding: 0, border: "none", background: "none", color: "var(--accent)", fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>
              Just the address
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setAsking(true)}
            style={{ alignSelf: "flex-start", padding: 0, border: "none", background: "none", color: "var(--accent)", fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>
            Ask for a set amount
          </button>
        )}
        <Button onClick={copy} disabled={!payload}>
          <Icon d={copied ? ICONS.check : ICONS.copy} />{copied ? "Copied" : asking && grains ? "Copy request" : "Copy address"}
        </Button>
        <Callout kind="warn">Native PRL on the Pearl network only. wPRL sent from Ethereum will not arrive here. Use the bridge first.</Callout>
      </div>
    </div>
  );
}

type Filter = "all" | "prl" | "trades" | "cash";

/**
 * One movement of money inside Oyster.
 *
 * Said in the words somebody would use about their own account rather than
 * the ledger's: a payout of USDT is a withdrawal, a payout of PRL is coins
 * being sent to their wallet, and an adjustment is money given back.
 */
function CashRow({ entry }: { entry: CashEntry }) {
  const micros = BigInt(entry.amount);
  const out = micros < 0n;
  const abs = out ? -micros : micros;
  const shown = entry.asset === "usdt" ? `${usdt(Number(abs) / 1e6)} USDT` : `${prl(abs)} PRL`;

  const title = (() => {
    switch (entry.kind) {
      case "deposit": return "Deposited";
      case "buy": return out ? "Spent on PRL" : "Bought PRL";
      case "sell": return out ? "Sold PRL" : "Sale proceeds";
      case "fee": return "Oyster fee";
      case "payout": return entry.asset === "usdt" ? "Withdrew" : "Sent to your wallet";
      case "adjustment": return out ? "Adjustment" : "Returned";
      default: return entry.kind;
    }
  })();

  return (
    <div className="list-row" style={{ padding: "0 2px", cursor: "default" }}>
      <span className="dot-icon">
        <Icon d={entry.kind === "fee" ? ICONS.trade : out ? ICONS.send : ICONS.receive} size={17} />
      </span>
      <span className="main">
        <span className="t">{title}</span>
        <span className="s">{ago(Math.floor(entry.at / 1000))}</span>
      </span>
      <span className={`mono ${out ? "" : "pos"}`} style={{ fontSize: 13 }}>
        {out ? "-" : "+"}{shown}
      </span>
    </div>
  );
}

export function Activity({ view, price, incoming, onTab, onOpenTx, onLoadMore, loadingMore, onMining }: {
  view?: WalletView; price?: PriceView; onTab: (t: Tab) => void; onOpenTx: (tx: WireTx) => void; onLoadMore: () => void; loadingMore?: boolean;
  /** PRL bought but not yet in the wallet. See `AccountView.incoming`. */
  incoming?: AccountView["incoming"];
  onMining: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [trades, setTrades] = useState<TradesView | null>();
  const [history, setHistory] = useState<CashEntry[] | null>();
  /** Which fill is open. One at a time, so the list stays a list. */
  const [openTrade, setOpenTrade] = useState<string | number | null>(null);
  const onTheWay = incoming && BigInt(incoming.prl) > 0n ? incoming : undefined;

  // Trades come from the exchange, transactions from the chain. They are
  // different sources, so the tab that shows both has to ask twice.
  useEffect(() => {
    call({ type: "accountTrades" }).then(setTrades, () => setTrades(null));
    call({ type: "accountHistory" }).then(setHistory, () => setHistory(null));
  }, []);

  /**
   * Cash is USDT only, and fees are left out.
   *
   * Oyster's cut is charged in PRL and shows on the PRL side; listing it
   * here would be a row whose amount has nothing to do with the balance
   * above it.
   */
  const cashRows = (history ?? []).filter((e) => e.asset === "usdt");
  const [exporting, setExporting] = useState(false);
  const exportCsv = async () => {
    setExporting(true);
    try {
      const { file, name } = await call({ type: "historyCsv" });
      const url = URL.createObjectURL(new Blob([file], { type: "text/csv" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch { /* the button simply does nothing rather than shouting */ }
    setExporting(false);
  };

  const isFee = (tx: WireTx) => tx.counterparty === FEE_ADDRESS.mainnet || tx.counterparty === FEE_ADDRESS.testnet2;
  const shown = (view?.txs ?? []).filter((tx) => (filter === "prl" ? !isFee(tx) : true));

  return (
    <div className="screen">
      <div style={{ display: "flex", alignItems: "center", height: 52, padding: "0 16px", flexShrink: 0 }}>
        <div style={{ fontFamily: "var(--serif)", fontSize: 24, fontWeight: 500 }}>Activity</div>
        <div className="spacer" />
        <button type="button" onClick={onMining}
          style={{ display: "flex", alignItems: "center", gap: 5, height: 44, padding: "0 2px", border: "none", background: "none", color: "var(--accent)", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
          <Icon d={ICONS.chip} size={16} />Mining
        </button>
      </div>
      <div className="body" style={{ gap: 10, padding: "0 16px 8px" }}>
        <div style={{ display: "flex", gap: 4 }} role="tablist" aria-label="What to show">
          {(["all", "prl", "trades", "cash"] as Filter[]).map((f) => (
            <button key={f} type="button" role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}
              style={{ flexGrow: 1, height: 30, borderRadius: 8, border: "none", cursor: "pointer", fontSize: 12, fontWeight: filter === f ? 600 : 500,
                background: filter === f ? "var(--accent-soft)" : "transparent", color: filter === f ? "var(--accent-soft-text)" : "var(--text-3)" }}>
              {f === "all" ? "All" : f === "prl" ? "PRL" : f === "trades" ? "Trades" : "Cash"}
            </button>
          ))}
        </div>

        {filter === "trades" ? (
          !trades?.open ? (
            <p className="muted" style={{ textAlign: "center", padding: "20px 0" }}>
              Trades show here once buying and selling are open.
            </p>
          ) : trades.trades.length === 0 ? (
            <p className="muted" style={{ textAlign: "center", padding: "20px 0" }}>No trades yet.</p>
          ) : (
            <>
              {onTheWay && (
                /* Above the fills, because it is the thing they came to
                   check: the buy went through and the PRL has not landed. */
                <Callout kind="info" icon={ICONS.clock}>
                  {prl(BigInt(onTheWay.prl))} PRL is on the way to your wallet.
                </Callout>
              )}
              {trades.trades.map((t) => {
                const open = openTrade === t.id;
                return (
                  <div key={t.id} style={{ display: "flex", flexDirection: "column" }}>
                    <button type="button" className="list-row" aria-expanded={open}
                      onClick={() => setOpenTrade(open ? null : t.id)}
                      style={{ padding: "0 2px", border: "none", background: "none", textAlign: "left", cursor: "pointer", width: "100%" }}>
                      <span className="dot-icon"><Icon d={ICONS.trade} size={17} /></span>
                      <span className="main">
                        <span className="t" style={{ color: t.side === "buy" ? "var(--buy)" : "var(--sell)" }}>
                          {t.side === "buy" ? "Bought" : "Sold"} {prl(Math.round(Number(t.amount) * 1e8).toString())} PRL
                        </span>
                        {/* The price it actually filled at, which is the whole
                            reason this reads fills rather than orders. */}
                        <span className="s">
                          at {t.price} USDT · {ago(t.t)}
                        </span>
                      </span>
                      <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
                        <span className="mono" style={{ fontSize: 12.5 }}>{t.total} USDT</span>
                        {Number(t.fee) > 0 && (
                          <span className="muted mono" style={{ fontSize: 11 }}>
                            fee {t.fee} {t.feeCurrency.toUpperCase()}
                          </span>
                        )}
                      </span>
                    </button>
                    {open && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "2px 2px 10px 42px" }}>
                        <div className="kv">
                          <div><span className="k">Filled at</span><span className="v">{t.price} USDT</span></div>
                          <div><span className="k">{t.side === "buy" ? "Cost" : "Proceeds"}</span><span className="v">{t.total} USDT</span></div>
                          {Number(t.fee) > 0 && (
                            <div><span className="k">Exchange fee</span><span className="v">{t.fee} {t.feeCurrency.toUpperCase()}</span></div>
                          )}
                          <div><span className="k">When</span><span className="v">{new Date(t.t).toLocaleString()}</span></div>
                        </div>
                        {t.side === "buy" && (
                          /**
                           * Delivery is not per order: one payment carries
                           * whatever PRL is free at the time, which may be
                           * several fills at once. So this says what is
                           * true, which is that some is on its way, rather
                           * than inventing a number for this row.
                           */
                          <span className="muted" style={{ fontSize: 12 }}>
                            {onTheWay
                              ? onTheWay.stage === "sending"
                                ? `${prl(BigInt(onTheWay.prl))} PRL has been sent to your wallet and is waiting for a block.`
                                : `${prl(BigInt(onTheWay.prl))} PRL is on the way to your wallet.`
                              : "The PRL is in your wallet."}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          )
        ) : filter === "cash" ? (
          /**
           * Money that moved inside Oyster rather than on a chain.
           *
           * The chain knows about PRL and nothing else. USDT arriving,
           * being spent on PRL and leaving again happens entirely in the
           * relay's ledger, so without this the cash tab could only ever
           * have shown a balance and never how it got there.
           */
          history === undefined ? (
            <span className="muted">Loading…</span>
          ) : history === null ? (
            <p className="muted" style={{ textAlign: "center", padding: "20px 0" }}>
              The relay could not be reached, so this is unknown right now. It is not empty.
            </p>
          ) : cashRows.length === 0 ? (
            <p className="muted" style={{ textAlign: "center", padding: "20px 0" }}>
              No cash has moved yet. Deposits, buys, sells and withdrawals show here.
            </p>
          ) : (
            cashRows.map((e) => <CashRow key={`${e.kind}:${e.ref}:${e.at}`} entry={e} />)
          )
        ) : !view ? (
          <span className="muted">Loading…</span>
        ) : shown.length === 0 ? (
          <div style={{ flexGrow: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, textAlign: "center" }}>
            <span className="dot-icon" style={{ width: 52, height: 52, borderRadius: 26 }}><Icon d={ICONS.activity} size={24} /></span>
            <div style={{ fontFamily: "var(--serif)", fontSize: 22 }}>Nothing here yet</div>
            <p className="lead" style={{ maxWidth: 260 }}>Payments you send and receive will show up here.</p>
          </div>
        ) : (
          <>
            {shown.map((tx) => <TxRow key={tx.txid} tx={tx} price={price} onOpen={() => onOpenTx(tx)} />)}
            {!view.historyComplete && (
              <Button variant="ghost" disabled={loadingMore} onClick={onLoadMore}>
                {loadingMore ? "Loading older activity…" : "Show older activity"}
              </Button>
            )}
            <Button variant="ghost" disabled={exporting} onClick={exportCsv}>
              {exporting ? "Preparing…" : "Export as CSV"}
            </Button>
          </>
        )}
      </div>
      <TabBar active="activity" onTab={onTab} />
    </div>
  );
}

/** After a send, and for any row in Activity. Polls until 6 confirmations.
 *  A pending send can be sped up: the replacement pays the same recipient the
 *  same amount at a higher fee, and the original can then never confirm. */
export function TxDetail({ tx: initial, network, onDone }: { tx: WireTx; network: NetworkId; onDone: () => void }) {
  const [tx, setTx] = useState(initial);
  const [conf, setConf] = useState(initial.confirmations);
  const [bump, setBump] = useState<SpeedUpQuote | "loading">();
  const [cancel, setCancel] = useState<CancelQuote | "loading">();
  const [bumping, setBumping] = useState(false);
  const [replaced, setReplaced] = useState<string>();
  const [cancelled, setCancelled] = useState(false);
  // A note is the only way to know, a year later, what a payment was for.
  const [note, setNote] = useState("");
  const [noteSaved, setNoteSaved] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    call({ type: "txNotes" }).then((n) => setNote(n[tx.txid] ?? ""), () => {});
  }, [tx.txid]);

  useEffect(() => {
    if (conf >= 6) return;
    const tick = async () => {
      try {
        const s = await call({ type: "txStatus", txid: tx.txid });
        if (s.found) setConf(s.confirmations);
      } catch { /* keep the last known state */ }
    };
    void tick();
    const t = setInterval(tick, 15_000);
    return () => clearInterval(t);
  }, [tx.txid, conf >= 6]);

  const incoming = tx.direction === "received";
  const pending = conf === 0;
  const canSpeedUp = pending && !incoming;
  const title = pending
    ? incoming ? "Incoming, waiting for a block" : "Sent, waiting for a block"
    : incoming ? "Received" : tx.direction === "self" ? "Moved" : "Sent";

  const quoteCancel = async () => {
    setError(undefined);
    setCancel("loading");
    try {
      setCancel(await call({ type: "quoteCancel", txid: tx.txid }));
    } catch (e) {
      setCancel(undefined);
      setError((e as RpcError).message);
    }
  };

  const confirmCancel = async () => {
    setBumping(true);
    setError(undefined);
    try {
      const r = await call({ type: "cancelSend", txid: tx.txid });
      setReplaced(tx.txid);
      setTx({ ...tx, txid: r.txid, direction: "self", counterparty: r.quote.to, fee: r.quote.newFee, net: (-BigInt(r.quote.newFee)).toString() });
      setConf(0);
      setCancel(undefined);
      setCancelled(true);
    } catch (e) {
      setError((e as RpcError).message);
    } finally {
      setBumping(false);
    }
  };

  const quoteBump = async () => {
    setError(undefined);
    setBump("loading");
    try {
      setBump(await call({ type: "quoteSpeedUp", txid: tx.txid }));
    } catch (e) {
      setBump(undefined);
      setError((e as RpcError).message);
    }
  };

  const confirmBump = async () => {
    setBumping(true);
    setError(undefined);
    try {
      const r = await call({ type: "speedUp", txid: tx.txid });
      const extra = BigInt(r.quote.newFee) - BigInt(r.quote.oldFee);
      setReplaced(tx.txid);
      setTx({ ...tx, txid: r.txid, fee: r.quote.newFee, net: (BigInt(tx.net) - extra).toString() });
      setConf(0);
      setBump(undefined);
    } catch (e) {
      setError((e as RpcError).message);
    } finally {
      setBumping(false);
    }
  };

  return (
    <div className="screen">
      <Header title="Transaction" onBack={onDone} />
      <div className="body">
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "6px 0", textAlign: "center" }}>
          <span style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 52, height: 52, borderRadius: 26,
            background: pending ? "var(--warn-bg)" : "var(--accent-soft)", color: pending ? "var(--warn-text)" : "var(--accent-soft-text)" }}>
            <Icon d={pending ? ICONS.clock : ICONS.check} size={24} />
          </span>
          <div style={{ fontFamily: "var(--serif)", fontSize: 24 }}>{title}</div>
          <div className="muted" style={{ fontSize: 13 }}>
            {pending ? "Pearl blocks arrive about every 3 minutes" : `${conf}${conf >= 6 ? "+" : ""} confirmation${conf === 1 ? "" : "s"}`}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ height: 6, borderRadius: 3, background: "var(--divider)", overflow: "hidden" }}>
            <div style={{ width: `${Math.max(8, Math.min(100, (conf / 6) * 100))}%`, height: 6, background: pending ? "var(--warn-text)" : "var(--accent)", transition: "width .4s" }} />
          </div>
          <div className="mono muted" style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
            <span>{pending ? "broadcast" : "confirmed"}</span><span>{Math.min(conf, 6)}{conf >= 6 ? "+" : ""} / 6 confirmations</span>
          </div>
        </div>
        <div className="kv">
          <div><span className="k">Amount</span><span className="v">{BigInt(tx.net) > 0n ? "+" : ""}{prlExact(tx.net)} PRL</span></div>
          {!incoming && <div><span className="k">Fee</span><span className="v">{prlExact(tx.fee)} PRL</span></div>}
          {tx.counterparty && <div><span className="k">To</span><span className="v">{shortAddr(tx.counterparty)}</span></div>}
          <div><span className="k">Tx ID</span><span className="v">{shortTxid(tx.txid)}</span></div>
        </div>
        {replaced && (
          <Callout kind="info" icon={ICONS.check}>
            {cancelled
              ? `Cancelled. This replaces ${shortTxid(replaced)}, which can no longer confirm, and the PRL comes back to you.`
              : `Sped up. This replaces ${shortTxid(replaced)}, which can no longer confirm. The recipient still gets the same amount.`}
          </Callout>
        )}
        {canSpeedUp && !bump && !cancel && !replaced && (
          <div className="row-2">
            <Button variant="secondary" onClick={quoteCancel}>Cancel payment</Button>
            <Button variant="secondary" onClick={quoteBump}>Speed up</Button>
          </div>
        )}
        {cancel === "loading" && <span className="muted">Working out what comes back…</span>}
        {cancel && cancel !== "loading" && (
          <>
            <Callout kind="warn">
              This sends the PRL back to your own wallet at a higher fee, so the original cannot confirm. It is not a guarantee: if the payment is already in a block, it stands.
            </Callout>
            <div className="kv">
              <div><span className="k">Comes back</span><span className="v">{prlExact(cancel.returned)} PRL</span></div>
              <div><span className="k">Cancellation fee</span><span className="v">{prlExact(cancel.newFee)} PRL</span></div>
            </div>
          </>
        )}
        {bump === "loading" && <span className="muted">Working out the new fee…</span>}
        {bump && bump !== "loading" && (
          <div className="kv">
            <div><span className="k">Current fee</span><span className="v">{prlExact(bump.oldFee)} PRL</span></div>
            <div><span className="k">New fee</span><span className="v">{prlExact(bump.newFee)} PRL</span></div>
            <div><span className="k">Extra cost</span><span className="v">{prlExact(BigInt(bump.newFee) - BigInt(bump.oldFee))} PRL</span></div>
          </div>
        )}
        <div className="field">
          <label htmlFor="txnote" className="label">Note, only you see it</label>
          <div className="input">
            <input id="txnote" value={note} maxLength={200} placeholder="What was this for?"
              onChange={(e) => { setNote(e.target.value); setNoteSaved(false); }}
              onBlur={() => { void call({ type: "txNote", txid: tx.txid, note }).then(() => setNoteSaved(true), () => {}); }}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
            {noteSaved && <Icon d={ICONS.check} size={16} />}
          </div>
        </div>
        {error && <Callout kind="danger">{error}</Callout>}
        <div className="spacer" />
        {cancel && cancel !== "loading" ? (
          <div className="row-2">
            <Button variant="secondary" disabled={bumping} onClick={() => setCancel(undefined)}>Keep it</Button>
            <Button disabled={bumping} onClick={confirmCancel}>{bumping ? "Cancelling…" : "Cancel payment"}</Button>
          </div>
        ) : bump && bump !== "loading" ? (
          <div className="row-2">
            <Button variant="secondary" disabled={bumping} onClick={() => setBump(undefined)}>Keep it</Button>
            <Button disabled={bumping} onClick={confirmBump}>{bumping ? "Sending…" : "Pay higher fee"}</Button>
          </div>
        ) : (
          <div className="row-2">
            <Button variant="secondary" onClick={() => openExplorer(network, tx.txid)}>Explorer<Icon d={ICONS.external} size={16} /></Button>
            <Button onClick={onDone}>Done</Button>
          </div>
        )}
      </div>
    </div>
  );
}


/**
 * Coin control: which coins move.
 *
 * A UTXO wallet spends whole coins, and picking them is how a careful owner
 * keeps two sets of funds from touching. Chosen coins are spent whole: the
 * wallet adds none and drops none. Protected coins are shown but cannot be
 * picked here; unfreezing one is a deliberate trip to Settings.
 */
export function Coins({ selected, onBack, onDone }: {
  selected: string[];
  onBack: () => void;
  onDone: (outpoints: string[]) => void;
}) {
  const [coins, setCoins] = useState<Coin[]>();
  const [picked, setPicked] = useState<string[]>(selected);
  const [error, setError] = useState<string>();

  useEffect(() => {
    call({ type: "coins" }).then(setCoins, (e: RpcError) => setError(e.message));
  }, []);

  const toggle = (c: Coin) => {
    if (c.frozen || c.immature) return;
    setPicked((p) => (p.includes(c.outpoint) ? p.filter((x) => x !== c.outpoint) : [...p, c.outpoint]));
  };
  const total = (coins ?? [])
    .filter((c) => picked.includes(c.outpoint))
    .reduce((t, c) => t + BigInt(c.value), 0n);

  return (
    <div className="screen">
      <Header title="Choose coins" onBack={onBack} />
      <div className="body" style={{ gap: 8 }}>
        <p className="lead" style={{ margin: 0 }}>
          Pick the coins to spend, or pick none and let Oyster choose. Chosen coins are spent whole.
        </p>
        {error && <Callout kind="danger">{error}</Callout>}
        {!coins ? (
          <span className="muted">Loading\u2026</span>
        ) : coins.length === 0 ? (
          <span className="muted">This wallet holds no coins yet.</span>
        ) : (
          coins.map((c) => {
            const on = picked.includes(c.outpoint);
            const locked = c.frozen || c.immature;
            return (
              <button key={c.outpoint} type="button" onClick={() => toggle(c)} disabled={locked}
                style={{ display: "flex", alignItems: "center", gap: 10, padding: 10, borderRadius: 10, textAlign: "left", cursor: locked ? "not-allowed" : "pointer",
                  border: `1.5px solid ${on ? "var(--accent)" : "var(--border)"}`, background: on ? "var(--accent-soft)" : "var(--surface)", opacity: locked ? 0.55 : 1 }}>
                <span style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 20, height: 20, borderRadius: 6, flexShrink: 0,
                  border: `1.5px solid ${on ? "var(--accent)" : "var(--border)"}`, background: on ? "var(--accent)" : "transparent", color: "var(--on-accent)" }}>
                  {on && <Icon d={ICONS.check} size={13} />}
                </span>
                <span style={{ display: "flex", flexDirection: "column", minWidth: 0, flexGrow: 1 }}>
                  <span className="mono" style={{ fontSize: 13.5 }}>{prl(c.value)} PRL</span>
                  <span className="s mono" style={{ fontSize: 11.5, color: "var(--text-3)" }}>
                    {shortTxid(c.txid)}:{c.vout}
                  </span>
                </span>
                {c.immature && <span className="chip warn">maturing</span>}
                {c.frozen && <span className="chip info">protected</span>}
                {!locked && c.confirmations === 0 && <span className="chip warn">pending</span>}
              </button>
            );
          })
        )}
        <div className="spacer" />
        <div className="kv">
          <div><span className="k">Chosen</span><span className="v">{picked.length === 0 ? "none, Oyster decides" : `${picked.length} coin${picked.length === 1 ? "" : "s"}`}</span></div>
          {picked.length > 0 && <div><span className="k">Together</span><span className="v">{prl(total)} PRL</span></div>}
        </div>
        <div className="row-2">
          <Button variant="secondary" onClick={() => setPicked([])}>Clear</Button>
          <Button onClick={() => onDone(picked)}>Use these</Button>
        </div>
      </div>
    </div>
  );
}
