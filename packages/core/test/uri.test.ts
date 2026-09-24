import { describe, it, expect } from "vitest";
import { PEARL_MAINNET, PEARL_TESTNET2 } from "../src/network.js";
import { buildPaymentUri, parsePaymentUri, UriError } from "../src/uri.js";

const ADDR = "prl1p04985r8hkh8tjwj0hu78qcy6kpesypy0gmzwz5508tany932jg6sq7pzrr";

describe("payment URIs", () => {
  it("reads a bare address", () => {
    expect(parsePaymentUri(` ${ADDR} `, PEARL_MAINNET)).toEqual({ address: ADDR });
  });

  it("reads an amount in PRL, not grains", () => {
    const p = parsePaymentUri(`pearl:${ADDR}?amount=1.5`, PEARL_MAINNET);
    expect(p.amount).toBe(150_000_000n);
  });

  it("carries a label and a message, and ignores what it does not know", () => {
    const p = parsePaymentUri(`pearl:${ADDR}?amount=2&label=Coffee&message=Thanks&whatever=1`, PEARL_MAINNET);
    expect(p).toMatchObject({ address: ADDR, amount: 200_000_000n, label: "Coffee", message: "Thanks" });
  });

  it("refuses a req- parameter it cannot honour", () => {
    expect(() => parsePaymentUri(`pearl:${ADDR}?req-escrow=1`, PEARL_MAINNET)).toThrow(UriError);
  });

  it("refuses an address from another network, or a broken amount", () => {
    expect(() => parsePaymentUri(`pearl:${ADDR}`, PEARL_TESTNET2)).toThrow(UriError);
    expect(() => parsePaymentUri(`pearl:${ADDR}?amount=lots`, PEARL_MAINNET)).toThrow(UriError);
  });

  it("round-trips what it builds", () => {
    const uri = buildPaymentUri({ address: ADDR, amount: 123_450_000n, label: "Invoice 7" });
    expect(uri.startsWith(`pearl:${ADDR}?`)).toBe(true);
    const back = parsePaymentUri(uri, PEARL_MAINNET);
    expect(back.amount).toBe(123_450_000n);
    expect(back.label).toBe("Invoice 7");
  });

  it("leaves a plain address plain", () => {
    expect(buildPaymentUri({ address: ADDR })).toBe(`pearl:${ADDR}`);
  });
});
