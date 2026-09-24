import { useEffect, useState } from "react";
import { AUTO_LOCK_CHOICES, type ConnectedSite, type Contact, type NetworkId, type ProtectedCoin, type Theme, type UiMode } from "../../messages";
import { Button, Callout, Header, Icon, ICONS, PasswordInput, TabBar, Toggle, type Tab } from "../components";
import { prlExact, shortTxid } from "../format";
import { call, RpcError } from "../rpc";

function Row({ icon, label, value, onClick }: { icon: string; label: string; value?: string; onClick?: () => void }) {
  return (
    <button type="button" className="list-row" style={{ minHeight: 44 }} onClick={onClick} disabled={!onClick}>
      <span style={{ color: "var(--text-2)", display: "flex" }}><Icon d={icon} /></span>
      <span style={{ flexGrow: 1, fontSize: 14 }}>{label}</span>
      {value && <span className="mono muted" style={{ fontSize: 12.5 }}>{value}</span>}
      {onClick && <span style={{ color: "var(--text-3)", display: "flex" }}><Icon d={ICONS.chevron} size={16} /></span>}
    </button>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span className="eyebrow" style={{ fontSize: 10.5, letterSpacing: "0.1em", padding: "0 4px" }}>{title}</span>
      <div className="card">{children}</div>
    </div>
  );
}

const THEME_LABEL: Record<Theme, string> = { system: "System", light: "Light", dark: "Dark" };

export function Settings({
  network, protectedCount, autoLockMinutes, theme, walletCount, onTab, onNetwork, onProtected, onExport, onLock,
  onAutoLock, onTheme, onChangePassword, onWallets, minerMode, onMining, siteCount, onSites,
  uiMode, sidePanelSupported, onUiMode, canExportSeed, onBackup, onRestore, onBook, relayLabel, onRelay,
}: {
  network: NetworkId; protectedCount?: number; autoLockMinutes: number; theme: Theme;
  onTab: (t: Tab) => void; onNetwork: (n: NetworkId) => void;
  onProtected: () => void; onExport: () => void; onLock: () => void;
  onAutoLock: () => void; onTheme: () => void; onChangePassword: () => void;
  uiMode: UiMode; sidePanelSupported: boolean; onUiMode: (m: UiMode) => void;
  /** Watch-only wallets have no seed to export, so the row is not offered. */
  canExportSeed: boolean;
  onBackup: () => void; onRestore: () => void; onBook: () => void;
  relayLabel: string; onRelay: () => void;
  walletCount: number; onWallets: () => void;
  minerMode: boolean; onMining: () => void;
  siteCount?: number; onSites: () => void;
}) {
  return (
    <div className="screen" style={{ background: "var(--surface-2)" }}>
      <div style={{ display: "flex", alignItems: "center", height: 52, padding: "0 16px", flexShrink: 0 }}>
        <div style={{ fontFamily: "var(--serif)", fontSize: 24, fontWeight: 500 }}>Settings</div>
      </div>
      <div className="body" style={{ gap: 9, padding: "0 16px 8px" }}>
        <Group title="General">
          <Row icon={ICONS.moon} label="Appearance" value={THEME_LABEL[theme]} onClick={onTheme} />
          <Row icon={ICONS.clock} label="Auto-lock" value={`${autoLockMinutes} min`} onClick={onAutoLock} />
          <Row icon={ICONS.snow} label="Data server" value={relayLabel} onClick={onRelay} />
          <Row icon={ICONS.globe} label="Network" value={network}
            onClick={() => onNetwork(network === "mainnet" ? "testnet2" : "mainnet")} />
          {sidePanelSupported && (
            <Row icon={ICONS.chevron} label="Open as" value={uiMode === "sidepanel" ? "Side panel" : "Popup"}
              onClick={() => onUiMode(uiMode === "sidepanel" ? "popup" : "sidepanel")} />
          )}
          <Row icon={ICONS.wallet} label="Manage wallets" value={String(walletCount)} onClick={onWallets} />
          <Row icon={ICONS.send} label="Address book" onClick={onBook} />
        </Group>
        <Group title="Coins and mining">
          <Row icon={ICONS.chip} label="Miner mode" value={minerMode ? "on" : "off"} onClick={onMining} />
          <Row icon={ICONS.snow} label="Protected coins" value={protectedCount === undefined ? "" : String(protectedCount)} onClick={onProtected} />
        </Group>
        <Group title="Security">
          <Row icon={ICONS.shield} label="Connected sites" value={siteCount === undefined ? "" : String(siteCount)} onClick={onSites} />
          <Row icon={ICONS.key} label="Change password" onClick={onChangePassword} />
          <Row icon={ICONS.copy} label="Back up wallet file" onClick={onBackup} />
          <Row icon={ICONS.paste} label="Restore from a backup" onClick={onRestore} />
          {canExportSeed ? (
            <Row icon={ICONS.eye} label="Export seed phrase" onClick={onExport} />
          ) : (
            <Row icon={ICONS.eye} label="Export seed phrase" value="watch-only wallet" />
          )}
        </Group>
        <div className="spacer" />
        <Button onClick={onLock}><Icon d={ICONS.lock} size={17} />Lock wallet</Button>
      </div>
      <TabBar active="settings" onTab={onTab} />
    </div>
  );
}

export function ProtectedCoins({ onBack }: { onBack: () => void }) {
  const [coins, setCoins] = useState<ProtectedCoin[]>();
  const [error, setError] = useState<string>();

  const run = (p: Promise<ProtectedCoin[]>) => p.then(setCoins, (e: RpcError) => setError(e.message));
  useEffect(() => void run(call({ type: "protectedCoins" })), []);

  const rescan = async () => {
    setCoins(undefined);
    try {
      await call({ type: "walletView", refresh: true });
      await run(call({ type: "protectedCoins" }));
    } catch (e) {
      setError((e as RpcError).message);
    }
  };

  return (
    <div className="screen">
      <Header title="Protected coins" onBack={onBack} />
      <div className="body">
        <p className="lead">These outputs may carry PRC-20 tokens or inscriptions. Oyster never spends them on its own.</p>
        {!coins ? (
          <span className="muted">Loading…</span>
        ) : coins.length === 0 ? (
          <Callout kind="info" icon={ICONS.shield}>No small outputs in this wallet. Nothing needs protecting.</Callout>
        ) : (
          <div className="card">
            {coins.map((c) => {
              const [txid, vout] = c.outpoint.split(":");
              return (
                <div key={c.outpoint} className="list-row" style={{ minHeight: 64, cursor: "default" }}>
                  <div className="main" style={{ gap: 3 }}>
                    <span className="mono" style={{ fontSize: 12.5 }}>{shortTxid(txid!)} : {vout}</span>
                    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span className="mono muted" style={{ fontSize: 11.5 }}>{prlExact(c.value)} PRL</span>
                      <span className="chip warn">{c.reason === "inscription" ? "inscription" : "small output"}</span>
                    </span>
                  </div>
                  <Toggle on={c.frozen} label="Keep frozen"
                    onChange={(v) => void run(call({ type: "setFrozen", outpoint: c.outpoint, frozen: v }))} />
                </div>
              );
            })}
          </div>
        )}
        <Callout kind="danger">Unfreezing lets a normal send spend this output. Any token attached to it is destroyed for good.</Callout>
        {error && <Callout kind="danger">{error}</Callout>}
        <div className="spacer" />
        <Button variant="secondary" onClick={rescan}><Icon d={ICONS.snow} />Scan wallet again</Button>
      </div>
    </div>
  );
}

export function ExportSeed({ walletId, onBack }: { walletId?: string; onBack: () => void }) {
  const [pw, setPw] = useState("");
  const [mnemonic, setMnemonic] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const reveal = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setMnemonic((await call({ type: "exportSeed", password: pw, ...(walletId ? { walletId } : {}) })).mnemonic);
      setPw("");
    } catch (e) {
      setError((e as RpcError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen">
      <Header title="Export seed phrase" onBack={onBack} />
      <div className="body">
        <Callout kind="warn">
          Anyone who sees these words can take everything in this wallet. Check nobody is watching your screen,
          and never paste them into a website or send them to support.
        </Callout>
        {!mnemonic ? (
          <>
            <div className="field">
              <label htmlFor="exportpw" className="label">Enter your password to show it</label>
              <PasswordInput id="exportpw" value={pw} onChange={setPw} autoFocus onEnter={() => pw && void reveal()} />
            </div>
            {error && <Callout kind="danger">{error}</Callout>}
            <div className="spacer" />
            <Button disabled={!pw || busy} onClick={reveal}>{busy ? "Checking…" : "Show seed phrase"}</Button>
          </>
        ) : (
          <>
            <ol style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 6, margin: 0, padding: 0, listStyle: "none" }}>
              {mnemonic.split(" ").map((w, i) => (
                <li key={i} style={{ display: "flex", alignItems: "center", gap: 8, height: 38, padding: "0 10px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--surface)" }}>
                  <span className="mono" style={{ fontSize: 11, color: "var(--text-3)", width: 16 }}>{i + 1}</span>
                  <span className="mono" style={{ fontSize: 13 }}>{w}</span>
                </li>
              ))}
            </ol>
            <div className="spacer" />
            <Button onClick={onBack}>Done, hide it</Button>
          </>
        )}
      </div>
    </div>
  );
}

/** One-choice list: appearance and auto-lock. */
export function Picker<T extends string | number>({
  title, note, options, value, label, onPick, onBack,
}: {
  title: string; note?: string; options: readonly T[]; value: T; label: (v: T) => string;
  onPick: (v: T) => void; onBack: () => void;
}) {
  return (
    <div className="screen">
      <Header title={title} onBack={onBack} />
      <div className="body">
        {note && <p className="lead">{note}</p>}
        <div className="card" role="radiogroup" aria-label={title}>
          {options.map((o) => (
            <button key={String(o)} type="button" role="radio" aria-checked={o === value} className="list-row" style={{ minHeight: 48 }}
              onClick={() => onPick(o)}>
              <span style={{ flexGrow: 1, fontSize: 14 }}>{label(o)}</span>
              {o === value && <span style={{ color: "var(--accent)", display: "flex" }}><Icon d={ICONS.check} /></span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export const AUTO_LOCK_OPTIONS = AUTO_LOCK_CHOICES;
export const THEMES: readonly Theme[] = ["system", "light", "dark"];
export const themeLabel = (t: Theme) => THEME_LABEL[t];

export function ChangePassword({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const [oldPw, setOld] = useState("");
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const ok = oldPw.length > 0 && pw1.length >= 8 && pw1 === pw2 && !busy;

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await call({ type: "changePassword", oldPassword: oldPw, newPassword: pw1 });
      onDone();
    } catch (e) {
      setError((e as RpcError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen">
      <Header title="Change password" onBack={onBack} />
      <div className="body">
        <p className="lead">Your seed phrase does not change. Only the password that unlocks this device does.</p>
        <div className="field">
          <label htmlFor="oldpw" className="label">Current password</label>
          <PasswordInput id="oldpw" value={oldPw} onChange={setOld} autoFocus />
        </div>
        <div className="field">
          <label htmlFor="newpw1" className="label">New password</label>
          <PasswordInput id="newpw1" value={pw1} onChange={setPw1} />
          {pw1.length > 0 && pw1.length < 8 && <span className="muted">At least 8 characters</span>}
        </div>
        <div className="field">
          <label htmlFor="newpw2" className="label">Confirm new password</label>
          <PasswordInput id="newpw2" value={pw2} onChange={setPw2} onEnter={() => ok && void submit()} />
          {pw2.length > 0 && pw1 !== pw2 && <span className="error-text">Passwords do not match.</span>}
        </div>
        {error && <Callout kind="danger">{error}</Callout>}
        <div className="spacer" />
        <Button disabled={!ok} onClick={submit}>{busy ? "Re-encrypting…" : "Change password"}</Button>
      </div>
    </div>
  );
}

export function ConnectedSites({ onBack }: { onBack: () => void }) {
  const [sites, setSites] = useState<ConnectedSite[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    call({ type: "listSites" }).then(setSites, (e: RpcError) => setError(e.message));
  }, []);
  const disconnect = async (origin: string) => {
    try {
      setSites(await call({ type: "disconnectSite", origin }));
    } catch (e) {
      setError((e as RpcError).message);
    }
  };
  return (
    <div className="screen">
      <Header title="Connected sites" onBack={onBack} />
      <div className="body">
        <p className="lead">These sites can see your address and balance, and ask you to approve payments or sign messages. They can never move funds on their own.</p>
        {!sites ? (
          <span className="muted">Loading…</span>
        ) : sites.length === 0 ? (
          <Callout kind="info" icon={ICONS.shield}>No sites are connected.</Callout>
        ) : (
          <div className="card">
            {sites.map((s) => (
              <div key={s.origin} className="list-row" style={{ minHeight: 56, cursor: "default" }}>
                <span style={{ display: "flex", color: "var(--text-2)" }}><Icon d={ICONS.globe} /></span>
                <span className="main">
                  <span className="mono" style={{ fontSize: 12.5, wordBreak: "break-all" }}>{s.origin}</span>
                  <span className="s">Connected {new Date(s.connectedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                </span>
                <button type="button" className="btn btn-secondary" style={{ width: "auto", height: 34, padding: "0 10px", fontSize: 12.5 }}
                  onClick={() => disconnect(s.origin)}>Disconnect</button>
              </div>
            ))}
          </div>
        )}
        {error && <Callout kind="danger">{error}</Callout>}
      </div>
    </div>
  );
}


/** Saves text as a file from an extension page. Downloads started by a page
 *  are blocked in some contexts, so failure is reported rather than assumed
 *  away: the text is offered for copying instead. */
function saveFile(name: string, text: string): boolean {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return true;
  } catch {
    return false;
  }
}

/**
 * A backup file restores the whole wallet, which a seed phrase alone does
 * not: extra seeds, watch-only wallets, names, colours, the addresses you
 * watch for wPRL. The vault inside stays encrypted with the password.
 */
export function BackupWallet({ onBack }: { onBack: () => void }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [text, setText] = useState<string>();

  const run = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const { file, name } = await call({ type: "exportBackup", password: pw });
      setSaved(saveFile(name, file));
      setText(file);
      setPw("");
    } catch (e) {
      setError((e as RpcError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen">
      <Header title="Back up this wallet" onBack={onBack} />
      <div className="body">
        <p className="lead">
          One file that brings this wallet back: every seed in it, the watch-only wallets, the names and colours, and
          what each wallet watches. Your seed phrase alone restores none of that.
        </p>
        <Callout kind="info" icon={ICONS.shield}>
          The wallet inside the file stays encrypted with this password. A few settings sit in the clear, so keep the
          file somewhere private anyway.
        </Callout>
        {text ? (
          <>
            <Callout kind={saved ? "info" : "warn"} icon={saved ? ICONS.check : ICONS.warn}>
              {saved
                ? "Saved to your downloads. Keep it somewhere you will still have it if this computer stops working."
                : "The browser would not save the file here. Copy the text below into a file yourself."}
            </Callout>
            {!saved && (
              <textarea className="textarea mono" readOnly value={text} onFocus={(e) => e.currentTarget.select()} />
            )}
            <Button onClick={onBack}>Done</Button>
          </>
        ) : (
          <>
            <div className="field">
              <label htmlFor="backuppw" className="label">Your password</label>
              <PasswordInput id="backuppw" value={pw} onChange={setPw} autoFocus onEnter={() => pw && void run()} />
            </div>
            {error && <Callout kind="danger">{error}</Callout>}
            <div className="spacer" />
            <Button disabled={!pw || busy} onClick={run}>{busy ? "Preparing\u2026" : "Save backup file"}</Button>
          </>
        )}
      </div>
    </div>
  );
}

/** Restoring replaces whatever is on this device, so it asks twice. */
export function RestoreWallet({ onBack, onRestored }: { onBack: () => void; onRestored: () => void }) {
  const [file, setFile] = useState<{ name: string; text: string }>();
  const [pw, setPw] = useState("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const pick = async (f: File | undefined) => {
    setError(undefined);
    if (!f) return;
    try {
      setFile({ name: f.name, text: await f.text() });
    } catch {
      setError("That file could not be read.");
    }
  };

  const run = async () => {
    if (!file) return;
    setBusy(true);
    setError(undefined);
    try {
      await call({ type: "importBackup", file: file.text, password: pw });
      onRestored();
    } catch (e) {
      setError((e as RpcError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen">
      <Header title="Restore from a backup" onBack={onBack} />
      <div className="body">
        <Callout kind="warn">
          This replaces the wallet on this device with the one in the file. Anything here that is not in the file, and
          not written down elsewhere, is gone.
        </Callout>
        <div className="field">
          <span className="label">Backup file</span>
          <input id="backupfile" type="file" accept="application/json,.json"
            onChange={(e) => void pick(e.target.files?.[0])}
            style={{ fontSize: 13, padding: 10, border: "1px solid var(--border)", borderRadius: 10, background: "var(--surface)" }} />
          {file && <span className="muted">{file.name}, {Math.ceil(file.text.length / 1024)} KB</span>}
        </div>
        <div className="field">
          <label htmlFor="restorepw" className="label">The password that file was made with</label>
          <PasswordInput id="restorepw" value={pw} onChange={setPw} onEnter={() => ack && pw && void run()} />
        </div>
        <label htmlFor="rsack" style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 12.5, color: "var(--text-2)", minHeight: 44 }}>
          <input id="rsack" type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)}
            style={{ width: 18, height: 18, margin: "1px 0 0", accentColor: "var(--danger-text)", flexShrink: 0 }} />
          I understand this replaces the wallet currently on this device.
        </label>
        {error && <Callout kind="danger">{error}</Callout>}
        <div className="spacer" />
        <Button disabled={!file || !pw || !ack || busy} onClick={run}
          style={{ background: "var(--danger-text)", color: "#ffffff", borderColor: "var(--danger-text)" }}>
          {busy ? "Restoring\u2026" : "Replace and restore"}
        </Button>
      </div>
    </div>
  );
}


/** Everywhere this wallet has paid, and the names given to them. A name is
 *  the only defence against an address that looks almost right. */
export function AddressBook({ onBack }: { onBack: () => void }) {
  const [book, setBook] = useState<Contact[]>();
  const [editing, setEditing] = useState<string>();
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string>();

  useEffect(() => {
    call({ type: "addressBook" }).then(setBook, (e: RpcError) => setError(e.message));
  }, []);

  const save = async (address: string) => {
    try {
      setBook(await call({ type: "saveContact", address, label }));
      setEditing(undefined);
      setLabel("");
    } catch (e) {
      setError((e as RpcError).message);
    }
  };

  const forget = async (address: string) => {
    try {
      setBook(await call({ type: "forgetContact", address }));
    } catch (e) {
      setError((e as RpcError).message);
    }
  };

  return (
    <div className="screen">
      <Header title="Address book" onBack={onBack} />
      <div className="body" style={{ gap: 10 }}>
        {!book ? (
          <span className="muted">Loading\u2026</span>
        ) : book.length === 0 ? (
          <div style={{ flexGrow: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, textAlign: "center" }}>
            <span className="dot-icon" style={{ width: 52, height: 52, borderRadius: 26 }}><Icon d={ICONS.send} size={24} /></span>
            <div style={{ fontFamily: "var(--serif)", fontSize: 22 }}>Nobody yet</div>
            <p className="lead" style={{ maxWidth: 250 }}>Addresses you pay show up here, so you never have to paste the same one twice.</p>
          </div>
        ) : (
          book.map((c) => (
            <div key={c.address} style={{ padding: 12, border: "1px solid var(--border)", borderRadius: 12, background: "var(--surface)", display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                <span style={{ fontSize: 13.5, fontWeight: 600 }}>{c.label ?? "No name"}</span>
                <span className="muted">{c.count === 0 ? "saved" : `${c.count} payment${c.count === 1 ? "" : "s"}`}</span>
              </div>
              <span className="mono" style={{ fontSize: 12, wordBreak: "break-all", lineHeight: 1.5, color: "var(--text-2)" }}>{c.address}</span>
              {editing === c.address ? (
                <div style={{ display: "flex", gap: 8 }}>
                  <div className="input" style={{ flexGrow: 1 }}>
                    <input value={label} maxLength={40} autoFocus placeholder="A name you will recognise"
                      onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save(c.address)} />
                  </div>
                  <Button variant="secondary" style={{ width: "auto", padding: "0 14px", height: 46 }} onClick={() => void save(c.address)}>Save</Button>
                </div>
              ) : (
                <div className="row-2">
                  <Button variant="secondary" style={{ height: 40, fontSize: 13 }}
                    onClick={() => { setEditing(c.address); setLabel(c.label ?? ""); }}>
                    {c.label ? "Rename" : "Give it a name"}
                  </Button>
                  <Button variant="ghost" style={{ height: 40, fontSize: 13, color: "var(--danger-text)" }} onClick={() => void forget(c.address)}>
                    Forget
                  </Button>
                </div>
              )}
            </div>
          ))
        )}
        {error && <Callout kind="danger">{error}</Callout>}
      </div>
    </div>
  );
}


/**
 * Where the wallet reads prices, charts and market data from.
 *
 * Worth being able to change without a new build: the server moves, and
 * anyone running their own relay should not have to take ours on trust. It
 * has to be https, because a price is a number this wallet will show as
 * fact, and plain http is a number anyone on the path can choose.
 */
export function RelayServer({ current, hasOperatorKey, onBack, onSaved, onOperatorKey }: {
  current: string;
  /** Whether a key is stored. The key itself never comes back out of the
   *  background, so there is nothing here to leak into a message log. */
  hasOperatorKey: boolean;
  onBack: () => void;
  onSaved: (url: string) => Promise<void>;
  onOperatorKey: (secret: string) => Promise<void>;
}) {
  const [url, setUrl] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [checked, setChecked] = useState<string>();
  const [key, setKey] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyNote, setKeyNote] = useState<string>();

  const saveKey = async (secret: string) => {
    setKeyBusy(true);
    setError(undefined);
    setKeyNote(undefined);
    try {
      await onOperatorKey(secret);
      setKey("");
      setKeyNote(secret ? "Saved. This wallet can now reach the exchange account." : "Removed.");
    } catch (e) {
      setError((e as RpcError).message);
    } finally {
      setKeyBusy(false);
    }
  };

  const trimmed = url.trim().replace(/\/+$/, "");
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(trimmed);
  const looksOk = /^https:\/\/[^\s]+$/.test(trimmed) || local;

  const save = async () => {
    setBusy(true);
    setError(undefined);
    setChecked(undefined);
    try {
      await onSaved(trimmed);
      setChecked("Saved. Prices and charts now come from here.");
    } catch (e) {
      setError((e as RpcError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen">
      <Header title="Data server" onBack={onBack} />
      <div className="body">
        <p className="lead" style={{ margin: 0 }}>
          Prices, charts and market data come from here. Your keys never do: this server never sees them, and cannot
          move anything.
        </p>
        <div className="field">
          <label htmlFor="relayurl" className="label">Address</label>
          <div className="input">
            <input id="relayurl" value={url} spellCheck={false} autoCapitalize="off"
              className="mono" style={{ fontSize: 12.5 }}
              onChange={(e) => { setUrl(e.target.value); setChecked(undefined); }} />
          </div>
          {!looksOk && url.trim().length > 0 && (
            <span className="error-text">It has to start with https, or be localhost while you are working on it.</span>
          )}
        </div>
        {error && <Callout kind="danger">{error}</Callout>}
        {checked && <Callout kind="info" icon={ICONS.check}>{checked}</Callout>}
        {local && (
          <Callout kind="warn">
            A plain http address is only safe on this machine. Anywhere else, anyone on the path can choose the price
            you see.
          </Callout>
        )}
        <Button disabled={!looksOk || busy || trimmed === current} onClick={save}>
          {busy ? "Saving\u2026" : "Use this server"}
        </Button>

        <div style={{ height: 1, background: "var(--divider)", margin: "6px 0" }} />

        <div className="field">
          <label htmlFor="opkey" className="label">Operator key</label>
          <p className="muted" style={{ fontSize: 11.5, margin: "0 0 6px" }}>
            Only needed to run the exchange account behind this relay. Leave it empty: an ordinary wallet has no use
            for one, and does not need one to see prices, charts or the order book.
          </p>
          <div className="input">
            <input id="opkey" type="password" value={key} spellCheck={false} autoCapitalize="off"
              placeholder={hasOperatorKey ? "A key is set" : "Not set"}
              className="mono" style={{ fontSize: 12.5 }}
              onChange={(e) => { setKey(e.target.value); setKeyNote(undefined); }} />
          </div>
        </div>
        {keyNote && <Callout kind="info" icon={ICONS.check}>{keyNote}</Callout>}
        <div style={{ display: "flex", gap: 8 }}>
          <Button variant="secondary" disabled={key.trim().length === 0 || keyBusy} onClick={() => void saveKey(key.trim())}>
            {keyBusy ? "Saving\u2026" : "Save key"}
          </Button>
          {hasOperatorKey && (
            <Button variant="ghost" disabled={keyBusy} style={{ color: "var(--danger-text)" }} onClick={() => void saveKey("")}>
              Remove
            </Button>
          )}
        </div>
        <div className="spacer" />
      </div>
    </div>
  );
}
