import {
  amountForSpend,
  formatUnits,
  MIN_ORDER_GRAINS,
  parseUnits,
  priceUnits,
  roundAmount,
  sellableOnExchange,
  splitSell,
} from "@pearl-wallet/core";
import { useEffect, useState } from "react";
import type { DepthLevel, DepthView, MarketTrade, MyOrder, MyOrdersView, OrderQuote, PriceView, WalletView } from "../../messages";
import { usdt, usdtPrice } from "../chart";
import { Button, Callout, Header, ICONS, TabBar, type Tab } from "../components";
import { ago, shortAddr } from "../format";
import { call, RpcError } from "../rpc";

/**
 * Buying and selling PRL, on one screen.
 *
 * Buy and sell are the same page with the side switched, because they are
 * the same decision from two directions and splitting them doubles the
 * screens for nothing. The book sits above the form rather than below it:
 * PRL's book is thin, so the price depends on the size asked for, and that
 * is worth seeing before typing a number rather than after.
 *
 * Fees are never folded into a total: the exchange's and Oyster's each get a
 * line, in the currency they are actually taken in.
 */

/**
 * Measured on the live account 2026-09-22, not taken from the published page:
 * maker and taker are both 0.001, and the fee is charged in the currency
 * received, so PRL on a buy and USDT on a sell.
 */
const EXCHANGE_FEE_RATE = 0.001;
const OYSTER_FEE_RATE = 0.0125;

export type Side = "buy" | "sell";
type Kind = "market" | "limit";

/**
 * How far from the ticker a market order may fill before the screen refuses.
 *
 * A thin book means a large order can walk a long way up it, and the quote
 * is a moment old by the time anyone taps. This is the ceiling on how bad
 * "a moment old" is allowed to be.
 */
const SLIPPAGE_CHOICES = [0.5, 1, 2, 5] as const;
const DEFAULT_SLIPPAGE = 1;

const prl4 = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 });

/** Depth rows, with a bar behind each price showing its size against the
 *  largest on screen: the shape of the book at a glance. */
function BookSide({ levels, side, max }: { levels: DepthLevel[]; side: "ask" | "bid"; max: number }) {
  const colour = side === "ask" ? "var(--danger-text)" : "var(--accent)";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      {levels.map((l, i) => (
        <div key={`${l.price}-${i}`} style={{ position: "relative", display: "flex", justifyContent: "space-between", padding: "3px 6px", fontSize: 11.5 }}>
          <span style={{ position: "absolute", inset: "0 auto 0 0", width: `${Math.max(2, (l.amount / max) * 100)}%`, background: colour, opacity: 0.13, borderRadius: 3 }} />
          <span className="mono" style={{ position: "relative", color: colour }}>{usdtPrice(l.price)}</span>
          <span className="mono" style={{ position: "relative", color: "var(--text-2)" }}>
            {l.amount.toLocaleString("en-US", { maximumFractionDigits: 2 })}
          </span>
        </div>
      ))}
      {levels.length === 0 && <span className="muted" style={{ padding: "3px 6px", fontSize: 11.5 }}>nothing on this side</span>}
    </div>
  );
}

function Book({ depth }: { depth: DepthView | null | undefined }) {
  if (depth === undefined) return <span className="muted" style={{ fontSize: 12.5 }}>Reading the book…</span>;
  if (depth === null) {
    return (
      <Callout kind="warn">
        The order book is not available, so there is nothing to price an order against. Trading stays closed until it
        is back.
      </Callout>
    );
  }
  const asks = depth.asks.slice(0, 6);
  const bids = depth.bids.slice(0, 6);
  const max = Math.max(1, ...asks.map((l) => l.amount), ...bids.map((l) => l.amount));
  const best = { ask: depth.asks[0]?.price, bid: depth.bids[0]?.price };
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 10, background: "var(--surface)", padding: 4 }}>
      {/* Sellers above, buyers below: price rises as the eye goes up. */}
      <BookSide levels={[...asks].reverse()} side="ask" max={max} />
      <div style={{ display: "flex", justifyContent: "center", padding: "5px 0", borderTop: "1px solid var(--divider)", borderBottom: "1px solid var(--divider)", margin: "3px 0" }}>
        <span className="mono" style={{ fontSize: 12.5 }}>
          {best.bid !== undefined && best.ask !== undefined ? `${usdtPrice(best.bid)} · ${usdtPrice(best.ask)}` : "no market"}
        </span>
      </div>
      <BookSide levels={bids} side="bid" max={max} />
    </div>
  );
}

/** Remembers "Keep on exchange" between buys. A per-person convenience, so the popup's own storage. */
const KEEP_KEY = "oyster.keepOnExchange";

export function Trade({ side, onSide, price, view, cashUsdt, onTab, onCash }: {
  side: Side;
  onSide: (s: Side) => void;
  price?: PriceView;
  view?: WalletView;
  /** USDT available to spend, until the relay says otherwise. */
  cashUsdt: number;
  onTab: (t: Tab) => void;
  onCash: () => void;
}) {
  const [kind, setKind] = useState<Kind>("market");
  const [input, setInput] = useState("");
  const [limitPrice, setLimitPrice] = useState("");
  const [quote, setQuote] = useState<OrderQuote | null>();
  const [depth, setDepth] = useState<DepthView | null>();
  const [trades, setTrades] = useState<MarketTrade[] | null>();
  const [mine, setMine] = useState<MyOrdersView | null>();
  const [cancelling, setCancelling] = useState<number>();
  const [orderError, setOrderError] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [placed, setPlaced] = useState<MyOrder>();
  /** A sell that has been sent, waiting on the chain. */
  const [sold, setSold] = useState<{ amount: string; txid: string }>();
  /** The wallet half of a sell that was split: the exchange half is `placed`. */
  const [alsoSent, setAlsoSent] = useState<{ amount: string; txid: string }>();
  /**
   * Buys only: leave the PRL on the exchange, where selling it is instant, or
   * have it sent to this wallet. Remembered, so it is set once.
   */
  const [keep, setKeepState] = useState<boolean>(() => {
    try {
      return localStorage.getItem(KEEP_KEY) === "1";
    } catch {
      return false;
    }
  });
  const setKeep = (k: boolean) => {
    setKeepState(k);
    try {
      localStorage.setItem(KEEP_KEY, k ? "1" : "0");
    } catch {
      /* remembered for this screen only */
    }
  };
  const [slippage, setSlippage] = useState<number>(DEFAULT_SLIPPAGE);

  // Buy takes USDT to spend; sell takes PRL to sell.
  const n = Number(input.replace(/,/g, ""));
  const amountOk = Number.isFinite(n) && n > 0;
  const limitNum = Number(limitPrice);
  const limitOk = kind === "market" || (Number.isFinite(limitNum) && limitNum > 0);

  /**
   * What is actually spendable, which is what the relay holds and not what
   * the wallet holds.
   *
   * Both sides are balances on the relay. PRL bought is delivered to the
   * wallet, and PRL to be sold has to reach the exchange first, so the coins
   * sitting in this wallet are not what a sell spends. Offering them would
   * be offering something the relay will refuse.
   *
   * After open orders, too: an order already waiting is holding part of it.
   */
  const heldUsdt = mine ? Number(BigInt(mine.spendable.usdt)) / 1e6 : cashUsdt;
  /**
   * A sell spends the PRL in this wallet.
   *
   * It used to spend a balance on the relay, which meant sending PRL there
   * first and coming back later. Now the wallet sends it as part of
   * selling, so what can be sold is what this wallet can spend.
   */
  const walletPrl = view ? Number(BigInt(view.spendable)) / 1e8 : 0;
  /** PRL already on the exchange, which a sell uses first because it sells at once. */
  const exchangeGrains = mine ? sellableOnExchange(BigInt(mine.spendable.prl)) : 0n;
  const exchangePrl = Number(exchangeGrains) / 1e8;
  const enough = side === "buy" ? n <= heldUsdt : n <= walletPrl + exchangePrl;
  /** How a sell of what is typed would be split, for the review screen. */
  const sellSplit = side === "sell" && amountOk ? splitSell(roundAmount(parseUnits(input, 8)), exchangeGrains) : undefined;

  useEffect(() => {
    let live = true;
    const load = () => {
      call({ type: "depth" }).then((d) => live && setDepth(d), () => live && setDepth(null));
      call({ type: "marketTrades" }).then((t) => live && setTrades(t), () => live && setTrades(null));
      // This wallet's own orders and balances, not the operator's view of
      // the whole exchange account.
      call({ type: "myOrders" }).then((o) => live && setMine(o), () => live && setMine(null));
    };
    load();
    const timer = setInterval(load, 6_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (kind !== "market" || !amountOk) return setQuote(undefined);
    let live = true;
    setQuote(undefined);
    const timer = setTimeout(() => {
      const of = side === "buy" ? { spend: n } : { amount: n };
      call({ type: "orderQuote", side, ...of }).then((q) => live && setQuote(q), () => live && setQuote(null));
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [kind, side, n, amountOk]);

  const avgPrice = kind === "limit" ? (limitOk ? limitNum : 0) : quote?.avgPrice ?? 0;

  // Buy: USDT in, PRL out, both fees taken from the PRL.
  // Sell: PRL out, USDT in. Oyster's fee is an output of the wallet's own
  // transaction, so it comes off the PRL before the exchange sees it; the
  // exchange's fee comes off the USDT that comes back.
  const buy = {
    gross: avgPrice > 0 && amountOk ? n / avgPrice : 0,
    get exchangeFee() { return this.gross * EXCHANGE_FEE_RATE; },
    get oysterFee() { return this.gross * OYSTER_FEE_RATE; },
    get delivered() { return Math.max(0, this.gross - this.exchangeFee - this.oysterFee); },
  };
  const sell = {
    oysterFee: amountOk ? n * OYSTER_FEE_RATE : 0,
    get sent() { return Math.max(0, n - this.oysterFee); },
    get proceeds() { return avgPrice > 0 ? this.sent * avgPrice : 0; },
    get exchangeFee() { return this.proceeds * EXCHANGE_FEE_RATE; },
    get received() { return Math.max(0, this.proceeds - this.exchangeFee); },
  };

  // Against the ticker, and only in the direction that costs the user: a buy
  // filling below the ticker is a gift, not a problem.
  const drift =
    kind === "market" && quote && price && price.usdPerPrl > 0
      ? ((side === "buy" ? quote.avgPrice - price.usdPerPrl : price.usdPerPrl - quote.avgPrice) / price.usdPerPrl) * 100
      : 0;
  const tooFar = drift > slippage;

  const ready =
    amountOk && limitOk && enough && !tooFar && (kind === "limit" || (quote !== null && quote !== undefined));

  if (sold) {
    const done = () => {
      setSold(undefined);
      setConfirming(false);
      setInput("");
      setQuote(undefined);
    };
    return (
      <div className="screen">
        <Header title="Sell sent" onBack={done} />
        <div className="body">
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: "18px 0" }}>
            <span style={{ fontFamily: "var(--serif)", fontSize: 30 }}>{sold.amount} PRL</span>
            <span className="muted" style={{ fontSize: 12.5 }}>on its way to the exchange</span>
          </div>

          {/* The wait is the part nobody expects, so it is the part that
              gets the room. */}
          <Callout kind="info" icon={ICONS.clock}>
            The exchange counts a PRL deposit after 10 blocks, about half an hour. It sells as soon as it lands, at
            whatever PRL is worth then, and the USDT appears in your buying power.
          </Callout>

          <div className="kv">
            <div><span className="k">Sent</span><span className="v">{sold.amount} PRL</span></div>
            <div><span className="k">Payment</span><span className="v mono" style={{ fontSize: 11.5 }}>{shortAddr(sold.txid, 8, 6)}</span></div>
          </div>

          <span className="muted" style={{ fontSize: 11.5 }}>
            Nothing more to do. You can close the wallet; this finishes on its own.
          </span>

          <div className="spacer" />
          <Button onClick={done}>Done</Button>
        </div>
      </div>
    );
  }

  if (placed) {
    const done = () => {
      setPlaced(undefined);
      setAlsoSent(undefined);
      setConfirming(false);
      setInput("");
      setQuote(undefined);
    };
    return (
      <div className="screen">
        <Header title="Order placed" onBack={done} />
        <div className="body">
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: "18px 0" }}>
            <span style={{ fontFamily: "var(--serif)", fontSize: 30 }}>
              {placed.side === "buy" ? "Buying" : "Selling"} {placed.amountPrl} PRL
            </span>
            <span className="muted" style={{ fontSize: 12.5 }}>
              {placed.reservedAsset === "usdt"
                ? `${formatUnits(BigInt(placed.reserved), 6)} USDT set aside`
                : `${formatUnits(BigInt(placed.reserved), 8)} PRL set aside`}
            </span>
          </div>

          {/* What is set aside is a ceiling, not a cost. A buy that fills
              below the limit gives the rest back, and saying so here saves
              somebody wondering where the difference went. */}
          <Callout kind="info">
            That is the most it can use. Anything it does not need comes back when the order finishes.
          </Callout>

          {placed.side === "buy" && placed.keep ? (
            <Callout kind="info" icon={ICONS.clock}>
              It waits on the exchange until somebody takes the other side. Once it fills, the PRL stays there, ready to
              sell instantly. Send it to your wallet any time from Buying power.
            </Callout>
          ) : placed.side === "buy" ? (
            <Callout kind="info" icon={ICONS.clock}>
              It waits on the exchange until somebody takes the other side. Once it fills, the PRL is sent to
              {view?.receiveAddress ? ` ${shortAddr(view.receiveAddress, 10, 6)}` : " your wallet"} on the Pearl
              network, which takes a few minutes more.
            </Callout>
          ) : (
            <Callout kind="info" icon={ICONS.clock}>
              It waits on the exchange until somebody takes the other side. The USDT lands in your buying power.
            </Callout>
          )}
          {alsoSent && (
            <Callout kind="warn" icon={ICONS.clock}>
              {alsoSent.amount} PRL was also sent from this wallet ({shortAddr(alsoSent.txid, 8, 6)}). It sells after 10
              blocks, about half an hour, at whatever PRL is worth then.
            </Callout>
          )}

          <div className="spacer" />
          <Button onClick={done}>Done</Button>
        </div>
      </div>
    );
  }

  if (confirming) {
    return (
      <div className="screen">
        <Header title={side === "buy" ? "Review buy" : "Review sell"} onBack={() => setConfirming(false)} />
        <div className="body">
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, padding: "6px 0" }}>
            <span className="muted" style={{ fontSize: 12.5 }}>You receive, estimated</span>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span style={{ fontFamily: "var(--serif)", fontSize: 36, lineHeight: 1.05 }}>
                {side === "buy" ? prl4(buy.delivered) : usdt(sell.received)}
              </span>
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-2)" }}>{side === "buy" ? "PRL" : "USDT"}</span>
            </div>
          </div>

          {side === "buy" ? (
            <div className="kv">
              <div><span className="k">You spend</span><span className="v">{usdt(n)} USDT</span></div>
              <div><span className="k">{kind === "limit" ? "Your price" : "Price, average"}</span><span className="v">{usdtPrice(avgPrice)} USDT</span></div>
              <div><span className="k">PRL bought</span><span className="v">{prl4(buy.gross)} PRL</span></div>
              <div><span className="k">Exchange fee, est.</span><span className="v">{prl4(buy.exchangeFee)} PRL</span></div>
              <div><span className="k">Oyster fee 1.25%</span><span className="v">{prl4(buy.oysterFee)} PRL</span></div>
              <div><span className="k">You receive, est.</span><span className="v">{prl4(buy.delivered)} PRL</span></div>
              <div><span className="k">After it fills</span><span className="v">{keep ? "Kept on the exchange" : "Sent to your wallet"}</span></div>
            </div>
          ) : (
            <div className="kv">
              <div><span className="k">You sell</span><span className="v">{prl4(n)} PRL</span></div>
              <div><span className="k">Oyster fee 1.25%</span><span className="v">{prl4(sell.oysterFee)} PRL</span></div>
              <div><span className="k">Sent to exchange</span><span className="v">{prl4(sell.sent)} PRL</span></div>
              <div><span className="k">{kind === "limit" ? "Your price" : "Price, average"}</span><span className="v">{usdtPrice(avgPrice)} USDT</span></div>
              <div><span className="k">Exchange fee, est.</span><span className="v">{usdt(sell.exchangeFee)} USDT</span></div>
              <div><span className="k">You receive, est.</span><span className="v">{usdt(sell.received)} USDT</span></div>
            </div>
          )}

          {side === "buy" && keep ? (
            <Callout kind="info" icon={ICONS.clock}>
              The order fills on the exchange and the PRL stays there, ready to sell instantly. Oyster holds it for you
              until you send it to your wallet from Buying power.
            </Callout>
          ) : side === "buy" ? (
            <Callout kind="info" icon={ICONS.clock}>
              A buy arrives in two steps. The order fills on the exchange, then the PRL is sent to
              {view?.receiveAddress ? ` ${shortAddr(view.receiveAddress, 10, 6)}` : " your wallet"} on the Pearl
              network. Both show in Activity, and the second can take a few minutes.
            </Callout>
          ) : sellSplit && "exchange" in sellSplit && sellSplit.wallet === 0n ? (
            <Callout kind="info" icon={ICONS.clock}>
              This sells straight from your PRL on the exchange, with no waiting. The USDT lands in your buying power.
            </Callout>
          ) : sellSplit && "exchange" in sellSplit && sellSplit.exchange > 0n ? (
            <Callout kind="warn" icon={ICONS.clock}>
              {prl4(Number(sellSplit.exchange) / 1e8)} PRL sells now from the exchange. The other{" "}
              {prl4(Number(sellSplit.wallet) / 1e8)} PRL is sent from this wallet and sells after 10 blocks, about half an
              hour, at whatever PRL is worth then. The USDT lands in your buying power.
            </Callout>
          ) : (
            <Callout kind="warn" icon={ICONS.clock}>
              This sends {prl4(n)} PRL to the exchange now. It becomes sellable after 10 blocks, about half an hour,
              and sells at whatever PRL is worth then. That is not the price above, and it cannot be called back once
              sent. The USDT lands in your buying power.
            </Callout>
          )}

          {kind === "market" && (
            <div className="kv">
              <div>
                <span className="k">Worst price accepted</span>
                <span className="v">{usdtPrice(avgPrice * (side === "buy" ? 1 + slippage / 100 : 1 - slippage / 100))} USDT</span>
              </div>
            </div>
          )}

          {quote?.partial && (
            <Callout kind="warn">
              The book does not hold enough at these prices to fill the whole order. Part of it would fill much worse,
              or not at all.
            </Callout>
          )}

          <div className="spacer" />
          {orderError && <Callout kind="danger">{orderError}</Callout>}
          <Button
            disabled={placing}
            onClick={async () => {
              setPlacing(true);
              setOrderError(undefined);
              try {
                /**
                 * The exact numbers the order is made of, built here rather
                 * than anywhere earlier.
                 *
                 * Everything above this line is a float, because it is for
                 * reading. What the relay is told is integers: PRL in
                 * grains and the price in USDT millionths, rounded in the
                 * direction that keeps the promise the screen just made.
                 */
                if (side === "sell") {
                  /**
                   * A sell is a payment, then an order half an hour later.
                   * No price goes with it: the market will have moved by
                   * the time the exchange counts the PRL, so one sent now
                   * would be a number nothing could honour.
                   */
                  const split = splitSell(roundAmount(parseUnits(input, 8)), exchangeGrains);
                  if ("error" in split) throw new Error(split.error);
                  // Exchange PRL first: it sells at once, as an ordinary order.
                  const order =
                    split.exchange > 0n
                      ? await call({
                          type: "placeOrder",
                          side: "sell",
                          amount: split.exchange.toString(),
                          price: priceUnits(avgPrice, "sell").toString(),
                        })
                      : undefined;
                  if (split.wallet > 0n) {
                    const { txid } = await call({ type: "placeSell", amount: split.wallet.toString() });
                    if (!order) {
                      setSold({ amount: formatUnits(split.wallet, 8), txid });
                      setMine(await call({ type: "myOrders" }));
                      return;
                    }
                    setAlsoSent({ amount: formatUnits(split.wallet, 8), txid });
                  }
                  setPlaced(order!);
                  setMine(await call({ type: "myOrders" }));
                  return;
                }

                const priceMicros = priceUnits(avgPrice, side);
                const amount = amountForSpend(parseUnits(input, 6), priceMicros);
                if (amount < MIN_ORDER_GRAINS) {
                  throw new Error(`The smallest order this market takes is ${formatUnits(MIN_ORDER_GRAINS, 8)} PRL.`);
                }
                const order = await call({
                  type: "placeOrder",
                  side,
                  amount: amount.toString(),
                  price: priceMicros.toString(),
                  ...(keep ? { keep: true } : {}),
                });
                setPlaced(order);
                setMine(await call({ type: "myOrders" }));
              } catch (e) {
                // The relay's own words. It says why in a sentence meant
                // for a person, and rewording it here would lose that.
                setOrderError((e as RpcError).message);
              } finally {
                setPlacing(false);
              }
            }}
          >
            {placing ? "Placing…" : side === "buy" ? "Buy PRL" : "Sell PRL"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      <div style={{ display: "flex", alignItems: "center", height: 52, padding: "0 16px", flexShrink: 0 }}>
        <div style={{ fontFamily: "var(--serif)", fontSize: 24, fontWeight: 500 }}>Trade</div>
        <div className="spacer" />
        {price && (
          <span className="mono" style={{ fontSize: 12.5, color: price.change24hPct >= 0 ? "var(--accent)" : "var(--danger-text)" }}>
            {usdtPrice(price.usdPerPrl)} · {price.change24hPct >= 0 ? "+" : ""}{price.change24hPct.toFixed(2)}%
          </span>
        )}
      </div>

      <div className="body" style={{ gap: 12, padding: "0 16px 8px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          {(["buy", "sell"] as Side[]).map((s) => (
            <button key={s} type="button" aria-pressed={side === s} onClick={() => { onSide(s); setInput(""); setQuote(undefined); }}
              style={{ height: 40, borderRadius: 10, cursor: "pointer", fontSize: 14, fontWeight: 600, border: "1.5px solid",
                borderColor: side === s ? (s === "buy" ? "var(--accent)" : "var(--danger-text)") : "var(--border)",
                background: side === s ? (s === "buy" ? "var(--accent-soft)" : "var(--danger-bg)") : "var(--surface)",
                color: side === s ? (s === "buy" ? "var(--accent-soft-text)" : "var(--danger-text)") : "var(--text-2)" }}>
              {s === "buy" ? "Buy" : "Sell"}
            </button>
          ))}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="eyebrow">Order book</span>
          <Book depth={depth} />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          {(["market", "limit"] as Kind[]).map((k) => (
            <button key={k} type="button" className="pill" aria-pressed={kind === k} onClick={() => setKind(k)}
              style={{ height: 32, fontSize: 12 }}>
              {k === "market" ? "At market" : "At my price"}
            </button>
          ))}
        </div>

        <div className="field">
          <label htmlFor="tradeamt" className="label">{side === "buy" ? "You spend" : "You sell"}</label>
          <div className="input" style={{ height: 56 }}>
            <input id="tradeamt" inputMode="decimal" value={input} placeholder={side === "buy" ? "0.00" : "0.0000"}
              style={{ fontFamily: "var(--serif)", fontSize: 24 }}
              onChange={(e) => setInput(e.target.value.replace(/[^0-9.]/g, ""))} />
            <span style={{ fontWeight: 600, color: "var(--text-2)" }}>{side === "buy" ? "USDT" : "PRL"}</span>
            {side === "sell" && view && (
              <button type="button" onClick={() => setInput(formatUnits(BigInt(view.spendable) + exchangeGrains, 8))}
                style={{ height: 28, padding: "0 8px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--surface-2)", fontSize: 11.5, fontWeight: 600, cursor: "pointer" }}>
                Max
              </button>
            )}
          </div>
          <div className="muted" style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
            <span>{amountOk && !enough ? <span className="error-text">More than you have</span> : ""}</span>
            {side === "buy" ? (
              <button type="button" onClick={onCash}
                style={{ padding: 0, border: "none", background: "none", color: "var(--accent)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                Buying power {usdt(heldUsdt)} USDT
              </button>
            ) : (
              <span>
                {exchangeGrains > 0n && <>On the exchange {formatUnits(exchangeGrains, 8)} · </>}
                In this wallet {view ? formatUnits(BigInt(view.spendable), 8) : "0"} PRL
              </span>
            )}
          </div>
        </div>

        {side === "buy" && (
          <div className="field">
            <span className="label">After it fills</span>
            <div style={{ display: "flex", gap: 6 }}>
              <button type="button" className="pill" aria-pressed={!keep} onClick={() => setKeep(false)}
                style={{ flexGrow: 1, height: 32, fontSize: 12, background: !keep ? undefined : "var(--surface-2)" }}>
                Send to my wallet
              </button>
              <button type="button" className="pill" aria-pressed={keep} onClick={() => setKeep(true)}
                style={{ flexGrow: 1, height: 32, fontSize: 12, background: keep ? undefined : "var(--surface-2)" }}>
                Keep on exchange
              </button>
            </div>
            <span className="muted" style={{ fontSize: 11.5 }}>
              {keep
                ? "Stays on the exchange so selling it is instant. Oyster holds it for you until you send it to your wallet."
                : "Sent to this wallet on the Pearl network a few minutes after it fills. You hold the keys."}
            </span>
          </div>
        )}

        {kind === "limit" && (
          <div className="field">
            <label htmlFor="limit" className="label">Your price</label>
            <div className="input">
              <input id="limit" inputMode="decimal" value={limitPrice} placeholder={price ? usdtPrice(price.usdPerPrl) : "0.0000"}
                onChange={(e) => setLimitPrice(e.target.value.replace(/[^0-9.]/g, ""))} />
              <span className="muted">USDT per PRL</span>
            </div>
          </div>
        )}

        {amountOk && (
          <div className="kv">
            <div>
              <span className="k">{kind === "limit" ? "At your price" : "Price, average"}</span>
              <span className="v">
                {kind === "market" && quote === undefined ? "…" : kind === "market" && quote === null ? "unavailable" : `${usdtPrice(avgPrice)} USDT`}
              </span>
            </div>
            {kind === "market" && quote && price && Math.abs(quote.avgPrice - price.usdPerPrl) / price.usdPerPrl > 0.005 && (
              <div><span className="k">Ticker says</span><span className="v">{usdtPrice(price.usdPerPrl)} USDT</span></div>
            )}
            <div>
              <span className="k">You receive, est.</span>
              <span className="v">{side === "buy" ? `${prl4(buy.delivered)} PRL` : `${usdt(sell.received)} USDT`}</span>
            </div>
          </div>
        )}

        {mine === null && (
          // Not a zero. A balance that could not be read is a different
          // thing from a balance of nothing, and showing the second when
          // the first happened is how somebody decides they have been
          // robbed.
          <Callout kind="warn" icon={ICONS.lock}>
            Your balances could not be read. Unlock the wallet, or check the data server in Settings.
          </Callout>
        )}

        {side === "buy" && mine && heldUsdt === 0 && (
          <Callout kind="info" icon={ICONS.wallet}>
            You have no USDT to spend yet. Add some from the Buying power screen.
          </Callout>
        )}

        {side === "sell" && view && walletPrl === 0 && exchangeGrains === 0n && (
          <Callout kind="info" icon={ICONS.wallet}>
            There is no PRL in this wallet to sell.
          </Callout>
        )}

        {kind === "market" && (
          <div className="field">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span className="label">Worst price I will accept</span>
              <span className="muted mono" style={{ fontSize: 11.5 }}>
                {drift > 0 ? `${drift.toFixed(2)}% away now` : "at the ticker"}
              </span>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              {SLIPPAGE_CHOICES.map((p) => (
                <button key={p} type="button" className="pill" aria-pressed={slippage === p} onClick={() => setSlippage(p)}
                  style={{ flexGrow: 1, height: 32, fontSize: 12, background: slippage === p ? undefined : "var(--surface-2)" }}>
                  {p}%
                </button>
              ))}
            </div>
          </div>
        )}

        {tooFar && (
          <Callout kind="warn">
            This size would fill {drift.toFixed(2)}% worse than the ticker, past the {slippage}% you allowed. Trade
            less, set a price yourself, or raise the limit above.
          </Callout>
        )}

        <Button disabled={!ready} onClick={() => setConfirming(true)}>Review</Button>

        {mine && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="eyebrow">Your open orders</span>
            {mine.open.length === 0 ? (
              <span className="muted" style={{ fontSize: 12.5 }}>Nothing waiting on the exchange.</span>
            ) : (
              mine.open.map((o) => (
                <div key={o.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: 10, border: "1px solid var(--border)", borderRadius: 10, background: "var(--surface)" }}>
                  <span style={{ display: "flex", flexDirection: "column", flexGrow: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: o.side === "buy" ? "var(--accent)" : "var(--danger-text)" }}>
                      {o.side === "buy" ? "Buy" : "Sell"} {o.amountPrl} PRL
                    </span>
                    <span className="muted mono" style={{ fontSize: 11.5 }}>
                      {o.reservedAsset === "usdt"
                        ? `${formatUnits(BigInt(o.reserved), 6)} USDT set aside`
                        : `${formatUnits(BigInt(o.reserved), 8)} PRL set aside`}
                      {` · ${ago(o.created)}`}
                    </span>
                  </span>
                  <Button variant="ghost" style={{ width: "auto", height: 32, padding: "0 10px", fontSize: 12.5, color: "var(--danger-text)" }}
                    disabled={cancelling === o.id}
                    onClick={async () => {
                      setCancelling(o.id);
                      setOrderError(undefined);
                      try {
                        await call({ type: "cancelMyOrder", id: o.id });
                        setMine(await call({ type: "myOrders" }));
                      } catch (e) {
                        setOrderError((e as RpcError).message);
                      } finally {
                        setCancelling(undefined);
                      }
                    }}>
                    {cancelling === o.id ? "Cancelling…" : "Cancel"}
                  </Button>
                </div>
              ))
            )}
            {/* Cancelling is asked for, not done: the exchange takes a few
                seconds, and the order stays here until it confirms. */}
            {cancelling !== undefined && (
              <span className="muted" style={{ fontSize: 11.5 }}>
                The exchange takes a few seconds to let one go. It stays here until it has.
              </span>
            )}
            {orderError && <Callout kind="danger">{orderError}</Callout>}
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column" }}>
          <span className="eyebrow">Recent trades</span>
          {trades === undefined ? (
            <span className="muted" style={{ fontSize: 12.5, padding: "6px 0" }}>Loading…</span>
          ) : trades === null || trades.length === 0 ? (
            <span className="muted" style={{ fontSize: 12.5, padding: "6px 0" }}>No trades to show.</span>
          ) : (
            trades.slice(0, 6).map((t) => (
              <div key={`${t.id}-${t.t}`} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: "1px solid var(--divider)", fontSize: 12 }}>
                <span className="mono" style={{ color: t.side === "sell" ? "var(--danger-text)" : "var(--accent)" }}>{usdtPrice(t.price)}</span>
                <span className="mono" style={{ color: "var(--text-2)" }}>{t.amount.toLocaleString("en-US", { maximumFractionDigits: 2 })} PRL</span>
                <span className="muted" style={{ fontSize: 11 }}>{ago(t.t)}</span>
              </div>
            ))
          )}
        </div>
      </div>
      <TabBar active="trade" onTab={onTab} />
    </div>
  );
}
