import { describe, expect, it } from "vitest";
import {
  amountForSpend,
  costOf,
  formatUnits,
  MIN_ORDER_GRAINS,
  parseUnits,
  priceUnits,
  roundAmount,
  sellableOnExchange,
  splitSell,
} from "../src/trade/order.js";

const PRL = 100_000_000n;
const USDT = 1_000_000n;

describe("reading what somebody typed", () => {
  it("does not go through a double", () => {
    // Number("0.1") * 1e6 is 100000.00000000001. Rounding that away works
    // until the one amount where it does not.
    expect(parseUnits("0.1", 6)).toBe(100_000n);
    expect(parseUnits("100", 6)).toBe(100n * USDT);
    expect(parseUnits("0.000001", 6)).toBe(1n);
    expect(parseUnits("1.5", 8)).toBe(150_000_000n);
  });

  it("takes the shapes a keypad produces", () => {
    expect(parseUnits(".5", 6)).toBe(500_000n);
    expect(parseUnits("5.", 6)).toBe(5n * USDT);
    expect(parseUnits(" 2 ", 6)).toBe(2n * USDT);
  });

  it("refuses what is not an amount", () => {
    for (const bad of ["", ".", "abc", "-1", "1e3", "0x10"]) {
      expect(() => parseUnits(bad, 6)).toThrow();
    }
  });

  it("drops digits past the places it was asked for rather than rounding up", () => {
    // Rounding up would spend more than was typed.
    expect(parseUnits("1.9999999", 6)).toBe(1_999_999n);
  });

  it("writes amounts back as plain decimals", () => {
    // Never scientific notation: "1e-7 PRL" is not a thing anybody can read.
    expect(formatUnits(1n, 8)).toBe("0.00000001");
    expect(formatUnits(150_000_000n, 8)).toBe("1.5");
    expect(formatUnits(0n, 6)).toBe("0");
    expect(formatUnits(100n * USDT, 6)).toBe("100");
  });

  it("round-trips", () => {
    for (const s of ["0.00000001", "1.5", "1234.5678", "99999"]) {
      expect(formatUnits(parseUnits(s, 8), 8)).toBe(s.replace(/\.?0+$/, "") || "0");
    }
  });
});

describe("prices the market will take", () => {
  it("keeps two decimals", () => {
    expect(priceUnits(1.03, "buy")).toBe(1_030_000n);
    expect(priceUnits(1.03, "sell")).toBe(1_030_000n);
  });

  it("rounds a buy ceiling up and a sell floor down", () => {
    // Never quietly tightened past what somebody agreed to: a buy that
    // rounded down might not fill, and a sell that rounded up might not
    // either, and in both cases the screen promised otherwise.
    expect(priceUnits(1.034, "buy")).toBe(1_040_000n);
    expect(priceUnits(1.036, "sell")).toBe(1_030_000n);
  });

  it("never rounds a real price away to nothing", () => {
    expect(priceUnits(0.0001, "sell")).toBe(10_000n);
  });

  it("refuses a price that is not one", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => priceUnits(bad, "buy")).toThrow();
    }
  });
});

describe("sizing an order", () => {
  it("cuts an amount to the market's four decimals, downwards", () => {
    // Up would ask for more PRL than somebody said.
    expect(roundAmount(199_999_999n)).toBe(199_990_000n);
    expect(roundAmount(2n * PRL)).toBe(2n * PRL);
  });

  it("works out what a spend buys", () => {
    // 10 USDT at 1.03 is 9.7087... PRL, cut to four decimals.
    expect(amountForSpend(10n * USDT, 1_030_000n)).toBe(970_870_000n);
    expect(formatUnits(amountForSpend(10n * USDT, 1_030_000n), 8)).toBe("9.7087");
  });

  it("never turns a spend into an order that costs more than it", () => {
    for (const spend of [2n * USDT, 7n * USDT, 123_456_789n]) {
      for (const price of [1_000_000n, 1_030_000n, 990_000n]) {
        expect(costOf(amountForSpend(spend, price), price)).toBeLessThanOrEqual(spend);
      }
    }
  });

  it("rounds a cost up, because it is checked against a balance", () => {
    // A reservation a millionth short is an order the relay refuses after
    // the screen has already said it was fine.
    expect(costOf(1n, 1_030_000n)).toBe(1n);
    expect(costOf(2n * PRL, 1_030_000n)).toBe(2_060_000n);
  });

  it("knows the smallest order the market takes", () => {
    // 1 PRL is not placeable; this was proven against the live account.
    expect(MIN_ORDER_GRAINS).toBe(2n * PRL);
    expect(amountForSpend(1n * USDT, 1_030_000n)).toBeLessThan(MIN_ORDER_GRAINS);
  });
});

describe("where a sell's PRL comes from", () => {
  const P = 100_000_000n;

  it("sells from the exchange when it covers the whole amount", () => {
    expect(splitSell(5n * P, 10n * P)).toEqual({ exchange: 5n * P, wallet: 0n });
  });

  it("sells from the wallet when nothing is on the exchange", () => {
    expect(splitSell(5n * P, 0n)).toEqual({ exchange: 0n, wallet: 5n * P });
  });

  it("uses the exchange first and the wallet for the rest", () => {
    expect(splitSell(10n * P, 4n * P)).toEqual({ exchange: 4n * P, wallet: 6n * P });
  });

  it("ignores exchange PRL too small to be an order on its own", () => {
    expect(splitSell(5n * P, 1n * P)).toEqual({ exchange: 0n, wallet: 5n * P });
  });

  it("refuses a remainder too small to place, and says what would work", () => {
    const r = splitSell(11n * P, 10n * P);
    expect("error" in r && r.error).toMatch(/10 PRL on the exchange.*at least 12 PRL/);
  });

  it("refuses less than the market minimum", () => {
    expect("error" in splitSell(1n * P, 10n * P)).toBe(true);
  });

  it("leaves room for the fee when working out what the exchange balance can sell", () => {
    expect(sellableOnExchange(10_125n * P / 1000n)).toBe(10n * P);
    expect(sellableOnExchange(0n)).toBe(0n);
  });
});
