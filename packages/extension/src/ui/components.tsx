import { useState, type ReactNode } from "react";

/** Product name, per the design. Pearl also uses "oyster" for its wallet
 *  daemon; decided 2026-09-19 to use it public-facing anyway. */
export const BRAND = "Oyster";

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

/** Icon paths from the design canvas. */
export const ICONS = {
  back: "M15 5l-7 7 7 7",
  chevron: "M9 5l7 7-7 7",
  down: "M6 9l6 6 6-6",
  lock: "M7 11V8a5 5 0 0110 0v3M6 11h12v9H6z",
  warn: "M12 4l9 16H3zM12 10v4M12 17v.5",
  check: "M5 12.5l4.5 4.5L19 7.5",
  shield: "M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z",
  copy: "M9 9h10v11H9zM5 15V4h10",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  send: "M7 17L17 7M9 7h8v8",
  receive: "M17 7L7 17M15 17H7V9",
  clock: "M12 7v5l3 2M12 3a9 9 0 100 18 9 9 0 000-18z",
  wallet: "M4 7h14a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2V7zM4 7V6a2 2 0 012-2h10M16 13h2",
  // The design's note-and-coin, for cash.
  cash: "M3 7h18v10H3zM12 10a2 2 0 100 4 2 2 0 000-4zM6 10v4M18 10v4",
  trade: "M7 7h11l-3-3M17 17H6l3 3",
  activity: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
  settings: "M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4",
  paste: "M9 4h6v3H9zM7 5H5v15h14V5h-2",
  key: "M15 4a5 5 0 11-4.6 7H8v3H5v3H3v-3l5.4-5.4A5 5 0 0115 4zM16 8h.01",
  external: "M14 5h5v5M19 5l-8 8M11 7H6v11h11v-5",
  globe: "M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18",
  snow: "M12 3v18M4.5 7.5l15 9M19.5 7.5l-15 9",
  refresh: "M20 11a8 8 0 10-2.3 5.7M20 5v6h-6",
  chip: "M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4",
  moon: "M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z",
  trash: "M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13",
  eye: "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 9.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5z",
  eyeOff: "M4 4l16 16M9.9 5.9A9 9 0 0112 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 01-3.2 4M6.5 8A17 17 0 002.5 12S6 18.5 12 18.5c1.2 0 2.3-.2 3.3-.6M10.2 10.2a2.5 2.5 0 003.5 3.5",
} as const;

export function Icon({ d, size = 18 }: { d: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" style={{ ...stroke, flexShrink: 0 }}>
      <path d={d} />
    </svg>
  );
}

export function Logo({ size = 76 }: { size?: number }) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M5 25c2 17 36 17 38 0" style={{ fill: "none", stroke: "var(--text)", strokeWidth: 2.2, strokeLinecap: "round" }} />
      <circle cx="24" cy="20" r="12" style={{ fill: "var(--bg)", stroke: "var(--text)", strokeWidth: 2 }} />
      <path d="M17 18.5a7.5 7.5 0 016-5.5" style={{ fill: "none", stroke: "var(--accent)", strokeWidth: 2.4, strokeLinecap: "round" }} />
    </svg>
  );
}

/** Pearl's own mark, as the coin is branded. Drawn on its white disc in both
 *  themes, the way a coin list shows any token's logo. */
export function PrlMark({ size = 34 }: { size?: number }) {
  return (
    <img src="/coin/prl.png" alt="" className="prl-mark" width={size} height={size} draggable={false}
      style={{ display: "block", borderRadius: size / 2, background: "#ffffff", flexShrink: 0 }} />
  );
}

/** The Ethereum diamond, filled rather than stroked like the ICONS set. Used
 *  as a badge on wrapped PRL to say which chain it lives on. */
export function EthMark({ size = 10 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" style={{ display: "block", flexShrink: 0 }}>
      <path d="M12 1.5 5.3 12.2 12 16.2l6.7-4z" fill="currentColor" />
      <path d="M5.3 13.6 12 22.5l6.7-8.9-6.7 4z" fill="currentColor" opacity="0.65" />
    </svg>
  );
}


/** Tether's mark: the bar and stem of a T crossing an oval, on its green. */
export function UsdtMark({ size = 34 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" style={{ display: "block", flexShrink: 0 }}>
      <circle cx="12" cy="12" r="12" fill="#26a17b" />
      {/* The T, its stem crossing an oval, as one path: the oval is the hole,
          so it stays crisp at badge sizes instead of doubling as a stroke. */}
      <path
        d="M13.1 10.9V9.2H17V6.6H7v2.6h3.9v1.7c-3.2.1-5.6.8-5.6 1.5s2.4 1.4 5.6 1.5v4.8h2.2v-4.8c3.2-.1 5.6-.8 5.6-1.5s-2.4-1.4-5.6-1.5zm0 2.6h-2.2c-2.9-.1-5-.6-5-1.1s2.1-1 5-1.1v1.9h2.2v-1.9c2.9.1 5 .6 5 1.1s-2.1 1-5 1.1z"
        fill="#ffffff"
        fillRule="evenodd"
      />
    </svg>
  );
}

/** Tron's triangle, for the TRC-20 badge. */
export function TronMark({ size = 10 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" style={{ display: "block", flexShrink: 0 }}>
      <path d="M3.5 5.2 20.5 8l-8.2 11.6z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M3.5 5.2 12.3 10.8 20.5 8M12.3 10.8v8.8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

/** BNB Smart Chain: the four-diamond mark, simplified for a badge. */
export function BnbMark({ size = 10 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" style={{ display: "block", flexShrink: 0 }}>
      <g fill="currentColor">
        <path d="m12 2.6 3 3-3 3-3-3z" />
        <path d="m5.6 9 3 3-3 3-3-3z" />
        <path d="m18.4 9 3 3-3 3-3-3z" />
        <path d="m12 15.4 3 3-3 3-3-3z" />
        <path d="m12 8.9 3.1 3.1-3.1 3.1L8.9 12z" />
      </g>
    </svg>
  );
}

/** Base: its circle with the square cut out of it. */
export function BaseMark({ size = 10 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" style={{ display: "block", flexShrink: 0 }}>
      <path d="M12 2.5A9.5 9.5 0 1 0 12 21.5a9.5 9.5 0 0 0 9.3-7.7H8.2v-3.6h13.1A9.5 9.5 0 0 0 12 2.5z" fill="currentColor" />
    </svg>
  );
}

/** Solana: three slanted bars. */
export function SolMark({ size = 10 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" style={{ display: "block", flexShrink: 0 }}>
      <g fill="currentColor">
        <path d="M6.2 5.4h13.4l-2.6 2.8H3.6z" />
        <path d="M6.2 10.6h13.4l-2.6 2.8H3.6z" />
        <path d="M6.2 15.8h13.4l-2.6 2.8H3.6z" />
      </g>
    </svg>
  );
}

/** Arbitrum: its hexagon with the arrow inside. */
export function ArbMark({ size = 10 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" style={{ display: "block", flexShrink: 0 }}>
      <path d="M12 2.2 20.6 7v10L12 21.8 3.4 17V7z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="m8.6 16 3.4-7 3.4 7M10.2 13.6h3.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Avalanche: the A. */
export function AvaxMark({ size = 10 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" style={{ display: "block", flexShrink: 0 }}>
      <path d="M12 3.4 21.4 20H16l-4-7.1L8 20H2.6z" fill="currentColor" />
    </svg>
  );
}

/** Polygon: two halves of a hexagon, simplified for a badge. */
export function PolMark({ size = 10 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" style={{ display: "block", flexShrink: 0 }}>
      <path d="M8.4 6.1 12 4l3.6 2.1v4.2L12 12.4l-3.6-2.1zM4.8 12.5 8.4 14.6v4.2L4.8 21 1.2 18.8v-4.2zM19.2 12.5l3.6 2.1v4.2L19.2 21l-3.6-2.2v-4.2z" fill="currentColor" />
    </svg>
  );
}

/** A coin's mark, optionally badged with the chain it is wrapped on. The
 *  badge overlaps the coin at the bottom right, the usual corner for it. */
export function CoinIcon({ mark, badge, badgeColor = "#627eea", size = 34 }: { mark: ReactNode; badge?: ReactNode; badgeColor?: string; size?: number }) {
  return (
    <span style={{ position: "relative", display: "flex", flexShrink: 0, width: size, height: size }}>
      {mark}
      {badge && (
        <span style={{ position: "absolute", right: -3, bottom: -2, display: "flex", alignItems: "center", justifyContent: "center",
          width: 17, height: 17, borderRadius: 9, background: badgeColor, color: "#ffffff", border: "2px solid var(--bg)" }}>
          {badge}
        </span>
      )}
    </span>
  );
}

export function Header({ title, onBack, right }: { title: string; onBack?: (() => void) | undefined; right?: ReactNode }) {
  return (
    <div className="header">
      {onBack ? (
        <button type="button" className="icon-btn" aria-label="Back" onClick={onBack}>
          <Icon d={ICONS.back} size={20} />
        </button>
      ) : (
        <div style={{ width: 44 }} />
      )}
      <div className="header-title">{title}</div>
      {right ?? <div style={{ width: 44 }} />}
    </div>
  );
}

export function Button({
  children,
  variant = "primary",
  ...rest
}: { children: ReactNode; variant?: "primary" | "secondary" | "ghost" } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={`btn btn-${variant}`} {...rest}>
      {children}
    </button>
  );
}

export function Callout({ kind, icon, children }: { kind: "info" | "warn" | "danger"; icon?: string; children: ReactNode }) {
  const d = icon ?? (kind === "info" ? ICONS.check : ICONS.warn);
  return (
    <div className={`callout ${kind}`} role={kind === "danger" ? "alert" : undefined}>
      <Icon d={d} />
      <div>{children}</div>
    </div>
  );
}

export function Steps({ step }: { step: 1 | 2 | 3 }) {
  return (
    <div className="steps">
      <div className="steps-bar">
        {[1, 2, 3].map((n) => (
          <div key={n} className={n <= step ? "on" : ""} />
        ))}
      </div>
      <div className="eyebrow">Step {step} of 3</div>
    </div>
  );
}

/** A password field that can be read back, and that says when caps lock is
 *  on: the two reasons people fail to type a password they know. */
export function PasswordInput({
  id,
  value,
  onChange,
  placeholder,
  autoFocus,
  onEnter,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  onEnter?: () => void;
}) {
  const [shown, setShown] = useState(false);
  const [caps, setCaps] = useState(false);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <div className="input">
        <input
          id={id}
          type={shown ? "text" : "password"}
          value={value}
          placeholder={placeholder}
          autoFocus={autoFocus}
          autoComplete="off"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            setCaps(e.getModifierState?.("CapsLock") ?? false);
            if (e.key === "Enter") onEnter?.();
          }}
          onKeyUp={(e) => setCaps(e.getModifierState?.("CapsLock") ?? false)}
          onBlur={() => setCaps(false)}
        />
        <button type="button" className="icon-btn" style={{ width: 32, height: 32 }}
          aria-label={shown ? "Hide password" : "Show password"} aria-pressed={shown}
          onClick={() => setShown(!shown)}>
          <Icon d={shown ? ICONS.eyeOff : ICONS.eye} size={17} />
        </button>
      </div>
      {caps && (
        <span className="muted" style={{ display: "flex", alignItems: "center", gap: 5, color: "var(--warn-text)" }}>
          <Icon d={ICONS.warn} size={13} />Caps lock is on
        </span>
      )}
    </div>
  );
}

export type Tab = "wallet" | "trade" | "activity" | "settings";

export function TabBar({ active, onTab }: { active: Tab; onTab: (t: Tab) => void }) {
  const tabs: { id: Tab; label: string; icon: string; disabled?: boolean }[] = [
    { id: "wallet", label: "Wallet", icon: ICONS.wallet },
    { id: "trade", label: "Trade", icon: ICONS.trade },
    { id: "activity", label: "Activity", icon: ICONS.activity },
    { id: "settings", label: "Settings", icon: ICONS.settings },
  ];
  return (
    <nav className="tabbar">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          className={t.id === active ? "on" : ""}
          disabled={t.disabled}
          title={t.disabled ? "Coming with trading" : undefined}
          onClick={() => onTab(t.id)}
        >
          <Icon d={t.icon} size={20} />
          <span>{t.label}</span>
        </button>
      ))}
    </nav>
  );
}

export function Toggle({ on, label, onChange }: { on: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <button type="button" className="toggle" aria-pressed={on} aria-label={label} onClick={() => onChange(!on)}>
      <span />
    </button>
  );
}
