import { describe, expect, it } from "vitest";
import { accountFromSeed } from "../../src/derivation.js";
import { PEARL_MAINNET } from "../../src/network.js";
import { signMessageBip322 } from "../../src/sign/bip322.js";

/**
 * Signing in to a running relay with a real wallet key.
 *
 * The one seam neither repository can test on its own. The relay can verify
 * a BIP-322 signature but cannot make one, so its own tests swap in a
 * verifier that says yes; the wallet can make one but has no relay to
 * answer it. Each side stubs the other, and a disagreement between them
 * would look like a working test suite on both.
 *
 * Needs a relay on RELAY (default http://127.0.0.1:8787). Kept out of the
 * default run for that reason.
 */

const BASE = process.env.RELAY ?? "http://127.0.0.1:8787";

// A throwaway key, derived from a fixed seed. Nothing is ever sent to it.
const acct = accountFromSeed(new Uint8Array(64).fill(7), PEARL_MAINNET);
const d = acct.deriveAddress({ index: 0 });
const ADDRESS = d.address;
const sign = (message: string) =>
  signMessageBip322(message, ADDRESS, acct.privateKey({ index: 0 }), d.pubkey, PEARL_MAINNET);

async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe("signing in to the relay for real", () => {
  it("opens a session with a signature this wallet made", async () => {
    const challenge = await post("/v1/session/challenge", { address: ADDRESS });
    expect(challenge.status).toBe(200);
    expect(challenge.body.message).toContain(ADDRESS);
    // The text says what it does not authorise, and the wallet signs it
    // exactly as the relay built it.
    expect(challenge.body.message).toMatch(/A website asking you to sign this/);

    const opened = await post("/v1/session", {
      address: ADDRESS,
      nonce: challenge.body.nonce,
      signature: sign(challenge.body.message),
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    expect(typeof opened.body.token).toBe("string");

    const me = await fetch(`${BASE}/v1/me`, { headers: { authorization: `Bearer ${opened.body.token}` } });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { address: string; senders: { address: string; chain: string }[] };
    expect(body.address).toBe(ADDRESS);
    // Signing in makes this wallet its own sender on the Pearl chain, which
    // is what lets a PRL deposit be credited without anybody declaring
    // anything. Selling depends on it.
    expect(body.senders.some((s) => s.chain === "pearl-tokens" && s.address === ADDRESS)).toBe(true);
  });

  it("refuses a signature made over different text", async () => {
    // The attack this whole scheme exists to stop: a signature lifted from
    // somewhere else, replayed as a sign-in.
    const c = await post("/v1/session/challenge", { address: ADDRESS });
    const refused = await post("/v1/session", {
      address: ADDRESS,
      nonce: c.body.nonce,
      signature: sign(`${c.body.message} `),
    });
    expect(refused.status).toBe(401);
    expect(refused.body.code).toBe("bad-signature");
  });

  it("will not let a challenge be answered twice", async () => {
    const c = await post("/v1/session/challenge", { address: ADDRESS });
    const signature = sign(c.body.message);
    expect((await post("/v1/session", { address: ADDRESS, nonce: c.body.nonce, signature })).status).toBe(200);
    // Spent, even though the signature is still perfectly good.
    expect((await post("/v1/session", { address: ADDRESS, nonce: c.body.nonce, signature })).status).toBe(401);
  });
});
