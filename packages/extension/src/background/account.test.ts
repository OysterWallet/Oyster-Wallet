import { describe, expect, it } from "vitest";
import { Account, isOysterMessage, signInMessage } from "./account";

/**
 * What the wallet's key will and will not sign on the relay's behalf.
 *
 * A sign-in signature opens a session that can trade and withdraw. So the
 * wallet signs only the exact text it would have built itself, and never
 * signs any Oyster message for a website.
 */

const ME = "prl1ppsfa24gsxjwfq56xnjm024uwe0xw9ug84vc0axyeza5dlu04s4lqynl80w";
const EXPIRES = 2_000_000_000_000;

/** A relay that answers the challenge with `message`, and records what was signed. */
function relayOffering(message: string) {
  const signed: string[] = [];
  const fetchImpl = async (url: string) => {
    const path = new URL(url).pathname;
    const body =
      path === "/v1/session/challenge"
        ? { nonce: "n", message, expires: EXPIRES }
        : path === "/v1/session"
          ? { token: "t", expires: EXPIRES }
          : { address: ME, balances: { usdt: "0", prl: "0" }, senders: [] };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  const account = new Account(fetchImpl as never, () => 1_000, "https://relay.example");
  const sign = async (m: string) => {
    signed.push(m);
    return { address: ME, signature: "sig" };
  };
  return { account, sign, signed };
}

describe("signing in", () => {
  it("signs the exact sign-in text", async () => {
    const r = relayOffering(signInMessage(ME, "n", EXPIRES));
    await r.account.me(ME, r.sign);
    expect(r.signed).toEqual([signInMessage(ME, "n", EXPIRES)]);
  });

  it("signs nothing when the relay asks for different text", async () => {
    for (const bad of [
      "sign in",
      signInMessage("prl1someoneelse", "n", EXPIRES),
      signInMessage(ME, "n", EXPIRES).replace("trade and", "trade, and grant withdrawals to any address, and"),
      `${signInMessage(ME, "n", EXPIRES)}\nAlso: send everything to prl1attacker`,
    ]) {
      const r = relayOffering(bad);
      await expect(r.account.me(ME, r.sign)).rejects.toThrow(/Nothing was signed/);
      expect(r.signed).toEqual([]);
    }
  });
});

describe("messages a website may not have signed", () => {
  it("recognises every Oyster message, however it is dressed up", () => {
    for (const m of [
      signInMessage(ME, "n", EXPIRES),
      "Oyster payment claim\n\nTransaction: ab",
      "Oyster address proof",
      "  \n oyster sign-in",
      "OYSTER",
    ]) {
      expect(isOysterMessage(m), m).toBe(true);
    }
  });

  it("leaves ordinary messages alone", () => {
    for (const m of ["Sign in to market.example", "Oysters are great", "hello oyster", ""]) {
      expect(isOysterMessage(m), m).toBe(false);
    }
  });
});
