import { formatUnits } from "@pearl-wallet/core";
import { useEffect, useState } from "react";
import { browser } from "wxt/browser";
import { type AccountView, CASH_CHAINS, type CashChainId, type DepositAddress, PEARL_CHAIN, CHART_RANGES, type ChartRange, type ChartView, type NetworkId, type PriceAlert, type PriceView, type WalletView, type WireTx, type WithdrawInfo, type WrappedView } from "../../messages";
import { ChartStyleToggle, pointLabel, PriceChart, RANGE_TAIL, usdt, usdtPrice, type ChartStyle, type HoverPoint } from "../chart";
import { Button, Callout, CoinIcon, EthMark, Header, Icon, ICONS, PrlMark, Toggle } from "../components";
import { ago, prl, prlExact, shortAddr } from "../format";
import { call, RpcError } from "../rpc";
import { openAddress, TxRow } from "./wallet";

/** Facts about the coin itself. Fixed by the network, not fetched. */
const ABOUT: { k: string; v: string }[] = [
  { k: "Network", v: "Pearl" },
  { k: "Ticker", v: "PRL" },
  { k: "Smallest unit", v: "1 PRL = 100,000,000 grains" },
  { k: "Addresses", v: "Taproot, bech32m" },
  { k: "New block", v: "about every 3 minutes" },
  { k: "Reward maturity", v: "100 blocks" },
];

function Stat({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "7px 0", borderBottom: "1px solid var(--divider)" }}>
      <span className="muted" style={{ fontSize: 12.5 }}>{k}</span>
      <span className="mono" style={{ fontSize: 12.5, textAlign: "right", color: tone ?? "var(--text)" }}>{v}</span>
    </div>
  );
}

/** The coin's own page: what it costs, what you hold of it, what it is, and
 *  your history with it. Reached by tapping Pearl in the home holdings. */
export function Token({
  view, network, price, chart, range, onRange, onBack, onSend, onReceive, onOpenTx, onSeeAll,
}: {
  view?: WalletView; network: NetworkId; price?: PriceView; chart?: ChartView;
  range: ChartRange; onRange: (r: ChartRange) => void;
  onBack: () => void; onSend: () => void; onReceive: () => void;
  onOpenTx: (tx: WireTx) => void; onSeeAll: () => void;
}) {
  const [hover, setHover] = useState<HoverPoint | null>(null);
  const [style, setStyle] = useState<ChartStyle>("line");
  const points = chart?.points ?? [];
  const at = hover ?? undefined;
  const shown = at?.v ?? price?.usdPerPrl;
  const first = points[0]?.v;
  const pct = at && first ? ((at.v - first) / first) * 100 : chart?.changePct ?? price?.change24hPct;
  const when = at ? pointLabel(at.t, range) : RANGE_TAIL[range] ?? "";

  const balance = view ? BigInt(view.confirmed) + BigInt(view.unconfirmed) : 0n;
  const held = Number(balance) / 1e8;
  const unconfirmed = view ? BigInt(view.unconfirmed) : 0n;
  const immature = view ? BigInt(view.immature) : 0n;
  const txs = view?.txs ?? [];

  return (
    <div className="screen">
      <Header title="Pearl" onBack={onBack} />
      <div className="body" style={{ gap: 14, padding: "16px 16px 8px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <PrlMark size={40} />
          <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
            <span style={{ fontFamily: "var(--serif)", fontSize: 21, lineHeight: 1.2 }}>
              {shown !== undefined ? `${usdtPrice(shown)} USDT` : "Price unavailable"}
            </span>
            {pct !== undefined ? (
              <span className="mono" style={{ fontSize: 12.5, color: pct >= 0 ? "var(--accent)" : "var(--danger-text)" }}>
                {pct >= 0 ? "+" : ""}{pct.toFixed(2)}%<span className="muted"> · {when}</span>
              </span>
            ) : (
              <span className="muted" style={{ fontSize: 12.5 }}>PRL on the Pearl network</span>
            )}
          </div>
        </div>

        {price && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: -4 }}>
              <ChartStyleToggle style={style} disabled={!chart?.candles} onStyle={setStyle} />
            </div>
            <PriceChart chart={chart} hover={hover?.index ?? null} onHover={setHover} style={style} height={96} axis />
            {!chart && <span className="muted" style={{ fontSize: 11 }}>Fetching the {range} chart…</span>}
            <div style={{ display: "flex", gap: 2, justifyContent: "space-between" }}>
              {CHART_RANGES.map((r) => (
                <button key={r} type="button" className="pill" aria-pressed={r === range}
                  onClick={() => { setHover(null); onRange(r); }}>
                  {r}
                </button>
              ))}
            </div>
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: 12, border: "1px solid var(--border)", borderRadius: 12, background: "var(--surface)" }}>
          <span className="eyebrow">Your Pearl</span>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
            <span style={{ fontFamily: "var(--serif)", fontSize: 26, lineHeight: 1.15 }}>{view ? prl(balance) : "…"}</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-2)" }}>PRL</span>
          </div>
          {price && view && <span className="muted" style={{ fontSize: 12.5 }}>Worth {usdt(held * price.usdPerPrl)} USDT</span>}
          <div style={{ marginTop: 6 }}>
            <Stat k="Spendable now" v={`${prl(view?.spendable ?? 0n)} PRL`} />
            {unconfirmed !== 0n && <Stat k="Waiting for a block" v={`${prl(unconfirmed)} PRL`} tone="var(--warn-text)" />}
            {immature > 0n && <Stat k="Mining rewards maturing" v={`${prl(immature)} PRL`} tone="var(--warn-text)" />}
            {view && view.protectedCount > 0 && <Stat k="Protected outputs" v={`${view.protectedCount}`} />}
          </div>
        </div>

        <div className="row-2">
          <Button variant="secondary" disabled={!view || view.watchOnly || BigInt(view.spendable) === 0n} onClick={onSend}>
            <Icon d={ICONS.send} size={16} />Send
          </Button>
          <Button onClick={onReceive}><Icon d={ICONS.receive} size={16} />Receive</Button>
        </div>
        <Callout kind="info" icon={ICONS.trade}>
          Buying and selling PRL happens on the Trade screen. What you buy is sent here, to this wallet.
        </Callout>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <span className="eyebrow">Market</span>
          {price ? (
            <>
              <Stat k="Price" v={`${usdtPrice(price.usdPerPrl)} USDT`} />
              <Stat k="Change, 24 hours" v={`${price.change24hPct >= 0 ? "+" : ""}${price.change24hPct.toFixed(2)}%`}
                tone={price.change24hPct >= 0 ? "var(--accent)" : "var(--danger-text)"} />
              {price.volume24h !== undefined && <Stat k="Volume, 24 hours" v={`${usdt(price.volume24h)} USDT`} />}
              <Stat k="Updated" v={price.stale ? "may be out of date" : ago(Math.floor(Date.parse(price.asOf) / 1000))}
                tone={price.stale ? "var(--warn-text)" : undefined} />
            </>
          ) : (
            <span className="muted" style={{ fontSize: 12.5, padding: "7px 0" }}>No price right now. The wallet still works without one.</span>
          )}
        </div>

        <PriceAlerts price={price} />

        <div style={{ display: "flex", flexDirection: "column" }}>
          <span className="eyebrow">About Pearl</span>
          {ABOUT.map((a) => <Stat key={a.k} k={a.k} v={a.k === "Network" ? (network === "mainnet" ? "Pearl" : `Pearl ${network}`) : a.v} />)}
          <Stat k="Your balance in grains" v={view ? prlExact(balance).replace(".", "") : "…"} />
        </div>

        {txs.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span className="eyebrow">Recent PRL activity</span>
              <button type="button" onClick={onSeeAll}
                style={{ border: "none", background: "none", color: "var(--accent)", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                See all
              </button>
            </div>
            {txs.slice(0, 4).map((tx) => <TxRow key={tx.txid} tx={tx} price={price} onOpen={() => onOpenTx(tx)} />)}
          </div>
        )}

        {view && (
          <Button variant="ghost" onClick={() => openAddress(network, view.receiveAddress)}>
            View your address on the explorer<Icon d={ICONS.external} size={16} />
          </Button>
        )}
      </div>
    </div>
  );
}

/** Wrapped PRL: the ERC-20 on Ethereum. Oyster holds no Ethereum keys, so
 *  this watches an address the owner gives it and never spends from it. The
 *  balance is one read-only balanceOf call, made by the relay. */
export function WrappedPearl({ address, wrapped, price, inTotal, onBack, onSave, onForget, onInTotal }: {
  address?: string;
  wrapped?: WrappedView;
  price?: PriceView;
  inTotal?: boolean;
  onBack: () => void;
  onSave: (address: string) => Promise<void>;
  onForget: () => Promise<void>;
  onInTotal: (include: boolean) => Promise<void>;
}) {
  const units = wrapped ? Number(BigInt(wrapped.balance)) / 10 ** wrapped.decimals : undefined;
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await onSave(draft);
      setDraft("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const paste = async () => {
    try {
      setDraft((await navigator.clipboard.readText()).trim());
      setError(undefined);
    } catch {
      setError("Could not read the clipboard. Paste with Ctrl+V instead.");
    }
  };

  return (
    <div className="screen">
      <Header title="Wrapped Pearl" onBack={onBack} />
      <div className="body" style={{ gap: 14, padding: "16px 16px 8px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <CoinIcon mark={<PrlMark size={40} />} badge={<EthMark size={10} />} size={40} />
          <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
            <span style={{ fontFamily: "var(--serif)", fontSize: 21, lineHeight: 1.2 }}>wPRL</span>
            <span className="muted" style={{ fontSize: 12.5 }}>Pearl bridged to Ethereum</span>
          </div>
        </div>

        {address ? (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: 12, border: "1px solid var(--border)", borderRadius: 12, background: "var(--surface)" }}>
              <span className="eyebrow">Your balance</span>
              <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                <span style={{ fontFamily: "var(--serif)", fontSize: 26, lineHeight: 1.15 }}>
                  {units === undefined ? "…" : units.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 })}
                </span>
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-2)" }}>wPRL</span>
              </div>
              {units !== undefined && price && (
                <span className="muted" style={{ fontSize: 12.5 }}>Worth {usdt(units * price.usdPerPrl)} USDT at the PRL price</span>
              )}
              {units === undefined && (
                <span className="muted" style={{ fontSize: 12.5 }}>Could not read Ethereum just now. The address is still watched.</span>
              )}
              {wrapped && <div style={{ marginTop: 6 }}><Stat k="Updated" v={ago(Math.floor(Date.parse(wrapped.asOf) / 1000))} /></div>}
            </div>
            <div className="list-row" style={{ padding: "8px 12px", border: "1px solid var(--border)", borderRadius: 12, background: "var(--surface)", cursor: "default" }}>
              <span className="main">
                <span className="t">Count in portfolio total</span>
                <span className="s" style={{ whiteSpace: "normal" }}>Adds this wPRL to the total on the home screen.</span>
              </span>
              <Toggle on={inTotal === true} label="Count wPRL in the portfolio total" onChange={(v) => void onInTotal(v)} />
            </div>

            <div className="field">
              <span className="label">Watching</span>
              <div className="mono" style={{ padding: 12, border: "1px solid var(--border)", borderRadius: 10, background: "var(--surface)", fontSize: 12.5, lineHeight: 1.55, wordBreak: "break-all", userSelect: "all" }}>
                {address}
              </div>
            </div>
            <Callout kind="info" icon={ICONS.eye}>
              Watch only. Oyster has no Ethereum keys, so it can follow this address but never move what is on it.
            </Callout>
            <div className="row-2">
              <Button variant="secondary" disabled={busy} onClick={() => { setBusy(true); void onForget().finally(() => setBusy(false)); }}>
                <Icon d={ICONS.trash} size={16} />Stop watching
              </Button>
              <Button onClick={() => browser.tabs.create({ url: `https://etherscan.io/address/${address}` })}>
                Etherscan<Icon d={ICONS.external} size={16} />
              </Button>
            </div>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span className="eyebrow">Contract</span>
              <Stat k="Token" v="Wrapped Pearl, 8 decimals" />
              <Stat k="Chain" v="Ethereum" />
            </div>
          </>
        ) : (
          <>
            <p className="lead" style={{ margin: 0 }}>
              Hold wPRL on Ethereum? Give Oyster the address it sits at and this page will keep track of it.
            </p>
            <div className="field">
              <span className="label">Ethereum address</span>
              <div className="input">
                <input id="evmaddr" value={draft} placeholder="0x…" autoComplete="off" spellCheck={false}
                  onChange={(e) => { setDraft(e.target.value); setError(undefined); }}
                  onKeyDown={(e) => e.key === "Enter" && draft && void save()} />
                <button type="button" className="icon-btn" aria-label="Paste" onClick={paste}>
                  <Icon d={ICONS.paste} size={18} />
                </button>
              </div>
            </div>
            {error && <Callout kind="danger">{error}</Callout>}
            <Button disabled={!draft.trim() || busy} onClick={save}>{busy ? "Checking…" : "Watch address"}</Button>
            <Callout kind="info" icon={ICONS.eye}>
              Watching only. Oyster never asks for an Ethereum key and cannot spend from the address. It is stored on this device with your wallet.
            </Callout>
            <Callout kind="warn">
              Do not send native PRL to an Ethereum address, and do not send wPRL to your Pearl address. Crossing the two needs the bridge.
            </Callout>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * PRL bought with "Keep on exchange", and the way to have it sent home.
 *
 * Kept PRL sells instantly, but it is held by Oyster, not this wallet, so
 * the card says so and puts the way out next to the number.
 */
function KeptPrl({ kept, usdPerPrl, onSent }: { kept: bigint; usdPerPrl?: number; onSent: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState(false);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: 12, border: "1px solid var(--border)", borderRadius: 12, background: "var(--surface)" }}>
      <span className="eyebrow">PRL kept on the exchange</span>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
        <span style={{ fontFamily: "var(--serif)", fontSize: 28, lineHeight: 1.15 }}>{formatUnits(kept, 8)}</span>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-2)" }}>PRL</span>
      </div>
      {usdPerPrl !== undefined && (
        <span style={{ fontSize: 13, color: "var(--text-2)" }}>Worth {usdt((Number(kept) / 1e8) * usdPerPrl)} USDT</span>
      )}
      <span className="muted" style={{ fontSize: 12.5 }}>
        Ready to sell instantly. Oyster holds it for you until you send it to your wallet.
      </span>
      {error && <Callout kind="danger">{error}</Callout>}
      {sent ? (
        <Callout kind="info" icon={ICONS.check}>On its way to your wallet. It arrives in a few minutes.</Callout>
      ) : (
        <Button variant="secondary" disabled={busy} style={{ height: 34, fontSize: 12.5 }}
          onClick={async () => {
            setBusy(true);
            setError(undefined);
            try {
              await call({ type: "releasePrl" });
              setSent(true);
              onSent();
            } catch (e) {
              setError((e as RpcError).message);
            } finally {
              setBusy(false);
            }
          }}>
          {busy ? "Sending…" : "Send to my wallet"}
        </Button>
      )}
    </div>
  );
}

/**
 * Taking USDT out, from inside the cash box rather than beside it.
 *
 * There is no address to type and deliberately so. It goes back to the
 * address it was sent from, which is the property that means a relay
 * somebody has taken over still cannot send this money anywhere else.
 * Saying that on the screen matters as much as enforcing it: an empty
 * destination field looks like something missing rather than something
 * decided.
 */
function WithdrawCash({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<WithdrawInfo | null>();
  const [chain, setChain] = useState<string>();
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState<{ amount: string; destination: string }>();

  useEffect(() => {
    if (!open) return;
    call({ type: "withdrawInfo" }).then(
      (w) => {
        setInfo(w);
        // One chain is not a choice, so it is not presented as one.
        if (w?.destinations.length === 1) setChain(w.destinations[0]!.chain);
      },
      () => setInfo(null),
    );
  }, [open]);

  const to = info?.destinations.find((d) => d.chain === chain);
  /**
   * The exchange's charge for sending on this chain, in USDT.
   *
   * Taken on top of what is withdrawn, so the most that can be asked for
   * is the balance less the fee. Max used to fill in the whole balance,
   * which is an amount that is then refused for being a penny too much.
   */
  const fee = to ? Number(BigInt(to.fee)) / 1e6 : 0;
  const balance = info ? Number(BigInt(info.available)) / 1e6 : 0;
  const free = Math.max(0, balance - fee);
  const least = info ? Number(BigInt(info.minimum)) / 1e6 : 0;
  const named = (id: string) => CASH_CHAINS.find((c) => c.id === id)?.name ?? id;

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      // Parsed to millionths as an integer, never through a float: 0.1 * 1e6
      // is 100000.00000000001, and this is somebody's money.
      const [whole, frac = ""] = amount.trim().split(".");
      const micros = `${whole || "0"}${`${frac}000000`.slice(0, 6)}`.replace(/^0+(?=\d)/, "");
      const done = await call({ type: "withdraw", chain: chain!, amount: micros });
      setSent({ amount: done.amount, destination: done.destination });
      setAmount("");
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  if (sent) {
    return (
      <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--divider)" }}>
        <Callout kind="info" icon={ICONS.clock}>
          {usdt(Number(BigInt(sent.amount)) / 1e6)} USDT is on its way to {shortAddr(sent.destination, 8, 6)}. It is
          signed and sent within a minute or so.
        </Callout>
      </div>
    );
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}
        style={{ marginTop: 10, height: 38, borderRadius: 9, border: "1px solid var(--border)", background: "transparent", color: "var(--text)", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
        Withdraw
      </button>
    );
  }

  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--divider)", display: "flex", flexDirection: "column", gap: 8 }}>
      {info === undefined ? (
        <span className="muted" style={{ fontSize: 12.5 }}>Checking what can be sent…</span>
      ) : info === null ? (
        <span className="muted" style={{ fontSize: 12.5 }}>The relay could not be reached, so this cannot be done right now.</span>
      ) : info.destinations.length === 0 ? (
        <span className="muted" style={{ fontSize: 12.5 }}>
          Oyster sends USDT back to the address you sent it from, and this wallet has not sent any yet. Add your
          address below and deposit once, and this will know where to send.
        </span>
      ) : (
        <>
          {info.destinations.length > 1 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {info.destinations.map((d) => (
                <button key={d.chain} type="button" className="pill" aria-pressed={d.chain === chain}
                  onClick={() => setChain(d.chain)}>
                  {named(d.chain)}
                </button>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 6 }}>
            <input inputMode="decimal" placeholder={`0.00`} value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
              style={{ flexGrow: 1, minWidth: 0, height: 38, padding: "0 10px", borderRadius: 9, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)", fontSize: 14 }} />
            <button type="button" className="pill" onClick={() => setAmount(String(free))}>Max</button>
          </div>
          <span className="muted" style={{ fontSize: 11.5, whiteSpace: "normal" }}>
            {usdt(free)} USDT you can withdraw, and at least {usdt(least)} at a time.
            {fee > 0 && (
              <>
                {" "}
                {/* Said before they type, not after they are refused. The
                    exchange charges this to move the money out, and it is
                    taken on top of whatever is withdrawn. */}
                A {usdt(fee)} USDT network fee is charged on top, so {usdt(free)} costs{" "}
                {usdt(balance)}.
              </>
            )}
            {to && <> Goes to your own {named(to.chain)} address {shortAddr(to.address, 6, 5)}, the one you sent from.</>}
          </span>
          {error && <Callout kind="danger">{error}</Callout>}
          <div style={{ display: "flex", gap: 6 }}>
            <Button onClick={submit} disabled={busy || !chain || !amount || Number(amount) <= 0}>
              {busy ? "Sending…" : "Withdraw"}
            </Button>
            <Button variant="secondary" onClick={() => { setOpen(false); setError(undefined); }}>Cancel</Button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Buying power: the USDT that buys PRL, how to get it in and back out.
 *
 * Money goes in by saving the address you send from and sending to the
 * address shown for it; it comes out to that same address.
 */
export function Cash({ onBack, cashAddresses, onCashAddress }: {
  onBack: () => void;
  cashAddresses: Partial<Record<CashChainId, string>>;
  onCashAddress: (chain: CashChainId, address: string) => Promise<void>;
}) {
  const [account, setAccount] = useState<AccountView | null>();
  const [price, setPrice] = useState<PriceView | null>();

  useEffect(() => {
    call({ type: "myAccount" }).then(setAccount, () => setAccount(null));
    call({ type: "price" }).then(setPrice, () => setPrice(null));
  }, []);

  /**
   * Grains too few to show. Settlement rounds fees down and leaves a few
   * grains behind that no delivery will ever carry; shown, they become a
   * second card of 0.00008 PRL that looks like a bug. Same cut-off as the
   * relay's "PRL on its way" banner.
   */
  const DUST = 100_000n; // 0.001 PRL
  const loose = account ? BigInt(account.prl) - BigInt(account.kept) : 0n;

  return (
    <div className="screen">
      <Header title="Buying power" onBack={onBack} />
      <div className="body" style={{ gap: 14 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: 12, border: "1px solid var(--border)", borderRadius: 12, background: "var(--surface)" }}>
          <span className="eyebrow">USDT cash</span>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
            <span style={{ fontFamily: "var(--serif)", fontSize: 28, lineHeight: 1.15 }}>
              {/* Never a zero standing in for a number that could not be
                  read. Those are different things, and showing the second
                  as the first is how somebody decides they have been
                  robbed. */}
              {account === undefined ? "…" : account === null ? "—" : usdt(Number(BigInt(account.usdt)) / 1e6)}
            </span>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-2)" }}>USDT</span>
          </div>
          <span className="muted" style={{ fontSize: 12.5 }}>
            {account === null ? "Could not be read. Unlock the wallet, or check the data server in Settings." : "What is here is what you can buy PRL with."}
          </span>
          {account && <WithdrawCash onDone={() => call({ type: "myAccount" }).then(setAccount, () => {})} />}
        </div>

        {account && BigInt(account.kept) > 0n && (
          <KeptPrl kept={BigInt(account.kept)} usdPerPrl={price?.usdPerPrl}
            onSent={() => call({ type: "myAccount" }).then(setAccount, () => {})} />
        )}

        {account && loose >= DUST && (
          <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: 12, border: "1px solid var(--border)", borderRadius: 12, background: "var(--surface)" }}>
            <span className="eyebrow">PRL on the exchange</span>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
              <span style={{ fontFamily: "var(--serif)", fontSize: 28, lineHeight: 1.15 }}>{formatUnits(loose, 8)}</span>
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-2)" }}>PRL</span>
            </div>
            <span className="muted" style={{ fontSize: 12.5 }}>Waiting to be sold or sent to your wallet. This is not in your wallet yet.</span>
          </div>
        )}

        <YourWallet saved={cashAddresses} onSave={onCashAddress} />
      </div>
    </div>
  );
}

/**
 * "Tell me when PRL crosses this."
 *
 * Checked by the background on its own timer, so an alert fires whether or
 * not this window is open, and whether or not the wallet is unlocked: a
 * price is public, and watching one needs no keys.
 */
function PriceAlerts({ price }: { price?: PriceView }) {
  const [alerts, setAlerts] = useState<PriceAlert[]>();
  const [direction, setDirection] = useState<"above" | "below">("above");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    call({ type: "priceAlerts" }).then(setAlerts, () => setAlerts([]));
  }, []);

  const add = async () => {
    const n = Number(target);
    setBusy(true);
    setError(undefined);
    try {
      setAlerts(await call({ type: "addPriceAlert", direction, price: n }));
      setTarget("");
    } catch (e) {
      setError((e as RpcError).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      setAlerts(await call({ type: "removePriceAlert", id }));
    } catch (e) {
      setError((e as RpcError).message);
    }
  };

  const n = Number(target);
  const ok = Number.isFinite(n) && n > 0;
  // A "below" alert above the price, or an "above" alert below it, fires the
  // moment it is made. Worth saying before it happens, not after.
  const immediate =
    ok && price !== undefined && (direction === "above" ? price.usdPerPrl >= n : price.usdPerPrl <= n);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span className="eyebrow">Price alerts</span>

      {alerts?.map((a) => (
        <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", border: "1px solid var(--border)", borderRadius: 10, background: "var(--surface)" }}>
          <span style={{ display: "flex", color: a.firedAt ? "var(--accent)" : "var(--text-2)" }}>
            <Icon d={a.firedAt ? ICONS.check : ICONS.clock} size={16} />
          </span>
          <span style={{ flexGrow: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
            <span style={{ fontSize: 13 }}>{a.direction === "above" ? "Above" : "Below"} {usdtPrice(a.price)} USDT</span>
            <span className="muted" style={{ fontSize: 11.5 }}>
              {a.firedAt ? `Fired ${ago(a.firedAt)}` : "Watching"}
            </span>
          </span>
          <button type="button" className="icon-btn" style={{ width: 30, height: 30, color: "var(--text-3)" }}
            aria-label="Remove this alert" onClick={() => void remove(a.id)}>
            <Icon d={ICONS.trash} size={15} />
          </button>
        </div>
      ))}

      <div style={{ display: "flex", gap: 6 }}>
        {(["above", "below"] as const).map((d) => (
          <button key={d} type="button" aria-pressed={direction === d} onClick={() => setDirection(d)}
            style={{ height: 34, padding: "0 12px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 12.5, fontWeight: direction === d ? 600 : 500,
              background: direction === d ? "var(--accent-soft)" : "var(--surface-2)", color: direction === d ? "var(--accent-soft-text)" : "var(--text-2)" }}>
            {d === "above" ? "Above" : "Below"}
          </button>
        ))}
        <div className="input" style={{ flexGrow: 1, height: 34 }}>
          <input inputMode="decimal" value={target} placeholder={price ? usdtPrice(price.usdPerPrl) : "0.0000"}
            style={{ fontSize: 13 }}
            onChange={(e) => setTarget(e.target.value.replace(/[^0-9.]/g, ""))}
            onKeyDown={(e) => e.key === "Enter" && ok && void add()} />
        </div>
        <Button variant="secondary" style={{ width: "auto", height: 34, padding: "0 12px", fontSize: 12.5 }}
          disabled={!ok || busy} onClick={add}>
          Add
        </Button>
      </div>

      {immediate && (
        <span className="muted" style={{ fontSize: 11.5, color: "var(--warn-text)" }}>
          PRL is already {direction} that, so this would fire straight away.
        </span>
      )}
      {error && <Callout kind="danger">{error}</Callout>}
      {alerts?.length === 0 && !error && (
        <span className="muted" style={{ fontSize: 11.5 }}>
          Alerts are checked in the background, so one will reach you whether or not the wallet is open.
        </span>
      )}
    </div>
  );
}


/**
 * The address a person sends cash from, and gets it back at.
 *
 * One field doing two jobs. It is how a deposit is recognised as theirs,
 * since the money lands in the exchange's own account where nothing else
 * distinguishes one sender from another; and it is where a withdrawal goes.
 *
 * The second job is why the warning is worded the way it is. Getting this
 * wrong by pasting an exchange's deposit address does not merely confuse the
 * bookkeeping: it sends real money somewhere that often will not credit
 * funds arriving from an unexpected source, and that money does not come
 * back. The warning names that consequence rather than saying "be careful".
 */
function YourWallet({ saved, onSave }: {
  saved: Partial<Record<CashChainId, string>>;
  onSave: (chain: CashChainId, address: string) => Promise<void>;
}) {
  const [chain, setChain] = useState<CashChainId>(CASH_CHAINS[0].id);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  const [deposit, setDeposit] = useState<DepositAddress>();
  const [copied, setCopied] = useState(false);

  const current = saved[chain];

  // Asked for only once this chain has an address saved. Being told where
  // to send before saying who you are is how a deposit ends up belonging to
  // nobody, since it lands in the exchange's account among everyone else's.
  useEffect(() => {
    setDeposit(undefined);
    setCopied(false);
    if (!current) return;
    let live = true;
    call({ type: "depositAddress", chain }).then(
      (d) => live && setDeposit(d),
      () => live && setDeposit({ open: false, why: "the relay could not be reached" }),
    );
    return () => {
      live = false;
    };
  }, [chain, current]);
  const spec = CASH_CHAINS.find((c) => c.id === chain)!;

  const save = async (address: string) => {
    setBusy(true);
    setError(undefined);
    setNote(undefined);
    try {
      await onSave(chain, address);
      setValue("");
      setNote(address ? `Saved for ${spec.name}.` : `Removed for ${spec.name}.`);
    } catch (e) {
      setError((e as RpcError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span className="eyebrow">Your wallet</span>
      {/* The warning sits inside the instruction rather than beside it. It
          is not a separate thing to consider; it is what "which wallet"
          means, and a reader deciding what to paste needs it here. */}
      <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
        Tell Oyster which wallet you send from. It is how your deposit is recognised as yours, and it is where your
        cash goes when you take it out. Use a wallet you control, not an exchange: exchange deposit addresses often
        will not credit money sent from here, and that money cannot be recovered. Phantom or MetaMask is fine.
        Coinbase, Binance and Kraken are not.
      </p>

      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {CASH_CHAINS.map((c) => (
          <button key={c.id} type="button" aria-pressed={chain === c.id}
            onClick={() => { setChain(c.id); setValue(""); setError(undefined); setNote(undefined); }}
            style={{ height: 30, padding: "0 10px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 12,
              fontWeight: chain === c.id ? 600 : 500,
              background: chain === c.id ? "var(--accent-soft)" : "var(--surface-2)",
              color: chain === c.id ? "var(--accent-soft-text)" : "var(--text-2)" }}>
            {c.name}
            {saved[c.id] && <span style={{ marginLeft: 5, opacity: 0.7 }}>·</span>}
          </button>
        ))}
      </div>

      {current && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 10, background: "var(--surface)" }}>
          <span className="mono" style={{ fontSize: 11.5, flexGrow: 1, wordBreak: "break-all" }}>{current}</span>
          <button type="button" className="icon-btn" style={{ width: 28, height: 28, color: "var(--danger-text)" }}
            aria-label={`Remove the ${spec.name} address`} disabled={busy} onClick={() => void save("")}>
            <Icon d={ICONS.trash} size={14} />
          </button>
        </div>
      )}

      {current && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: 12, border: "1px solid var(--border)", borderRadius: 12, background: "var(--surface)" }}>
          <span className="eyebrow">Send {spec.name} USDT to</span>
          {deposit === undefined ? (
            <span className="muted" style={{ fontSize: 12.5 }}>Asking the exchange…</span>
          ) : deposit.open && deposit.address ? (
            <>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span className="mono" style={{ fontSize: 12, wordBreak: "break-all", lineHeight: 1.45, flexGrow: 1, minWidth: 0 }}>{deposit.address}</span>
                <Button variant="secondary" style={{ width: "auto", height: 30, padding: "0 12px", fontSize: 12, flexShrink: 0 }}
                  onClick={() => { void navigator.clipboard.writeText(deposit.address!); setCopied(true); }}>
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <span className="muted" style={{ fontSize: 11.5 }}>
                Send only from {shortAddr(current, 6, 4)}, or it will not be recognised as yours.
              </span>
              {deposit.prove ? (
                // The first deposit is the proof, so it has to be exact. Said
                // loudly: any other amount is set aside for a person to place.
                <Callout kind="warn">
                  <strong>First deposit: send exactly {deposit.prove.amount} USDT</strong> from{" "}
                  {shortAddr(current, 6, 4)}. That exact amount proves the address is yours, and it is credited to you
                  like any deposit. After it arrives, send any amount you like.
                  {deposit.prove.expires && (
                    <> This amount is reserved for you until {new Date(deposit.prove.expires).toLocaleString()}.</>
                  )}
                </Callout>
              ) : (
                deposit.minimum && (
                  <span className="muted" style={{ fontSize: 11.5 }}>
                    Send at least {deposit.minimum} USDT. Less than that is not worth the fees to take back out.
                  </span>
                )
              )}
            </>
          ) : (
            <span className="muted" style={{ fontSize: 12.5 }}>
              {deposit.why ?? "Not available yet."}
            </span>
          )}
        </div>
      )}

      <div className="field">
        <div className="input">
          <input value={value} spellCheck={false} autoCapitalize="off" className="mono" style={{ fontSize: 12 }}
            placeholder={current ? `Replace the ${spec.name} address` : `Your ${spec.name} address`}
            onChange={(e) => { setValue(e.target.value); setError(undefined); setNote(undefined); }} />
        </div>
      </div>

      {error && <Callout kind="danger">{error}</Callout>}
      {note && <Callout kind="info" icon={ICONS.check}>{note}</Callout>}

      <Button variant="secondary" disabled={value.trim().length === 0 || busy} onClick={() => void save(value.trim())}>
        {busy ? "Saving\u2026" : current ? "Replace it" : "Save it"}
      </Button>

      <span className="muted" style={{ fontSize: 11.5 }}>
        Deposits work on more chains than these four, but cash can only be sent back on these, so they are the only
        ones worth nominating an address for.
      </span>
    </div>
  );
}
