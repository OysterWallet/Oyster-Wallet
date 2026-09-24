import { isValidAddress } from "./address.js";
import { formatPrl, parsePrl } from "./amount.js";
import type { PearlNetwork } from "./network.js";

/**
 * `pearl:` payment URIs, BIP-21 with Pearl's scheme.
 *
 *   pearl:prl1p...?amount=1.5&label=Coffee&message=Thanks
 *
 * Amounts are in PRL, as BIP-21 means them, not in grains. Unknown query
 * parameters are ignored; a `req-` one is not, because the whole point of
 * that prefix is that a wallet which cannot honour it must refuse.
 */

export interface PaymentUri {
  address: string;
  /** Grains, when the URI asked for a specific amount. */
  amount?: bigint;
  label?: string;
  message?: string;
}

export class UriError extends Error {
  override name = "UriError";
}

/** Parses a URI, or a bare address, into what to pay. */
export function parsePaymentUri(input: string, net: PearlNetwork): PaymentUri {
  const text = input.trim();
  if (!text) throw new UriError("nothing to read");
  if (!/^pearl:/i.test(text)) {
    if (!isValidAddress(text, net)) throw new UriError("not a Pearl address");
    return { address: text };
  }
  const withoutScheme = text.slice(text.indexOf(":") + 1);
  const q = withoutScheme.indexOf("?");
  const address = (q === -1 ? withoutScheme : withoutScheme.slice(0, q)).trim();
  if (!isValidAddress(address, net)) throw new UriError("that link does not carry a Pearl address for this network");

  const out: PaymentUri = { address };
  if (q === -1) return out;
  const params = parseQuery(withoutScheme.slice(q + 1));
  for (const k of Object.keys(params)) {
    if (k.toLowerCase().startsWith("req-")) throw new UriError(`that link needs "${k}", which Oyster does not support`);
  }
  const amount = params["amount"];
  if (amount !== undefined) {
    try {
      const grains = parsePrl(amount.trim());
      if (grains > 0n) out.amount = grains;
    } catch {
      throw new UriError("that link has an amount Oyster cannot read");
    }
  }
  const label = params["label"]?.trim();
  const message = params["message"]?.trim();
  if (label) out.label = label.slice(0, 80);
  if (message) out.message = message.slice(0, 200);
  return out;
}

/** Hand-rolled rather than URLSearchParams: core compiles without DOM or
 *  Node lib types, so it uses only what every JS runtime has. */
function parseQuery(query: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of query.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const rawKey = eq === -1 ? part : part.slice(0, eq);
    const rawValue = eq === -1 ? "" : part.slice(eq + 1);
    const decode = (v: string) => {
      try {
        return decodeURIComponent(v.replace(/\+/g, " "));
      } catch {
        return v;
      }
    };
    const key = decode(rawKey);
    if (key && !(key in out)) out[key] = decode(rawValue);
  }
  return out;
}

const ENCODE = /[^A-Za-z0-9\-_.!~*'()]/g;
const encode = (v: string) => v.replace(ENCODE, (ch) => encodeURIComponent(ch));

/** Builds the URI a QR code should carry. */
export function buildPaymentUri(p: PaymentUri): string {
  const parts: string[] = [];
  if (p.amount !== undefined && p.amount > 0n) parts.push(`amount=${formatPrl(p.amount)}`);
  if (p.label) parts.push(`label=${encode(p.label)}`);
  if (p.message) parts.push(`message=${encode(p.message)}`);
  return `pearl:${p.address}${parts.length ? `?${parts.join("&")}` : ""}`;
}
