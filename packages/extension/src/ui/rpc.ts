import { browser } from "wxt/browser";
import type { Reply, Request, Responses } from "../messages";

export class RpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Scans can be long (an import checks 500+ addresses); everything else is quick. */
const TIMEOUT_MS: Partial<Record<Request["type"], number>> = {
  walletView: 180_000,
  miningView: 120_000,
  send: 90_000,
  createVault: 60_000,
  unlock: 60_000,
};

/** Typed call into the background service. Throws RpcError on failure,
 *  including when the worker never answers, so no screen can hang forever. */
export async function call<T extends Request["type"]>(
  req: Extract<Request, { type: T }>,
): Promise<Responses[T]> {
  const ms = TIMEOUT_MS[req.type] ?? 30_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new RpcError("timeout", "The wallet took too long to answer. Check your connection and try again.")),
      ms,
    );
  });
  let reply: Reply<T> | undefined;
  try {
    reply = (await Promise.race([browser.runtime.sendMessage(req), timeout])) as Reply<T> | undefined;
  } catch (e) {
    if (e instanceof RpcError) throw e;
    throw new RpcError("no-reply", "The wallet background stopped responding. Try again.");
  } finally {
    clearTimeout(timer);
  }
  if (!reply) throw new RpcError("no-reply", "The wallet background did not answer. Try reopening the popup.");
  if (!reply.ok) throw new RpcError(reply.error.code, reply.error.message);
  return reply.value;
}
