import { formatPrl, GRAINS_PER_PRL, parsePrl } from "@pearl-wallet/core";

/** "12,480.5521": grouped, fixed decimals, for balances and list rows.
 *  Truncates rather than rounds, so a displayed balance is never more than
 *  what is actually there. Plain decimals only, never scientific notation. */
export function prl(grains: string | bigint, decimals = 4): string {
  const g = typeof grains === "bigint" ? grains : BigInt(grains);
  const neg = g < 0n;
  const abs = neg ? -g : g;
  const whole = (abs / GRAINS_PER_PRL).toLocaleString("en-US");
  const frac = (abs % GRAINS_PER_PRL).toString().padStart(8, "0").slice(0, decimals);
  return `${neg ? "-" : ""}${whole}${decimals > 0 ? `.${frac}` : ""}`;
}

/** Exact, all 8 decimals: fees and totals on review screens. */
export function prlExact(grains: string | bigint): string {
  const g = typeof grains === "bigint" ? grains : BigInt(grains);
  const s = formatPrl(g < 0n ? -g : g);
  const [w, f = ""] = s.split(".");
  return `${g < 0n ? "-" : ""}${w}.${f.padEnd(8, "0")}`;
}

/** What is actually being sent: every significant decimal, at least 4, so a
 *  Max send reads 9.99997337 rather than a truncated 9.9999. */
export function prlReview(grains: string | bigint): string {
  const exact = prlExact(grains);
  const [w, f = ""] = exact.split(".");
  const trimmed = f.replace(/0+$/, "").padEnd(4, "0");
  return `${Number(w).toLocaleString("en-US")}.${trimmed}`;
}

/** User-typed amount to grains; null when it is not a valid amount. */
export function parseAmount(input: string): bigint | null {
  const t = input.trim().replace(/,/g, "");
  if (!/^\d+(\.\d{0,8})?$/.test(t)) return null;
  try {
    return parsePrl(t.endsWith(".") ? t.slice(0, -1) : t);
  } catch {
    return null;
  }
}

export function shortAddr(a: string, head = 10, tail = 6): string {
  return a.length <= head + tail + 1 ? a : `${a.slice(0, head)}…${a.slice(-tail)}`;
}

export function shortTxid(t: string): string {
  return `${t.slice(0, 8)}…${t.slice(-4)}`;
}

export function ago(unixSeconds: number, now = Date.now()): string {
  if (!unixSeconds) return "pending";
  const s = Math.max(0, Math.floor(now / 1000 - unixSeconds));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 172800) return "yesterday";
  return new Date(unixSeconds * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
