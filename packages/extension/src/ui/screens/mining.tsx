import { useEffect, useState } from "react";
import type { AutoSell, MiningView, PriceView } from "../../messages";
import { usdt } from "../chart";
import { Button, Callout, Header, Icon, ICONS, Toggle } from "../components";
import { ago, prl, shortAddr, parseAmount } from "../format";
import { call, RpcError } from "../rpc";

const tz = () => new Date().getTimezoneOffset();

export function Mining({ walletName, price, onBack, onOpenPayout }: {
  walletName: string; price?: PriceView; onBack: () => void; onOpenPayout: (txid: string) => void;
}) {
  const [m, setM] = useState<MiningView>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = async (refresh = false) => {
    try {
      setM(await call({ type: "miningView", tzOffsetMinutes: tz(), refresh }));
      setError(undefined);
    } catch (e) {
      setError((e as RpcError).message);
    }
  };
  useEffect(() => void load(), []);

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    try {
      await call({ type: "setMinerMode", enabled });
      await load();
    } catch (e) {
      setError((e as RpcError).message);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!m?.payoutAddress) return;
    await navigator.clipboard.writeText(m.payoutAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (!m) {
    return (
      <div className="screen">
        <Header title="Mining" onBack={onBack} />
        <div className="body">{error ? <Callout kind="danger">{error}</Callout> : <span className="muted">Loading…</span>}</div>
      </div>
    );
  }

  if (!m.enabled) {
    return (
      <div className="screen">
        <Header title="Mining" onBack={onBack} />
        <div className="body">
          <span className="dot-icon" style={{ width: 52, height: 52, borderRadius: 26, alignSelf: "center" }}><Icon d={ICONS.chip} size={24} /></span>
          <h1 className="title" style={{ textAlign: "center" }}>Mine to {walletName}</h1>
          <p className="lead" style={{ textAlign: "center" }}>
            Miner mode gives this wallet one fixed payout address for your pool, and tracks what you earn each day.
          </p>
          <Callout kind="info" icon={ICONS.check}>
            Every payment this wallet receives counts as a payout, pool payouts and solo block rewards alike.
          </Callout>
          {error && <Callout kind="danger">{error}</Callout>}
          <div className="spacer" />
          <Button disabled={busy} onClick={() => toggle(true)}>{busy ? "Turning on…" : "Turn on miner mode"}</Button>
        </div>
      </div>
    );
  }

  const since = m.coveredSince
    ? new Date(m.coveredSince * 1000).toLocaleString("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false })
    : undefined;
  const max = m.days.reduce((a, d) => (BigInt(d.total) > a ? BigInt(d.total) : a), 0n);
  const dayLabel = (start: number) => new Date(start * 1000).toLocaleDateString("en-US", { weekday: "short" });

  return (
    <div className="screen">
      <Header title="Mining" onBack={onBack}
        right={<button type="button" className="icon-btn" aria-label="Refresh" onClick={() => load(true)}><Icon d={ICONS.refresh} /></button>} />
      <div className="body" style={{ gap: 11, padding: "14px 16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span className="eyebrow">Mined today</span>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span style={{ fontFamily: "var(--serif)", fontSize: 34, lineHeight: 1.05, letterSpacing: "-0.02em" }}>{prl(m.today.total, 2)}</span>
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-2)" }}>PRL</span>
            </div>
            <span className="muted" style={{ fontSize: 12.5 }}>
              {price && BigInt(m.today.total) > 0n ? `≈ ${usdt((Number(m.today.total) / 1e8) * price.usdPerPrl)} USDT · ` : ""}
              {m.today.count} payout{m.today.count === 1 ? "" : "s"}
            </span>
          </div>
          <span className="chip" style={{ background: "var(--surface-2)", color: "var(--text-2)" }}>{walletName}</span>
        </div>

        <div role="img" aria-label="PRL mined per day, last 7 days"
          style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0,1fr))", gap: 8, alignItems: "end" }}>
          {m.days.map((d, i) => {
            const h = max > 0n ? Math.max(2, Math.round(Number((BigInt(d.total) * 62n) / max))) : 2;
            const today = i === m.days.length - 1;
            return (
              <div key={d.start} title={`${prl(d.total, 2)} PRL`}
                style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", gap: 5, height: 84 }}>
                <div style={{ width: "100%", height: h, borderRadius: 4, background: "var(--accent)", opacity: today ? 1 : 0.35 }} />
                <span className="mono" style={{ fontSize: 10.5, color: today ? "var(--text)" : "var(--text-3)" }}>{dayLabel(d.start)}</span>
              </div>
            );
          })}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 8, padding: "10px 12px", borderRadius: 10, background: "var(--surface-2)" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <span className="muted" style={{ fontSize: 11.5 }}>{since ? `Since ${since}` : "Last 7 days"}</span>
            <span className="mono" style={{ fontSize: 13 }}>{prl(m.last7, 2)} PRL</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <span className="muted" style={{ fontSize: 11.5 }}>{since ? "Daily average, partial" : "Daily average"}</span>
            <span className="mono" style={{ fontSize: 13 }}>{prl(m.dailyAverage, 2)} PRL</span>
          </div>
        </div>

        {m.payoutAddress && (
          <div className="card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            <span className="label">Your payout address</span>
            <span className="mono" style={{ fontSize: 12, wordBreak: "break-all", userSelect: "all" }}>{m.payoutAddress}</span>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <span className="muted">Put this in your pool's payout setting. It never changes.</span>
              <button type="button" className="btn btn-secondary" style={{ width: "auto", height: 36, padding: "0 12px", fontSize: 13 }} onClick={copy}>
                <Icon d={copied ? ICONS.check : ICONS.copy} size={16} />{copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        )}

        <AutoSellCard price={price} />

        {m.payouts.length === 0 ? (
          <p className="muted" style={{ textAlign: "center" }}>
            No payouts yet{m.payoutAddress ? ` to ${shortAddr(m.payoutAddress, 9, 5)}` : ""}. They show up here as they arrive.
          </p>
        ) : (
          <div className="card">
            {m.payouts.slice(0, 20).map((p) => (
              <button key={p.txid} type="button" className="list-row" style={{ minHeight: 52 }} onClick={() => onOpenPayout(p.txid)}>
                <span className="main">
                  <span className="t">{p.blockReward ? "Block reward" : "Pool payout"}</span>
                  <span className="s">{p.confirmations === 0 ? "just now" : ago(p.time)}</span>
                </span>
                <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                  <span className="mono pos" style={{ fontSize: 13 }}>+{prl(p.amount, 2)}</span>
                  {p.status !== "confirmed" && <span className="chip warn">{p.status}</span>}
                </span>
              </button>
            ))}
          </div>
        )}
        {since && (
          <p className="muted" style={{ textAlign: "center" }}>
            This address has more payouts than Oyster loads at once, so figures start {since}.
          </p>
        )}
        {error && <Callout kind="danger">{error}</Callout>}
        <Button variant="ghost" disabled={busy} onClick={() => toggle(false)}>Turn off miner mode</Button>
      </div>
    </div>
  );
}

/**
 * Selling payouts without being asked each time.
 *
 * Two honesties this card insists on. It only runs while the wallet is
 * unlocked, because a sell starts with a Pearl transaction this wallet has to
 * sign, and a locked wallet has no keys to sign it with. And it sells on a
 * threshold rather than per payout, because a pool that pays every few
 * minutes would otherwise become a stream of tiny trades, each carrying a
 * fee worth more than it returns.
 */
function AutoSellCard({ price }: { price?: PriceView }) {
  const [settings, setSettings] = useState<AutoSell>();
  const [threshold, setThreshold] = useState("");
  const [percent, setPercent] = useState(100);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    call({ type: "autoSell" }).then((a) => {
      setSettings(a);
      setThreshold(prl(a.threshold, 4));
      setPercent(a.percent);
    }, () => {});
  }, []);

  const save = async (next: { enabled?: boolean; threshold?: string; percent?: number }) => {
    if (!settings) return;
    setBusy(true);
    setError(undefined);
    const grains = parseAmount(next.threshold ?? threshold);
    try {
      const saved = await call({
        type: "setAutoSell",
        enabled: next.enabled ?? settings.enabled,
        threshold: (grains ?? BigInt(settings.threshold)).toString(),
        percent: next.percent ?? percent,
      });
      setSettings(saved);
      setThreshold(prl(saved.threshold, 4));
      setPercent(saved.percent);
    } catch (e) {
      setError((e as RpcError).message);
    } finally {
      setBusy(false);
    }
  };

  const thresholdGrains = parseAmount(threshold);
  const worth = thresholdGrains && price ? (Number(thresholdGrains) / 1e8) * price.usdPerPrl : undefined;

  return (
    <div className="card" style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, minHeight: 54, padding: "0 12px" }}>
        <span style={{ display: "flex", color: "var(--text-2)" }}><Icon d={ICONS.trade} /></span>
        <button type="button" onClick={() => setOpen(!open)}
          style={{ flexGrow: 1, display: "flex", flexDirection: "column", alignItems: "flex-start", border: "none", background: "none", padding: 0, cursor: "pointer", color: "var(--text)" }}>
          <span style={{ fontSize: 13.5, fontWeight: 600 }}>Auto-sell payouts</span>
          <span className="muted">
            {settings?.enabled
              ? `${settings.percent}% above ${prl(settings.threshold, 2)} PRL`
              : "Sell mined PRL for USDT as it adds up"}
          </span>
        </button>
        <Toggle on={settings?.enabled === true} label="Sell mining payouts automatically"
          onChange={(v) => { setOpen(v); void save({ enabled: v }); }} />
      </div>

      {(open || settings?.enabled) && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "0 12px 12px" }}>
          <div className="field">
            <label htmlFor="asthresh" className="label">Sell once mined PRL reaches</label>
            <div className="input">
              <input id="asthresh" inputMode="decimal" value={threshold}
                onChange={(e) => setThreshold(e.target.value.replace(/[^0-9.]/g, ""))}
                onBlur={() => void save({})} />
              <span className="muted">PRL{worth !== undefined ? ` \u2248 ${usdt(worth)} USDT` : ""}</span>
            </div>
          </div>

          <div className="field">
            <span className="label">How much of it to sell</span>
            <div style={{ display: "flex", gap: 6 }}>
              {[25, 50, 75, 100].map((n) => (
                <button key={n} type="button" aria-pressed={percent === n} disabled={busy}
                  onClick={() => { setPercent(n); void save({ percent: n }); }}
                  style={{ flexGrow: 1, height: 34, borderRadius: 8, border: "none", cursor: "pointer", fontSize: 12.5, fontWeight: percent === n ? 600 : 500,
                    background: percent === n ? "var(--accent-soft)" : "var(--surface-2)", color: percent === n ? "var(--accent-soft-text)" : "var(--text-2)" }}>
                  {n}%
                </button>
              ))}
            </div>
          </div>

          <Callout kind="info" icon={ICONS.lock}>
            Auto-sell can only run while this wallet is unlocked: a sell starts with a Pearl transaction it has to
            sign, and a locked wallet has no keys to sign with. Nothing is sold while you are away.
          </Callout>
          <span className="muted" style={{ fontSize: 11.5 }}>
            Each sale pays Oyster 1.25% and the exchange its own fee, the same as selling by hand.
          </span>
          {error && <Callout kind="danger">{error}</Callout>}
          {settings?.enabled && !error && (
            <span className="muted" style={{ fontSize: 11.5 }}>
              {settings.lastRun ? `Last sold ${ago(settings.lastRun)}.` : "Starts with trading, which is not open yet."}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
