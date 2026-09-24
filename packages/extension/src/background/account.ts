import type { FetchLike } from "@pearl-wallet/core";
import type { AccountView, CashEntry, DepositAddress, MyOrder, MyOrdersView, WithdrawInfo } from "../messages";

/**
 * The wallet's account on Oyster's relay.
 *
 * There is no password and no email. Identity is the wallet's own address,
 * proved by signing a challenge with the key behind it, and the relay knows
 * nobody by any other name. That is the same address it pays PRL back to, so
 * there is nothing to get wrong and nothing to recover.
 *
 * The token lives in memory and nowhere else. It is a bearer credential that
 * can spend a balance, so writing it to disk would leave something on this
 * machine that is worth stealing after the wallet is locked. Losing it costs
 * one signature: the service worker dies often, and signing in again is two
 * small requests and no interaction, as long as the wallet is unlocked. When
 * it is locked there is no session, which is the correct answer rather than
 * an inconvenience to work around.
 */

/** What `FetchLike` hands back. Narrower than the DOM's Response, and the
 *  only part of it this file uses. */
type RelayResponse = Awaited<ReturnType<FetchLike>>;

/** Signs a challenge with the active wallet's key. */
export type SignMessage = (message: string) => Promise<{ address: string; signature: string }>;

export class AccountError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AccountError";
    this.code = code;
  }
}

interface Session {
  token: string;
  address: string;
  /** Milliseconds since the epoch, as the relay reported it. */
  expires: number;
}

/** Signed out this long before the relay would refuse it anyway. */
const EARLY_MS = 30_000;

/**
 * Oyster's own messages, word for word as the relay builds them.
 *
 * Kept here as well as there so the wallet signs only text it built itself.
 * A relay that sent anything else, a different address or a sentence
 * authorising something new, gets no signature. The provider refuses to
 * sign any of these for a website, which is what stops a site asking for a
 * sign-in and walking off with the session.
 */
export function signInMessage(address: string, nonce: string, expires: number): string {
  return [
    "Oyster sign-in",
    "",
    "Signing this opens a session on the Oyster relay that can trade and",
    "withdraw this address's balance. Only the Oyster wallet itself should",
    "ever ask for it. A website asking you to sign this is trying to take",
    "over your account.",
    "",
    `Address:   ${address}`,
    `Challenge: ${nonce}`,
    `Expires:   ${new Date(expires).toISOString()}`,
  ].join("\n");
}

/**
 * Whether a message is one of Oyster's own. These open sessions and place
 * money, so the provider never signs them for a website: a site asking for
 * one is phishing, whatever the approval screen would have said.
 */
export function isOysterMessage(message: string): boolean {
  return /^\s*oyster\b/i.test(message);
}

/** Signed by the address a sell's payment spent from, to say it is ours. */
export function sellClaimMessage(account: string, txid: string): string {
  return ["Oyster payment claim", "", `Transaction: ${txid}`, `Oyster account: ${account}`].join("\n");
}

export class Account {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private base: string;
  private session?: Session;
  /** So ten calls at once produce one sign-in, not ten. */
  private signingIn?: Promise<Session>;

  constructor(fetchImpl: FetchLike, now: () => number, base: string) {
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.base = base;
  }

  setBase(base: string): void {
    if (base === this.base) return;
    this.base = base;
    // A token from one relay means nothing to another.
    this.session = undefined;
  }

  /** Forgets the session. Called when the wallet locks or the wallet changes. */
  forget(): void {
    this.session = undefined;
  }

  /** The address the current session belongs to, if there is one. */
  signedInAs(): string | undefined {
    return this.live()?.address;
  }

  private live(): Session | undefined {
    if (!this.session) return undefined;
    if (this.session.expires - EARLY_MS <= this.now()) {
      this.session = undefined;
      return undefined;
    }
    return this.session;
  }

  /**
   * A live session for `me`, signing in if there is not one.
   *
   * The address is passed in rather than discovered, because switching
   * wallets has to switch sessions: a session belongs to one address, and
   * reusing it would show the second wallet the first one's money.
   */
  private async authed(me: string, sign: SignMessage): Promise<Session> {
    const live = this.live();
    if (live && live.address === me) return live;
    this.session = undefined;
    this.signingIn ??= this.open(me, sign).finally(() => {
      this.signingIn = undefined;
    });
    return this.signingIn;
  }

  private async open(me: string, sign: SignMessage): Promise<Session> {
    // Issued to one address, and cannot be answered by another.
    const challenge = await this.post<{ nonce: string; message: string; expires: number }>("/v1/session/challenge", {
      address: me,
    });

    // Signed only if it is exactly the text this wallet would have built.
    // The relay is a server on the internet; what the wallet's key signs is
    // decided here, not there.
    if (challenge.message !== signInMessage(me, challenge.nonce, challenge.expires)) {
      throw new AccountError("bad-challenge", "The relay asked to sign something other than a sign-in. Nothing was signed.");
    }
    const signed = await sign(challenge.message);
    if (signed.address !== me) {
      // The wallet changed under us between asking and signing. Better to
      // fail than to open a session for one address with another's key.
      throw new AccountError("wallet-changed", "The active wallet changed while signing in. Try again.");
    }
    const opened = await this.post<{ token: string; expires: number }>("/v1/session", {
      address: me,
      nonce: challenge.nonce,
      signature: signed.signature,
    });

    this.session = { token: opened.token, address: me, expires: opened.expires };
    return this.session;
  }

  /** Balances, and the addresses the relay thinks this account sends from. */
  async me(me: string, sign: SignMessage): Promise<AccountView> {
    const s = await this.authed(me, sign);
    const body = await this.get<{
      address: string;
      balances: { usdt: string; prl: string };
      kept?: string;
      incoming?: { prl: string; stage: "settling" | "sending"; txid?: string };
      selling?: { prl: string; stage: "waiting" | "sending" | "selling"; txid?: string };
      withdrawing?: { usdt: string; stage: "waiting" | "sending" | "held"; chain: string; txid?: string };
      senders: { address: string; chain: string }[];
    }>("/v1/me", s);
    return {
      address: body.address,
      ...(body.incoming ? { incoming: body.incoming } : {}),
      ...(body.selling ? { selling: body.selling } : {}),
      ...(body.withdrawing ? { withdrawing: body.withdrawing } : {}),
      // Kept as strings all the way to the screen. These are exact integer
      // amounts in the smallest unit and a JSON number would round them.
      usdt: body.balances.usdt,
      kept: body.kept ?? "0",
      prl: body.balances.prl,
      senders: body.senders,
    };
  }

  /**
   * Tells the relay which address this wallet will send from.
   *
   * Money lands in the exchange's own account, where nothing distinguishes
   * one sender from another except the address it came from. Until the
   * relay has been told, a deposit arrives belonging to nobody and needs a
   * person to place it, so this has to happen before any address is shown
   * to send to.
   *
   * This is a claim, not yet a fact: the relay answers with an exact amount,
   * and the first deposit from the address for exactly that proves it. The
   * deposit screen shows the amount (DepositAddress.prove).
   */
  async declareSender(me: string, sign: SignMessage, chain: string, address: string): Promise<void> {
    const s = await this.authed(me, sign);
    await this.post("/v1/me/sender", { chain, address }, s);
  }

  /** Where to send, on one chain. Closed until the relay can credit it. */
  async depositAddress(me: string, sign: SignMessage, network: string): Promise<DepositAddress> {
    try {
      const s = await this.authed(me, sign);
      return await this.get<DepositAddress>(`/v1/cash/address?network=${encodeURIComponent(network)}`, s);
    } catch (e) {
      return { open: false, why: (e as Error).message };
    }
  }

  /** This account's own orders, and what is left to spend after them. */
  async orders(me: string, sign: SignMessage): Promise<MyOrdersView> {
    const s = await this.authed(me, sign);
    return this.get<MyOrdersView>("/v1/me/orders", s);
  }

  /**
   * Places one order.
   *
   * Amounts are strings in the smallest unit, PRL in grains and the price in
   * USDT millionths, and they are built that way all the way from the screen
   * rather than converted here: a float in the middle of this would round
   * somebody's order.
   */
  async place(
    me: string,
    sign: SignMessage,
    order: { side: "buy" | "sell"; amount: string; price: string; keep?: boolean },
  ): Promise<MyOrder> {
    const s = await this.authed(me, sign);
    const body = await this.post<{ order: MyOrder }>("/v1/me/orders", order, s);
    return body.order;
  }

  /**
   * Asks to sell, and finds out where to send the PRL.
   *
   * No price, because none can be honoured: the exchange will not count a
   * PRL deposit until ten blocks have passed, and half an hour is long
   * enough for the market to move a long way. It sells at what it is worth
   * when it gets there.
   */
  async sell(me: string, sign: SignMessage, amountGrains: string): Promise<{ id: number; sendTo: string }> {
    const s = await this.authed(me, sign);
    const body = await this.post<{ sell: { id: number }; sendTo: string }>(
      "/v1/me/sell",
      { amount: amountGrains },
      s,
    );
    return { id: body.sell.id, sendTo: body.sendTo };
  }

  /**
   * Says which payment is bringing the PRL.
   *
   * The relay recognises the money by the address it came from when that is
   * the account's own address. When coin selection spent from another of
   * this wallet's addresses, this claim is what places it, so it is signed
   * by an address the payment actually spent from: a txid alone is public
   * and would let anybody claim it.
   */
  async sellSent(me: string, sign: SignMessage, txid: string, from: string, signature: string): Promise<void> {
    const s = await this.authed(me, sign);
    await this.post("/v1/me/sell/sent", { txid, address: from, signature }, s);
  }

  /**
   * Gives up on a sell whose payment was cancelled.
   *
   * A cancel replaces the payment with one paying this wallet, so the PRL
   * never arrives. Saying so matters because only one sell may wait at a
   * time: left alone it waits for ever and nothing else can be sold.
   */
  /** Everything that has moved this account's money here. */
  async history(me: string, sign: SignMessage, limit = 100): Promise<CashEntry[]> {
    const s = await this.authed(me, sign);
    const body = await this.get<{ entries: CashEntry[] }>(`/v1/me/history?limit=${limit}`, s);
    return body.entries;
  }

  /** How much could be taken out, and on which chains. */
  async withdrawInfo(me: string, sign: SignMessage): Promise<WithdrawInfo> {
    const s = await this.authed(me, sign);
    return this.get<WithdrawInfo>("/v1/me/withdraw", s);
  }

  /**
   * Takes USDT out, to the address it was sent from on `chain`.
   *
   * There is no destination to pass. The relay looks it up from what this
   * wallet declared, and the signer refuses any address its owner has not
   * declared, so a relay that has been taken over cannot be talked into
   * sending somebody's money somewhere else.
   */
  async withdraw(
    me: string,
    sign: SignMessage,
    chain: string,
    amountMicros: string,
  ): Promise<{ id: number; chain: string; destination: string; amount: string; state: string }> {
    const s = await this.authed(me, sign);
    const body = await this.post<{
      withdrawal: { id: number; chain: string; destination: string; amount: string; state: string };
    }>("/v1/me/withdraw", { chain, amount: amountMicros }, s);
    return body.withdrawal;
  }

  /** Lets PRL kept on the exchange be delivered. */
  async releasePrl(me: string, sign: SignMessage): Promise<{ released: string }> {
    const s = await this.authed(me, sign);
    return this.post<{ released: string }>("/v1/me/prl/release", {}, s);
  }

  async abandonSell(me: string, sign: SignMessage): Promise<void> {
    const s = await this.authed(me, sign);
    await this.post("/v1/me/sell/abandon", undefined, s);
  }

  async cancel(me: string, sign: SignMessage, id: number): Promise<MyOrder> {
    const s = await this.authed(me, sign);
    const body = await this.post<{ order: MyOrder }>(`/v1/me/orders/cancel?id=${encodeURIComponent(id)}`, undefined, s);
    return body.order;
  }

  // ---- talking to the relay ------------------------------------------------

  private async get<T>(path: string, s: Session): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, { headers: { authorization: `Bearer ${s.token}` } });
    return this.read<T>(res);
  }

  private async post<T>(path: string, body?: unknown, s?: Session): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(s ? { authorization: `Bearer ${s.token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return this.read<T>(res);
  }

  /**
   * The relay's answer, or its reason.
   *
   * Its refusals carry a code and a sentence written for a person, and both
   * are worth more than "HTTP 400": the screen shows the sentence, and the
   * code is what tells a caller whether to try again.
   */
  private async read<T>(res: RelayResponse): Promise<T> {
    if (res.ok) return (await res.json()) as T;
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    if (res.status === 401) {
      // Whatever we had is no longer good. Throwing away the token means the
      // next call signs in again rather than repeating a refused request.
      this.session = undefined;
    }
    throw new AccountError(body.code ?? `http-${res.status}`, body.error ?? `the relay answered ${res.status}`);
  }
}
