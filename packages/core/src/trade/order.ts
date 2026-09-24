import { GRAINS_PER_PRL } from "../amount.js";

/**
 * Turning what somebody typed into what an order says.
 *
 * The relay wants exact integers: PRL in grains and the price in USDT
 * millionths. The screen has decimal strings and, for a market order, a
 * price that came back as a JavaScript number. Everything in between is
 * done here, in one place, because a float loose in the middle of it would
 * round somebody's order and nobody would see where.
 *
 * The market's own rules, read off the live account on 2026-09-22: amounts
 * carry four decimals, prices two, and the smallest order is 2 PRL. An
 * order that breaks one of them is refused by the exchange after the money
 * has already been set aside, so they are applied here instead.
 */

export const MICROS_PER_USDT = 1_000_000n;
/** Grains per step of the market's amount precision (4 decimals). */
const AMOUNT_STEP = 10_000n;
/** Millionths per step of the market's price precision (2 decimals). */
const PRICE_STEP = 10_000n;
/** The smallest order the market takes. */
export const MIN_ORDER_GRAINS = 2n * GRAINS_PER_PRL;

/**
 * A decimal string in `decimals` places, exactly.
 *
 * Never through a Number: `Number("0.1") * 1e6` is 100000.00000000001, and
 * rounding that away works until the one amount where it does not.
 */
export function parseUnits(value: string, decimals: number): bigint {
  const m = /^(\d*)(?:\.(\d*))?$/.exec(value.trim());
  if (!m || (m[1] === "" && (m[2] ?? "") === "")) {
    throw new Error(`expected a decimal amount, got ${JSON.stringify(value)}`);
  }
  const frac = (m[2] ?? "").slice(0, decimals).padEnd(decimals, "0");
  return BigInt(m[1] || "0") * 10n ** BigInt(decimals) + BigInt(frac || "0");
}

/** Smallest units as a plain decimal. Never scientific notation. */
export function formatUnits(units: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const frac = (abs % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${abs / scale}${frac ? `.${frac}` : ""}`;
}

/**
 * A price the market will accept, in millionths.
 *
 * Rounded in the direction that keeps the promise the screen made: a buy
 * ceiling rounds up and a sell floor rounds down, so the order is never
 * quietly tightened past what somebody agreed to. The number arrives as a
 * float because it came from a quote, and two decimals is well inside what
 * a double holds exactly at these prices.
 */
export function priceUnits(usdt: number, side: "buy" | "sell"): bigint {
  if (!Number.isFinite(usdt) || usdt <= 0) throw new Error("a price is needed");
  const hundredths = side === "buy" ? Math.ceil(usdt * 100) : Math.floor(usdt * 100);
  return BigInt(Math.max(1, hundredths)) * PRICE_STEP;
}

/** Cuts an amount down to the market's four decimals. Never up: rounding up
 *  would ask for more PRL than somebody said. */
export function roundAmount(grains: bigint): bigint {
  return (grains / AMOUNT_STEP) * AMOUNT_STEP;
}

/**
 * How much PRL a given spend buys at a given price.
 *
 * Rounded down, then down again to the market's precision, so the order
 * never costs more than the amount somebody typed. The remainder is a few
 * millionths of a USDT and stays where it is.
 */
export function amountForSpend(spendMicros: bigint, priceMicros: bigint): bigint {
  if (priceMicros <= 0n) throw new Error("a price is needed");
  return roundAmount((spendMicros * GRAINS_PER_PRL) / priceMicros);
}

/**
 * What a buy of this size can cost at this price, rounded up.
 *
 * Up, because this is the number to check a balance against: a reservation
 * that falls a millionth short is an order the relay refuses after the
 * screen has already said it was fine.
 */
export function costOf(amountGrains: bigint, priceMicros: bigint): bigint {
  const product = amountGrains * priceMicros;
  return product / GRAINS_PER_PRL + (product % GRAINS_PER_PRL === 0n ? 0n : 1n);
}

/**
 * PRL on the exchange a sell order can use, from what the relay says is
 * spendable there.
 *
 * A sell sets aside Oyster's 1.25% from the same PRL on top of the amount
 * sold, so the whole balance cannot be the amount. Rounded down to the
 * market's precision.
 */
export function sellableOnExchange(spendableGrains: bigint): bigint {
  if (spendableGrains <= 0n) return 0n;
  return roundAmount((spendableGrains * 10_000n) / 10_125n);
}

/**
 * Where a sell's PRL comes from: the exchange first, then this wallet.
 *
 * PRL already on the exchange sells at once; PRL in the wallet has to be
 * sent there and waits about half an hour for confirmations. Each half has
 * to meet the market's minimum on its own, since each is its own order, so
 * an amount that would leave a remainder too small to place is refused with
 * the two amounts that would work.
 */
export function splitSell(
  want: bigint,
  onExchange: bigint,
): { exchange: bigint; wallet: bigint } | { error: string } {
  const amount = roundAmount(want);
  if (amount < MIN_ORDER_GRAINS) {
    return { error: `The smallest sell this market takes is ${fmt(MIN_ORDER_GRAINS)} PRL.` };
  }
  const ready = onExchange >= MIN_ORDER_GRAINS ? roundAmount(onExchange) : 0n;
  if (ready >= amount) return { exchange: amount, wallet: 0n };
  const rest = amount - ready;
  if (ready > 0n && rest < MIN_ORDER_GRAINS) {
    return {
      error:
        `You have ${fmt(ready)} PRL on the exchange. Sell up to that for an instant sale, ` +
        `or at least ${fmt(ready + MIN_ORDER_GRAINS)} PRL to add some from this wallet.`,
    };
  }
  return { exchange: ready, wallet: rest };
}

function fmt(grains: bigint): string {
  const whole = grains / GRAINS_PER_PRL;
  const frac = (grains % GRAINS_PER_PRL).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
