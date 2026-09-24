/**
 * Integer-only amount parsing. 1 PRL = 10^8 grains.
 *
 * Blockbook returns amounts as decimal strings: base units for balances and
 * values ("242640059925"), and PRL per kB for fee estimates ("0.0018018").
 * Neither ever goes through a JS number, which loses precision above 2^53
 * (about 90 million PRL in grains).
 */

export const GRAINS_PER_PRL = 100_000_000n;
const DECIMALS = 8;

/** "123" or "-45" in base units. */
export function parseGrains(value: unknown): bigint {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) {
    throw new Error(`expected an integer amount string, got ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}

/** "0.0018018" PRL -> 180180n grains. Rejects more than 8 decimals. */
export function parsePrl(value: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new Error(`expected a decimal PRL amount, got ${JSON.stringify(value)}`);
  const [, sign, whole, frac = ""] = m;
  if (frac.length > DECIMALS) throw new Error(`more than ${DECIMALS} decimals: ${value}`);
  const grains = BigInt(whole!) * GRAINS_PER_PRL + BigInt(frac.padEnd(DECIMALS, "0"));
  return sign ? -grains : grains;
}

/** 11385.5n * 10^8 -> "11385.5". Plain decimal, never scientific notation. */
export function formatPrl(grains: bigint): string {
  const neg = grains < 0n;
  const abs = neg ? -grains : grains;
  const whole = abs / GRAINS_PER_PRL;
  const frac = (abs % GRAINS_PER_PRL).toString().padStart(DECIMALS, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}
