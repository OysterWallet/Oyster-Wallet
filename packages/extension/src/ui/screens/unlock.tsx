import { useState } from "react";
import { BRAND, Button, Callout, Icon, ICONS, Logo, PasswordInput } from "../components";

/** "after 15 minutes idle", or whatever the owner actually chose. */
export function idleLabel(minutes: number): string {
  if (minutes === 60) return "Locks itself after an hour idle";
  if (minutes === 1) return "Locks itself after a minute idle";
  return `Locks itself after ${minutes} minutes idle`;
}

export function Unlock({
  fresh,
  busy,
  error,
  autoLockMinutes,
  onUnlock,
  onForgot,
}: {
  /** Right after setup: the design's "Your wallet is ready" variant. */
  fresh?: boolean;
  busy?: boolean;
  error?: string;
  /** The chosen auto-lock, so the line below matches the setting. */
  autoLockMinutes?: number;
  onUnlock: (password: string) => void;
  onForgot?: () => void;
}) {
  const [pw, setPw] = useState("");
  const submit = () => pw && !busy && onUnlock(pw);

  return (
    <div className="screen">
      <div className="body" style={{ gap: 16, padding: "28px 24px 20px" }}>
        <div className="spacer" />
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: fresh ? 12 : 14, textAlign: "center" }}>
          <Logo size={60} />
          {fresh && <span className="chip info">wallet created</span>}
          <h1 className="title" style={{ fontSize: 28 }}>{fresh ? "Your wallet is ready" : "Welcome back"}</h1>
          {fresh && <p className="lead">Enter the password you just set to open it.</p>}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 12 }}>
          <div className="field">
            <label htmlFor="unlockpw" className="label">Password</label>
            <PasswordInput id="unlockpw" value={pw} onChange={setPw} placeholder="Enter your password" autoFocus onEnter={submit} />
          </div>
          {error && <Callout kind="danger">{error}</Callout>}
          <Button disabled={!pw || busy} onClick={submit}>
            <Icon d={ICONS.lock} />
            {busy ? "Unlocking…" : fresh ? "Open wallet" : "Unlock"}
          </Button>
        </div>
        {!fresh && onForgot && (
          <button type="button" className="btn btn-ghost" style={{ fontSize: 13, fontWeight: 500 }} onClick={onForgot}>
            Forgot password? Restore from seed phrase
          </button>
        )}
        <div className="spacer" />
        <div className="muted" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
          <Icon d={fresh ? ICONS.shield : ICONS.clock} size={15} />
          {fresh ? `${BRAND} asks for this every time it locks` : idleLabel(autoLockMinutes ?? 15)}
        </div>
      </div>
    </div>
  );
}

export function Loading({ label = "Opening your wallet" }: { label?: string }) {
  return (
    <div className="screen" aria-busy="true" aria-label={label}>
      <div style={{ flexGrow: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20 }}>
        <Logo size={132} />
        <div data-anim style={{ fontFamily: "var(--serif)", fontSize: 34, lineHeight: 1, letterSpacing: "-0.02em", animation: "oy-word 1.6s ease-out both" }}>
          {BRAND}
        </div>
        <div data-anim style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, animation: "oy-word 1.9s ease-out both" }}>
          <div style={{ width: 120, height: 3, borderRadius: 2, background: "var(--border)", overflow: "hidden" }}>
            <div data-anim style={{ width: "40%", height: 3, borderRadius: 2, background: "var(--accent)", animation: "oy-bar 1.3s ease-in-out infinite" }} />
          </div>
          <span className="muted" style={{ fontSize: 12.5 }}>{label}</span>
        </div>
      </div>
    </div>
  );
}
