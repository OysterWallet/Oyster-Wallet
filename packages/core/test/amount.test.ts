import { describe, it, expect } from "vitest";
import { formatPrl, parseGrains, parsePrl } from "../src/amount.js";

describe("amounts", () => {
  it("parses grain strings, including negative mempool deltas", () => {
    expect(parseGrains("242640059925")).toBe(242640059925n);
    expect(parseGrains("-9037208105")).toBe(-9037208105n);
    expect(() => parseGrains(1.5)).toThrow();
    expect(() => parseGrains("1e8")).toThrow();
  });

  it("keeps full precision above 2^53 grains", () => {
    expect(parseGrains("13742644160882322")).toBe(13742644160882322n);
  });

  it("parses PRL decimals exactly", () => {
    expect(parsePrl("0.0018018")).toBe(180180n);
    expect(parsePrl("90.37208105")).toBe(9037208105n);
    expect(parsePrl("-1")).toBe(-100000000n);
    expect(() => parsePrl("0.000000001")).toThrow(/decimals/);
  });

  it("formats as a plain decimal, never scientific notation", () => {
    expect(formatPrl(9037208105n)).toBe("90.37208105");
    expect(formatPrl(1n)).toBe("0.00000001");
    expect(formatPrl(1138500000000n)).toBe("11385");
    expect(formatPrl(-50n)).toBe("-0.0000005");
  });
});
