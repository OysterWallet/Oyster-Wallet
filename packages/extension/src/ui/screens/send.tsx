import { formatPrl, isValidAddress, parsePaymentUri, PEARL_MAINNET, PEARL_TESTNET2, UriError } from "@pearl-wallet/core";
import { useEffect, useState } from "react";
import type { Contact, EstimatedTier, FeeTier, NetworkId, PriceView, SendArgs, SendQuote, WalletView } from "../../messages";
import { usdt } from "../chart";
import { Button, Callout, Header, Icon, ICONS } from "../components";
import { parseAmount, prl, prlExact, prlReview, shortAddr } from "../format";
import { call, RpcError } from "../rpc";

const NETS = { mainnet: PEARL_MAINNET, testnet2: PEARL_TESTNET2 } as const;
const TIERS: { id: EstimatedTier; label: string; eta: string }[] = [
  { id: "slow", label: "Slow", eta: "~ 30 min" },
  { id: "normal", label: "Normal", eta: "~ 10 min" },
  { id: "fast", label: "Fast", eta: "next block" },
];
/** A one-input, two-output taproot spend, for the per-tier fee preview only.
 *  The review screen shows the real fee for the real transaction. */
const TYPICAL_VSIZE = 154;

export interface SendDraft {
  to: string;
  amount: string;
  max: boolean;
  tier: FeeTier;
  /** Kept so coming back from Review does not lose a typed fee rate. */
  rate?: number;
  /** Coin control: the outpoints chosen for this send, if any. */
  only?: string[];
}

/** "≈ 410.00 USDT" under an amount, when a price is known. */
function Fiat({ grains, price }: { grains: bigint | null; price?: PriceView }) {
  if (!price || grains === null || grains <= 0n) return null;
  return <span className="muted">≈ {usdt((Number(grains) / 1e8) * price.usdPerPrl)} USDT</span>;
}

export function Send({
  view, network, draft, price, onBack, onReview, onPickCoins,
}: {
  view?: WalletView; network: NetworkId; draft?: SendDraft; price?: PriceView; onBack: () => void;
  onReview: (args: SendArgs, quote: SendQuote, draft: SendDraft) => void;
  onPickCoins: (draft: SendDraft) => void;
}) {
  const [to, setTo] = useState(draft?.to ?? "");
  const [amount, setAmount] = useState(draft?.amount ?? "");
  const [max, setMax] = useState(draft?.max ?? false);
  // Max is a real number, not a word: what a send would pay out after the fee
  // for the chosen speed. Planned by the service, since only it holds the
  // coins; the recipient does not change it, every Pearl output being taproot.
  const [maxAmount, setMaxAmount] = useState<{ amount: string; fee: string } | "unknown">();
  const [tier, setTier] = useState<FeeTier>(draft?.tier ?? "normal");
  const [customRate, setCustomRate] = useState(draft?.rate ? String(draft.rate) : "");
  const only = draft?.only ?? [];
  const [rates, setRates] = useState<Record<EstimatedTier, number>>();
  const [book, setBook] = useState<Contact[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    call({ type: "feeOptions" }).then((f) => setRates(f.rates), (e: RpcError) => setError(e.message));
    call({ type: "addressBook" }).then(setBook, () => {});
  }, []);

  // The fee, and so the payout, depends on the speed chosen, so this re-runs
  // whenever the tier does. A failure here is not shown: pressing Review
  // re-plans and reports it properly.
  useEffect(() => {
    if (!max) return setMaxAmount(undefined);
    let live = true;
    setMaxAmount(undefined);
    call({ type: "maxSpend", tier, ...(tier === "custom" ? { rate: Number(customRate) } : {}) }).then(
      (m) => { if (live) setMaxAmount(m); },
      // Nothing to plan (no coins, or watch-only). Review reports it properly.
      () => { if (live) setMaxAmount("unknown"); },
    );
    return () => { live = false; };
  }, [max, tier, customRate]);

  // A pearl: link carries the amount and a note as well as the address, so
  // reading one fills the form in rather than being rejected as "not an
  // address". Anything else falls through untouched.
  const [note, setNote] = useState<string>();
  const [uriError, setUriError] = useState<string>();
  const accept = (text: string) => {
    const t = text.trim();
    setTo(t);
    setUriError(undefined);
    setNote(undefined);
    if (!/^pearl:/i.test(t)) return;
    try {
      const p = parsePaymentUri(t, NETS[network]);
      setTo(p.address);
      if (p.amount !== undefined) {
        setMax(false);
        setAmount(formatPrl(p.amount));
      }
      const label = p.label ?? p.message;
      if (label) setNote(label);
    } catch (e) {
      setUriError(e instanceof UriError ? `That link could not be used: ${e.message}.` : "That link could not be used.");
    }
  };

  const addrTrim = to.trim();
  const addrOk = addrTrim.length > 0 && isValidAddress(addrTrim, NETS[network]);
  const grains = max ? null : parseAmount(amount);
  // Below the dust threshold the network will not relay the output at all.
  // Better said here than discovered as a server error on Review.
  const dust = NETS[network].dustThreshold;
  const tooSmall = grains !== null && grains > 0n && grains < dust;
  const spendable = view ? BigInt(view.spendable) : 0n;
  const amountOk = max || (grains !== null && grains > 0n && grains <= spendable && !tooSmall);
  const rateOk = tier !== "custom" || (Number(customRate) >= 1 && Number(customRate) <= 5000);
  const canReview = addrOk && amountOk && !!rates && rateOk && !busy;

  const paste = async () => {
    try {
      accept(await navigator.clipboard.readText());
    } catch {
      document.getElementById("to")?.focus();
    }
  };

  const review = async () => {
    setError(undefined);
    setBusy(true);
    const rateArg = { ...(tier === "custom" ? { rate: Number(customRate) } : {}), ...(only.length > 0 ? { only } : {}) };
    const args: SendArgs = max
      ? { to: addrTrim, max: true, tier, ...rateArg }
      : { to: addrTrim, amount: grains!.toString(), tier, ...rateArg };
    try {
      const quote = await call({ type: "quoteSend", args });
      onReview(args, quote, { to, amount, max, tier, ...(tier === "custom" ? { rate: Number(customRate) } : {}), ...(only.length > 0 ? { only } : {}) });
    } catch (e) {
      setError((e as RpcError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen">
      <Header title="Send PRL" onBack={onBack} />
      <div className="body">
        <div className="field">
          <label htmlFor="to" className="label">Recipient</label>
          <div className={`input ${addrTrim && !addrOk ? "invalid" : ""}`}>
            <input id="to" value={to} spellCheck={false} autoComplete="off" autoFocus placeholder={`${NETS[network].bech32}1p…`}
              className="mono" style={{ fontFamily: "var(--mono)" }} onChange={(e) => accept(e.target.value)} />
            <button type="button" aria-label="Paste address" className="icon-btn" style={{ width: 32, height: 32, color: "var(--accent)" }} onClick={paste}>
              <Icon d={ICONS.paste} />
            </button>
          </div>
        </div>
        {addrTrim && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: -8, fontSize: 12, color: addrOk ? "var(--accent)" : "var(--danger-text)" }}>
            <Icon d={addrOk ? ICONS.check : ICONS.warn} size={14} />
            {addrOk ? "Valid Pearl address" : invalidReason(addrTrim, network)}
          </div>
        )}

        {uriError && <Callout kind="danger">{uriError}</Callout>}
        {note && (
          <Callout kind="info" icon={ICONS.check}>
            This request says it is for: {note}
          </Callout>
        )}

        {addrTrim.length === 0 && book.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span className="eyebrow">Paid before</span>
            {book.slice(0, 4).map((c) => (
              <button key={c.address} type="button" className="list-row" style={{ padding: 0, minHeight: 48 }}
                onClick={() => accept(c.address)}>
                <span className="main">
                  <span className="t">{c.label ?? shortAddr(c.address, 12, 8)}</span>
                  {c.label && <span className="s mono">{shortAddr(c.address, 12, 8)}</span>}
                </span>
                <Icon d={ICONS.chevron} size={15} />
              </button>
            ))}
          </div>
        )}

        <div className="field">
          <label htmlFor="amt" className="label">Amount</label>
          <div className="input" style={{ height: 64 }}>
            <input id="amt" inputMode="decimal" placeholder="0.0000" readOnly={max}
              value={max ? (maxAmount === undefined ? "…" : maxAmount === "unknown" ? "Max" : prlReview(maxAmount.amount)) : amount}
              style={{ fontFamily: "var(--serif)", fontSize: 30 }}
              onChange={(e) => setAmount(e.target.value)} />
            <span style={{ fontWeight: 600, color: "var(--text-2)" }}>PRL</span>
            <button type="button" aria-pressed={max} onClick={() => setMax(!max)}
              style={{ height: 32, padding: "0 10px", borderRadius: 8, border: "1px solid var(--border)", background: max ? "var(--accent-soft)" : "var(--surface-2)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
              Max
            </button>
          </div>
          <div className="muted" style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
            <span>
              {!max && tooSmall ? (
                <span className="error-text">Too small. The network ignores anything under {prl(dust, 8)} PRL.</span>
              ) : !max && grains !== null && grains > spendable ? (
                <span className="error-text">More than you can spend</span>
              ) : max ? (
                maxAmount === undefined
                  ? "Working out the fee…"
                  : maxAmount === "unknown"
                    ? "Everything spendable, minus the fee"
                    : `Everything spendable, minus the ${prlReview(maxAmount.fee)} PRL fee`
              ) : (
                <Fiat grains={grains} price={price} />
              )}
            </span>
            <span>Available {prl(spendable)}</span>
          </div>
        </div>

        <div className="field">
          <span className="label">Network fee</span>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 8 }}>
            {TIERS.map((t) => (
              <button key={t.id} type="button" aria-pressed={tier === t.id} onClick={() => setTier(t.id)}
                style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2, padding: 10, minHeight: 64, borderRadius: 10, cursor: "pointer", textAlign: "left",
                  border: `1.5px solid ${tier === t.id ? "var(--accent)" : "var(--border)"}`, background: tier === t.id ? "var(--accent-soft)" : "var(--surface)" }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{t.label}</span>
                <span style={{ fontSize: 11.5, color: "var(--text-2)" }}>{t.eta}</span>
                <span className="mono" style={{ fontSize: 10.5, color: "var(--text-3)" }}>
                  {rates ? prlExact(BigInt(Math.ceil(rates[t.id] * TYPICAL_VSIZE))) : "…"}
                </span>
              </button>
            ))}
          </div>
          <button type="button" aria-pressed={tier === "custom"} onClick={() => setTier(tier === "custom" ? "normal" : "custom")}
            style={{ alignSelf: "flex-start", padding: 0, border: "none", background: "none", color: "var(--accent)", fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>
            {tier === "custom" ? "Use an estimate instead" : "Set the fee myself"}
          </button>
          {tier === "custom" && (
            <div className="field">
              <label htmlFor="rate" className="label">Fee rate, sat/vB</label>
              <div className="input">
                <input id="rate" inputMode="decimal" value={customRate} placeholder="1" autoFocus
                  onChange={(e) => setCustomRate(e.target.value.replace(/[^0-9.]/g, ""))} />
                <span className="muted">
                  {customRate && rateOk ? `\u2248 ${prlExact(BigInt(Math.ceil(Number(customRate) * TYPICAL_VSIZE)))} PRL` : ""}
                </span>
              </div>
              {customRate && !rateOk && (
                <span className="error-text">Between 1 and 5000 sat/vB. Pearl needs 1; anything near 5000 is a mistake.</span>
              )}
            </div>
          )}
        </div>
        <button type="button"
          onClick={() => onPickCoins({ to, amount, max, tier, ...(tier === "custom" ? { rate: Number(customRate) } : {}), ...(only.length > 0 ? { only } : {}) })}
          className="list-row" style={{ padding: "0 12px", border: "1px solid var(--border)", borderRadius: 10, background: "var(--surface)", minHeight: 48 }}>
          <span className="main">
            <span className="t">Choose coins</span>
            <span className="s">{only.length === 0 ? "Oyster picks them" : `${only.length} chosen`}</span>
          </span>
          <Icon d={ICONS.chevron} size={15} />
        </button>
        {error && <Callout kind="danger">{error}</Callout>}
        <div className="spacer" />
        <Button disabled={!canReview} onClick={review}>{busy ? "Checking…" : "Review"}</Button>
      </div>
    </div>
  );
}

function invalidReason(addr: string, network: NetworkId): string {
  const hrp = addr.toLowerCase().split("1")[0];
  if (hrp === "tprl" && network === "mainnet") return "This is a testnet address";
  if (hrp === "prl" && network !== "mainnet") return "This is a mainnet address";
  if (hrp === "bc" || /^[13]/.test(addr)) return "This looks like a Bitcoin address";
  if (addr.startsWith("0x")) return "This is an Ethereum address, not Pearl";
  return "Not a valid Pearl address";
}

export function SendReview({
  quote, args, walletName, price, onBack, onSent,
}: {
  quote: SendQuote; args: SendArgs; walletName: string; price?: PriceView; onBack: () => void;
  onSent: (txid: string, quote: SendQuote) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const confirm = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await call({ type: "send", args });
      onSent(r.txid, r.quote);
    } catch (e) {
      setError((e as RpcError).message);
      setBusy(false);
    }
  };

  const ex = quote.excluded;
  return (
    <div className="screen">
      <Header title="Review" onBack={busy ? undefined : onBack} />
      <div className="body">
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, padding: "6px 0" }}>
          <span className="muted" style={{ fontSize: 12.5 }}>You are sending</span>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ fontFamily: "var(--serif)", fontSize: 38, lineHeight: 1.05, letterSpacing: "-0.02em" }}>{prlReview(quote.amount)}</span>
            <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-2)" }}>PRL</span>
          </div>
          <Fiat grains={BigInt(quote.amount)} price={price} />
        </div>
        <div className="kv">
          <div style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
            <span className="k">To</span>
            {/* The whole address, never elided: the middle is exactly where an
                address swap or a poisoned lookalike hides. */}
            <span className="v mono" style={{ textAlign: "left", lineHeight: 1.6, wordBreak: "break-all", userSelect: "all" }}>{quote.to}</span>
          </div>
          <div><span className="k">From</span><span className="v" style={{ fontFamily: "var(--sans)" }}>{walletName}</span></div>
          <div><span className="k">Network fee</span><span className="v">{prlExact(quote.fee)} PRL</span></div>
          <div><span className="k">Total</span><span className="v">{prlExact(quote.total)} PRL</span></div>
        </div>
        {ex.frozen > 0 && (
          <Callout kind="info" icon={ICONS.shield}>
            Protected coins stay untouched. {ex.frozen} {ex.frozen === 1 ? "output that may carry" : "outputs that may carry"} PRC-20 tokens {ex.frozen === 1 ? "was" : "were"} left out of this send.
          </Callout>
        )}
        {ex.immature > 0 && (
          <Callout kind="info" icon={ICONS.clock}>
            {ex.immature} mining {ex.immature === 1 ? "reward is" : "rewards are"} still maturing and {ex.immature === 1 ? "was" : "were"} left out.
          </Callout>
        )}
        {error && <Callout kind="danger">{error}</Callout>}
        <div className="spacer" />
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Button disabled={busy} onClick={confirm}>{busy ? "Signing and sending…" : "Confirm and send"}</Button>
          <Button variant="ghost" disabled={busy} onClick={onBack}>Edit</Button>
        </div>
      </div>
    </div>
  );
}
