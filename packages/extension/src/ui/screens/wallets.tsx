import { useEffect, useState } from "react";
import { isValidAddress, PEARL_MAINNET, PEARL_TESTNET2 } from "@pearl-wallet/core";
import { WALLET_COLOR_KEYS, type AddWalletArgs, type NetworkId, type WalletColor, type WalletDetails, type WalletSummary } from "../../messages";
import { Button, Callout, Header, Icon, ICONS } from "../components";
import { prl, shortAddr } from "../format";
import { call, RpcError } from "../rpc";

/** The design's wallet colors. Ink follows the text color so it stays visible
 *  on the dark theme. */
export const WALLET_COLOR: Record<WalletColor, string> = {
  teal: "#1f6f6a",
  amber: "#7d4e12",
  red: "#a3352b",
  violet: "#5b4a9c",
  slate: "#5b6272",
  ink: "var(--text)",
};
const COLOR_NAME: Record<WalletColor, string> = { teal: "Teal", amber: "Amber", red: "Red", violet: "Violet", slate: "Slate", ink: "Ink" };

export function WalletDot({ color, size = 34 }: { color: WalletColor; size?: number }) {
  return (
    <span style={{ display: "flex", alignItems: "center", justifyContent: "center", width: size, height: size, borderRadius: size / 2,
      background: WALLET_COLOR[color], color: "var(--bg)", flexShrink: 0 }}>
      <Icon d={ICONS.wallet} size={Math.round(size / 2)} />
    </span>
  );
}

function WalletRow({ w, active, onClick }: { w: WalletSummary; active?: boolean; onClick: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!w.address) return;
    await navigator.clipboard.writeText(w.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  // A row, not a button: the copy control is a button of its own, and one
  // button cannot live inside another.
  return (
    <div className="list-row" style={{ minHeight: 64, cursor: "default", gap: 8 }}>
      <button type="button" onClick={onClick}
        style={{ display: "flex", alignItems: "center", gap: 12, flexGrow: 1, minWidth: 0, padding: 0, border: "none", background: "none", color: "var(--text)", textAlign: "left", cursor: "pointer" }}>
        <WalletDot color={w.color} />
        <span className="main">
          <span style={{ fontSize: 14, fontWeight: 600 }}>{w.name}</span>
          <span className="mono muted" style={{ fontSize: 11.5 }}>{w.address ? shortAddr(w.address, 9, 5) : "not scanned yet"}</span>
        </span>
        <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
          <span className="mono" style={{ fontSize: 12.5 }}>{w.balance !== undefined ? prl(w.balance, 2) : "–"}</span>
          <span className="chip" style={{ background: "var(--surface-2)", color: "var(--text-2)" }}>{w.sourceLabel}</span>
        </span>
      </button>
      {w.address && (
        <button type="button" className="icon-btn" style={{ width: 34, height: 34, flexShrink: 0, color: copied ? "var(--accent)" : "var(--text-3)" }}
          aria-label={`Copy the address for ${w.name}`} title={copied ? "Copied" : "Copy address"} onClick={copy}>
          <Icon d={copied ? ICONS.check : ICONS.copy} size={16} />
        </button>
      )}
      <span style={{ color: active ? "var(--accent)" : "var(--text-3)", display: "flex", flexShrink: 0 }}>
        <Icon d={active ? ICONS.check : ICONS.chevron} size={16} />
      </span>
    </div>
  );
}

/** Dropdown under the home screen's wallet pill: switch, or go manage. */
export function WalletMenu({ wallets, activeId, onPick, onManage, onClose }: {
  wallets: WalletSummary[]; activeId?: string; onPick: (id: string) => void; onManage: () => void; onClose: () => void;
}) {
  return (
    <div role="dialog" aria-label="Switch wallet" onClick={onClose}
      style={{ position: "absolute", inset: 0, zIndex: 10, background: "rgba(10, 12, 16, 0.35)" }}>
      <div className="card" onClick={(e) => e.stopPropagation()}
        style={{ position: "absolute", top: 50, left: 12, right: 12, boxShadow: "0 12px 32px rgba(0,0,0,0.25)", maxHeight: 420, overflowY: "auto" }}>
        {wallets.map((w) => <WalletRow key={w.id} w={w} active={w.id === activeId} onClick={() => onPick(w.id)} />)}
        <button type="button" className="list-row" style={{ minHeight: 48, color: "var(--accent)", fontWeight: 600 }} onClick={onManage}>
          <Icon d={ICONS.settings} /> <span style={{ flexGrow: 1 }}>Manage wallets</span>
        </button>
      </div>
    </div>
  );
}

export function Wallets({ wallets, activeId, onBack, onEdit, onAdd }: {
  wallets: WalletSummary[]; activeId?: string; onBack: () => void; onEdit: (id: string) => void; onAdd: () => void;
}) {
  return (
    <div className="screen">
      <Header title="Wallets" onBack={onBack} />
      <div className="body" style={{ gap: 12, padding: 16 }}>
        <div className="card">
          {wallets.map((w) => <WalletRow key={w.id} w={w} active={w.id === activeId} onClick={() => onEdit(w.id)} />)}
        </div>
        <div className="muted" style={{ display: "flex", gap: 8 }}>
          <Icon d={ICONS.shield} size={14} />
          <span>Wallets made from the same seed phrase share one backup. Tap a wallet to rename it.</span>
        </div>
        <div className="spacer" />
        <Button onClick={onAdd}><Icon d={ICONS.plus} />Add wallet</Button>
      </div>
    </div>
  );
}

type Mode = "next" | "import" | "watch";

const NETS = { mainnet: PEARL_MAINNET, testnet2: PEARL_TESTNET2 };

export function AddWallet({ network, onBack, onAdded }: { network: NetworkId; onBack: () => void; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [mode, setMode] = useState<Mode>("next");
  const [mnemonic, setMnemonic] = useState("");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const words = mnemonic.trim() ? mnemonic.trim().split(/\s+/).length : 0;
  // A watch address is checked here rather than on submit, so the button
  // never invites a click that can only fail.
  const addrTrim = address.trim();
  const addrOk = addrTrim.length > 0 && isValidAddress(addrTrim, NETS[network]);
  const ready =
    name.trim().length > 0 &&
    !busy &&
    (mode === "next" || (mode === "import" && (words === 12 || words === 24)) || (mode === "watch" && addrOk));

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    const m: AddWalletArgs["mode"] =
      mode === "next" ? { kind: "next" } : mode === "import" ? { kind: "import", mnemonic } : { kind: "watch", address };
    try {
      await call({ type: "addWallet", args: { name, mode: m } });
      onAdded();
    } catch (e) {
      setError((e as RpcError).message);
    } finally {
      setBusy(false);
    }
  };

  const option = (id: Mode, title: string, body: string) => (
    <button key={id} type="button" aria-pressed={mode === id} onClick={() => setMode(id)}
      style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 3, padding: 12, minHeight: 64, borderRadius: 12, cursor: "pointer", textAlign: "left",
        border: `1.5px solid ${mode === id ? "var(--accent)" : "var(--border)"}`, background: mode === id ? "var(--accent-soft)" : "var(--surface)" }}>
      <span style={{ fontSize: 14, fontWeight: 600 }}>{title}</span>
      <span style={{ fontSize: 12.5, color: "var(--text-2)" }}>{body}</span>
    </button>
  );

  return (
    <div className="screen">
      <Header title="Add wallet" onBack={onBack} />
      <div className="body" style={{ padding: "16px 20px 18px" }}>
        <div className="field">
          <label htmlFor="newname" className="label">Wallet name</label>
          <div className="input">
            <input id="newname" value={name} maxLength={32} placeholder="For example, Mining rig" autoFocus onChange={(e) => setName(e.target.value)} />
          </div>
        </div>
        <div className="field" style={{ gap: 8 }}>
          <span className="label">How do you want to add it?</span>
          {option("next", "New wallet from my seed", "No new backup needed. Uses the next account in your seed phrase.")}
          {option("import", "Import a seed phrase", "Bring in a wallet from elsewhere. It gets its own backup.")}
          {option("watch", "Watch an address", "Track a balance without keys. Handy for a mining rig.")}
        </div>
        {mode === "import" && (
          <div className="field">
            <label htmlFor="addseed" className="label">Seed phrase</label>
            <textarea id="addseed" className="textarea" style={{ height: 88 }} value={mnemonic} spellCheck={false} autoComplete="off"
              placeholder="12 or 24 words" onChange={(e) => setMnemonic(e.target.value)} />
            <span className="muted">The first scan checks 250 addresses deep, like the desktop wallet.</span>
          </div>
        )}
        {mode === "watch" && (
          <div className="field">
            <label htmlFor="watchaddr" className="label">Address to watch</label>
            <div className="input">
              <input id="watchaddr" className="mono" style={{ fontFamily: "var(--mono)", fontSize: 13 }} value={address} spellCheck={false}
                placeholder="prl1p…" onChange={(e) => setAddress(e.target.value)} />
            </div>
            {addrTrim.length > 0 && (
              <div className="muted" style={{ display: "flex", alignItems: "center", gap: 5, color: addrOk ? "var(--accent)" : "var(--danger-text)" }}>
                <Icon d={addrOk ? ICONS.check : ICONS.warn} size={14} />
                {addrOk ? `Valid ${network === "mainnet" ? "Pearl" : network} address` : "Not an address on this network"}
              </div>
            )}
          </div>
        )}
        {error && <Callout kind="danger">{error}</Callout>}
        <div className="spacer" />
        <Button disabled={!ready} onClick={submit}>{busy ? "Adding…" : mode === "watch" ? "Watch address" : "Create wallet"}</Button>
      </div>
    </div>
  );
}

export function WalletEdit({ id, onBack, onExport, onRemoved }: {
  id: string; onBack: () => void; onExport: (walletId: string) => void; onRemoved: () => void;
}) {
  const [d, setD] = useState<WalletDetails>();
  const [name, setName] = useState("");
  const [color, setColor] = useState<WalletColor>("teal");
  const [xpub, setXpub] = useState<{ xpub: string; path: string }>();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    call({ type: "walletDetails", id }).then((x) => {
      setD(x);
      setName(x.name);
      setColor(x.color);
    }, (e: RpcError) => setError(e.message));
  }, [id]);

  /** The account's public key: it watches, it cannot spend. */
  const showXpub = async () => {
    try {
      setXpub(await call({ type: "exportXpub", walletId: id }));
    } catch (e) {
      setError((e as RpcError).message);
    }
  };

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await call({ type: "updateWallet", id, name, color });
      onBack();
    } catch (e) {
      setError((e as RpcError).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await call({ type: "removeWallet", id, acknowledgeSeedDeletion: ack });
      onRemoved();
    } catch (e) {
      setError((e as RpcError).message);
      setBusy(false);
    }
  };

  if (!d) {
    return (
      <div className="screen">
        <Header title="Edit wallet" onBack={onBack} />
        <div className="body">{error ? <Callout kind="danger">{error}</Callout> : <span className="muted">Loading…</span>}</div>
      </div>
    );
  }

  if (confirmRemove) {
    const funded = d.balance !== undefined && BigInt(d.balance) > 0n;
    return (
      <div className="screen">
        <Header title="Remove wallet" onBack={() => setConfirmRemove(false)} />
        <div className="body">
          <h1 className="title">Remove {d.name}?</h1>
          {d.kind === "watch" ? (
            <p className="lead">Oyster stops following this address. Nothing on the network changes.</p>
          ) : d.removesSeed ? (
            <>
              <Callout kind="danger">
                This is the last wallet using {d.sourceLabel.replace("seed", "Seed")}. Removing it deletes that seed phrase from this
                device. Without your written copy, anything on it is gone for good.
              </Callout>
              {funded && (
                <Callout kind="warn">This wallet holds {prl(d.balance!)} PRL right now.</Callout>
              )}
              <label htmlFor="rmack" style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 12.5, color: "var(--text-2)", minHeight: 44 }}>
                <input id="rmack" type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)}
                  style={{ width: 18, height: 18, margin: "1px 0 0", accentColor: "var(--danger-text)", flexShrink: 0 }} />
                <span>I have this wallet's seed phrase written down, and I can restore it later.</span>
              </label>
            </>
          ) : (
            <p className="lead">
              Its seed phrase stays on this device, because other wallets use it. You can add this account back any time
              with "New wallet from my seed".
            </p>
          )}
          {error && <Callout kind="danger">{error}</Callout>}
          <div className="spacer" />
          <button type="button" className="btn" disabled={busy || (d.removesSeed && !ack)} onClick={remove}
            style={{ background: "var(--danger-text)", color: "#ffffff", borderColor: "var(--danger-text)" }}>
            {busy ? "Removing…" : "Remove from Oyster"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      <Header title="Edit wallet" onBack={onBack} />
      <div className="body" style={{ gap: 12, padding: "16px 20px 18px" }}>
        <div className="field">
          <label htmlFor="wname" className="label">Wallet name</label>
          <div className="input"><input id="wname" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} /></div>
        </div>
        <div className="field">
          <span className="label">Color</span>
          <div style={{ display: "flex", gap: 6, justifyContent: "space-between" }} role="radiogroup" aria-label="Color">
            {WALLET_COLOR_KEYS.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={COLOR_NAME[c]} onClick={() => setColor(c)}
                style={{ width: 44, height: 44, borderRadius: 22, border: `2px solid ${color === c ? "var(--text)" : "transparent"}`, background: "transparent", padding: 3, cursor: "pointer" }}>
                <span style={{ display: "block", width: "100%", height: "100%", borderRadius: "50%", background: WALLET_COLOR[c] }} />
              </button>
            ))}
          </div>
        </div>
        <div className="kv">
          <div><span className="k">Address</span><span className="v">{shortAddr(d.address, 9, 5)}</span></div>
          {d.path && <div><span className="k">Path</span><span className="v">{d.path}</span></div>}
          <div><span className="k">Source</span><span className="v" style={{ fontFamily: "var(--sans)" }}>{d.kind === "watch" ? "Watch only" : d.sourceLabel.replace("seed", "Seed")}</span></div>
        </div>
        <div className="card">
          {d.kind === "seed" && (
            <button type="button" className="list-row" style={{ minHeight: 46 }} onClick={() => onExport(d.id)}>
              <Icon d={ICONS.key} /><span style={{ flexGrow: 1 }}>Export seed phrase</span>
              <span style={{ color: "var(--text-3)", display: "flex" }}><Icon d={ICONS.chevron} size={16} /></span>
            </button>
          )}
          {d.kind === "seed" && !xpub && (
            <button type="button" className="list-row" style={{ minHeight: 46 }} onClick={() => void showXpub()}>
              <span style={{ color: "var(--text-2)", display: "flex" }}><Icon d={ICONS.key} /></span>
              <span style={{ flexGrow: 1, fontSize: 14 }}>Account public key</span>
              <span style={{ color: "var(--text-3)", display: "flex" }}><Icon d={ICONS.chevron} size={16} /></span>
            </button>
          )}
          {xpub && (
            <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="label">Account public key, {xpub.path}</span>
              <span className="mono" style={{ fontSize: 11.5, wordBreak: "break-all", lineHeight: 1.5, userSelect: "all", color: "var(--text-2)" }}>{xpub.xpub}</span>
              <span className="muted">Shows every address this wallet uses, and cannot spend from any of them. Share it only with something you want watching you.</span>
            </div>
          )}
          <button type="button" className="list-row" style={{ minHeight: 46, color: "var(--danger-text)" }} disabled={d.isOnly}
            title={d.isOnly ? "The only wallet cannot be removed" : undefined} onClick={() => setConfirmRemove(true)}>
            <Icon d={ICONS.trash} /><span style={{ flexGrow: 1 }}>Remove from Oyster</span>
            <span style={{ color: "var(--text-3)", display: "flex" }}><Icon d={ICONS.chevron} size={16} /></span>
          </button>
        </div>
        {error && <Callout kind="danger">{error}</Callout>}
        <div className="spacer" />
        <Button disabled={busy || !name.trim()} onClick={save}>{busy ? "Saving…" : "Save"}</Button>
      </div>
    </div>
  );
}
