/**
 * Request pacing for the public indexers.
 *
 * Measured 2026-09-19 against blockbook.testnet.pearlresearch.ai: a sustained
 * run from one IP was first limited after ~2,600 requests in 16 s and
 * recovered within 5 s. Yet a wallet scan from the extension was limited on 4
 * of its first 160 lookups, and identical bursts minutes later were not. The
 * limiter is shared with other traffic and trips intermittently, so the client
 * paces itself and retries rather than assuming any fixed budget.
 */

// core compiles without DOM or Node types; both targets provide setTimeout.
declare function setTimeout(cb: () => void, ms: number): unknown;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Token bucket: at most `perSecond` starts per second, bursts up to `burst`. */
export class Pacer {
  private tokens: number;
  private last: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.tokens = burst;
    this.last = now();
  }

  /** Resolves when the caller may start one request. FIFO. */
  take(): Promise<void> {
    const turn = this.queue.then(async () => {
      for (;;) {
        const t = this.now();
        this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.perSecond);
        this.last = t;
        if (this.tokens >= 1) {
          this.tokens -= 1;
          return;
        }
        await sleep(Math.ceil(((1 - this.tokens) / this.perSecond) * 1000));
      }
    });
    this.queue = turn;
    return turn;
  }
}
