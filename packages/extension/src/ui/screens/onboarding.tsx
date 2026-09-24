import { useMemo, useState } from "react";
import { BRAND, Button, Callout, Header, Logo, PasswordInput, Steps } from "../components";
import { call, RpcError } from "../rpc";

export function Welcome({ network, onCreate, onImport }: { network: string; onCreate: () => void; onImport: () => void }) {
  return (
    <div className="screen">
      <div className="body" style={{ gap: 16, padding: "28px 24px 20px" }}>
        <div className="spacer" />
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 18, textAlign: "center" }}>
          <Logo size={76} />
          <div style={{ fontFamily: "var(--serif)", fontSize: 44, lineHeight: 1, letterSpacing: "-0.02em" }}>{BRAND}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 270 }}>
            <p style={{ margin: 0, fontSize: 16 }}>A self-custody wallet for Pearl.</p>
            <p className="lead">Send and receive PRL. Your keys never leave this browser.</p>
          </div>
        </div>
        <div className="spacer" />
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Button onClick={onCreate}>Create a new wallet</Button>
          <Button variant="secondary" onClick={onImport}>I already have a seed phrase</Button>
        </div>
        <div className="eyebrow" style={{ textAlign: "center", letterSpacing: "0.06em" }}>
          {network.toUpperCase()} · BIP-86 TAPROOT
        </div>
      </div>
    </div>
  );
}

/** 0-4, shown as the four-segment meter from the design. Advisory only; the
 *  hard rule is the vault's 8-character minimum. */
export function strength(pw: string): number {
  if (pw.length < 8) return pw.length ? 1 : 0;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  let s = 1;
  if (pw.length >= 12) s++;
  if (classes >= 3 || pw.length >= 16) s++;
  if (pw.length >= 16 && classes >= 2) s++;
  return Math.min(s, 4);
}
const STRENGTH = ["", "Weak", "Fair", "Good", "Strong"];

export function CreatePassword({
  imported,
  busy,
  error,
  onBack,
  onContinue,
}: {
  imported: boolean;
  busy?: boolean;
  error?: string;
  onBack: () => void;
  onContinue: (password: string) => void;
}) {
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");
  const [ack, setAck] = useState(false);
  const s = strength(pw1);
  const mismatch = pw2.length > 0 && pw1 !== pw2;
  const ok = pw1.length >= 8 && pw1 === pw2 && ack && !busy;

  return (
    <div className="screen">
      <Header title="Create password" onBack={onBack} />
      <div className="body">
        {!imported && <Steps step={1} />}
        <h1 className="title">Lock this wallet</h1>
        <p className="lead">This password encrypts your keys on this device. Nobody can recover it for you.</p>
        <div className="field">
          <label htmlFor="pw1" className="label">New password</label>
          <PasswordInput id="pw1" value={pw1} onChange={setPw1} autoFocus />
        </div>
        {pw1.length > 0 && (
          <div className="field">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: 4 }}>
              {[1, 2, 3, 4].map((n) => (
                <div key={n} style={{ height: 4, borderRadius: 2, background: n <= s ? "var(--accent)" : "var(--border)" }} />
              ))}
            </div>
            <div style={{ fontSize: 12, fontWeight: 600, color: s >= 3 ? "var(--accent)" : "var(--text-3)" }}>
              {pw1.length < 8 ? "At least 8 characters" : STRENGTH[s]}
            </div>
          </div>
        )}
        <div className="field">
          <label htmlFor="pw2" className="label">Confirm password</label>
          <PasswordInput id="pw2" value={pw2} onChange={setPw2} onEnter={() => ok && onContinue(pw1)} />
          {mismatch && <span className="error-text">Passwords do not match.</span>}
        </div>
        <label htmlFor="ack" style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 12.5, color: "var(--text-2)", minHeight: 44 }}>
          <input id="ack" type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)}
            style={{ width: 18, height: 18, margin: "1px 0 0", accentColor: "var(--accent)", flexShrink: 0 }} />
          <span>I understand Oyster cannot reset this password. Only my seed phrase can restore the wallet.</span>
        </label>
        {error && <Callout kind="danger">{error}</Callout>}
        <div className="spacer" />
        <Button disabled={!ok} onClick={() => onContinue(pw1)}>
          {busy ? "Encrypting…" : imported ? "Import wallet" : "Continue"}
        </Button>
      </div>
    </div>
  );
}

export function SeedBackup({ mnemonic, onBack, onDone }: { mnemonic: string; onBack: () => void; onDone: () => void }) {
  const words = mnemonic.split(" ");
  return (
    <div className="screen">
      <Header title="Back up" onBack={onBack} />
      <div className="body" style={{ gap: 13, padding: "16px 20px 20px" }}>
        <Steps step={2} />
        <h1 className="title">Write down your seed phrase</h1>
        <Callout kind="warn">
          Anyone with these {words.length} words can take your PRL. Write them on paper. Never type them into a
          website, a chat, or a screenshot.
        </Callout>
        <ol style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 6, margin: 0, padding: 0, listStyle: "none" }}>
          {words.map((w, i) => (
            <li key={i} style={{ display: "flex", alignItems: "center", gap: 8, height: 38, padding: "0 10px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--surface)" }}>
              <span className="mono" style={{ fontSize: 11, color: "var(--text-3)", width: 16 }}>{i + 1}</span>
              <span className="mono" style={{ fontSize: 13 }}>{w}</span>
            </li>
          ))}
        </ol>
        <div className="spacer" />
        <Button onClick={onDone}>I wrote it down</Button>
      </div>
    </div>
  );
}

function randomInt(max: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0]! % max;
}

export function SeedConfirm({
  mnemonic,
  busy,
  error,
  onBack,
  onConfirmed,
}: {
  mnemonic: string;
  busy?: boolean;
  error?: string;
  onBack: () => void;
  onConfirmed: () => void;
}) {
  const words = mnemonic.split(" ");
  // Three positions to check, plus three decoys from elsewhere in the phrase.
  const { asks, options } = useMemo(() => {
    const picks = new Set<number>();
    while (picks.size < 3) picks.add(randomInt(words.length));
    const asks = [...picks].sort((a, b) => a - b);
    const decoys = new Set<string>();
    while (decoys.size < 3) {
      const w = words[randomInt(words.length)]!;
      if (!asks.some((i) => words[i] === w)) decoys.add(w);
    }
    const options = [...asks.map((i) => words[i]!), ...decoys];
    for (let i = options.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [options[i], options[j]] = [options[j]!, options[i]!];
    }
    return { asks, options };
  }, [mnemonic]);

  const [filled, setFilled] = useState<(string | null)[]>([null, null, null]);
  const next = filled.indexOf(null);
  const complete = next === -1;
  const correct = complete && asks.every((pos, k) => words[pos] === filled[k]);

  const pick = (w: string) => {
    if (complete) return;
    const f = [...filled];
    f[next] = w;
    setFilled(f);
  };
  const clear = (k: number) => {
    const f = [...filled];
    f[k] = null;
    setFilled(f);
  };

  return (
    <div className="screen">
      <Header title="Confirm backup" onBack={onBack} />
      <div className="body" style={{ gap: 16 }}>
        <Steps step={3} />
        <h1 className="title">Check your backup</h1>
        <p className="lead">Pick words {asks.map((i) => i + 1).join(", ").replace(/, (\d+)$/, " and $1")} from your written copy.</p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 8 }}>
          {asks.map((pos, k) => (
            <div key={pos} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <span className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>Word {pos + 1}</span>
              <button type="button" onClick={() => clear(k)} aria-label={`Word ${pos + 1}`}
                style={{ height: 44, border: `1.5px solid ${k === next ? "var(--accent)" : "var(--border)"}`, borderRadius: 8, background: "var(--surface)", cursor: filled[k] ? "pointer" : "default" }}>
                {filled[k] ? <span className="mono" style={{ fontSize: 13 }}>{filled[k]}</span> : <span className="muted">{k === next ? "Tap a word" : ""}</span>}
              </button>
            </div>
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 8 }}>
          {options.map((w, i) => {
            const used = filled.filter((f) => f === w).length >= options.filter((o) => o === w).length;
            return (
              <button key={`${w}-${i}`} type="button" disabled={used || complete} onClick={() => pick(w)} className="mono"
                style={{ height: 44, borderRadius: 8, border: "1px solid var(--border)", background: used ? "var(--surface-2)" : "var(--surface)", color: used ? "var(--text-3)" : "var(--text)", fontSize: 13, cursor: used ? "default" : "pointer" }}>
                {w}
              </button>
            );
          })}
        </div>
        {complete && !correct && (
          <Callout kind="danger">Those do not match your phrase. Tap a word above to clear it, and check your written copy.</Callout>
        )}
        {error && <Callout kind="danger">{error}</Callout>}
        <div className="spacer" />
        <Button disabled={!correct || busy} onClick={onConfirmed}>{busy ? "Encrypting…" : "Finish setup"}</Button>
      </div>
    </div>
  );
}

export function ImportWallet({ network, onBack, onContinue }: { network: string; onBack: () => void; onContinue: (mnemonic: string) => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const count = text.trim() ? text.trim().split(/\s+/).length : 0;
  const target = count > 12 ? 24 : 12;

  const submit = async () => {
    setError(undefined);
    try {
      const r = await call({ type: "validateMnemonic", mnemonic: text });
      if (!r.valid) {
        setError(
          r.words === 12 || r.words === 24
            ? "One of the words is wrong or out of order. Check each word against your written copy."
            : "A seed phrase has 12 or 24 words.",
        );
        return;
      }
      onContinue(text);
    } catch (e) {
      setError((e as RpcError).message);
    }
  };

  return (
    <div className="screen">
      <Header title="Import wallet" onBack={onBack} />
      <div className="body" style={{ gap: 16 }}>
        <h1 className="title">Enter your seed phrase</h1>
        <div className="field">
          <label htmlFor="seed" className="label">Seed phrase</label>
          <textarea id="seed" className="textarea" value={text} autoFocus spellCheck={false} autoComplete="off"
            placeholder="harbor velvet orbit …" onChange={(e) => setText(e.target.value)} />
          <div style={{ display: "flex", justifyContent: "space-between" }} className="muted">
            <span>12 or 24 words, separated by spaces</span>
            <span className="mono">{count} / {target}</span>
          </div>
        </div>
        <Callout kind="info">
          Works with seeds from the official Pearl desktop wallet. The first scan checks 250 addresses deep, like
          the desktop wallet does, so it can take a little while.
        </Callout>
        <div className="muted mono" style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderTop: "1px solid var(--divider)", borderBottom: "1px solid var(--divider)" }}>
          <span style={{ fontFamily: "var(--sans)", fontSize: 13, color: "var(--text-2)" }}>Derivation path</span>
          <span>m/86'/{network === "mainnet" ? "808276" : "1"}'/0'</span>
        </div>
        {error && <Callout kind="danger">{error}</Callout>}
        <div className="spacer" />
        <Button disabled={count !== 12 && count !== 24} onClick={submit}>Continue</Button>
      </div>
    </div>
  );
}
