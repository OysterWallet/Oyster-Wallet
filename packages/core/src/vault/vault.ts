import { gcm } from "@noble/ciphers/aes.js";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import { base64, utf8 } from "@scure/base";
import type { Platform } from "../platform.js";

/**
 * The encrypted vault: every wallet's seed phrase under one password.
 *
 * Format v1, stored as JSON under `vault.v1` in durable storage:
 *   { v: 1, kdf: { name: "scrypt", N, r, p, salt }, nonce, ct }
 * scrypt derives a 32-byte key from the password; AES-256-GCM encrypts the
 * contents, with the header bound in as associated data so the KDF params
 * cannot be swapped without the tag failing.
 *
 * While unlocked, the derived key (not the password, not the plaintext) sits
 * in session storage together with a last-activity timestamp. Every access
 * checks idle time against the auto-lock window and wipes the key if it has
 * passed. The timer is enforced here, on read, so it holds even when the
 * extension's alarm never fires (the service worker was asleep).
 *
 * Pure JS (@noble) rather than WebCrypto so the same code runs on React
 * Native. Known limit of JS: the mnemonic is a string and cannot be zeroed;
 * the design relies on the process boundary and the auto-lock, not on wiping.
 */

/** A seed phrase held in the vault. Several wallets can derive from one. */
export interface VaultSeed {
  id: string;
  mnemonic: string;
  createdAt: number;
}

export type WalletColor = "teal" | "amber" | "red" | "violet" | "slate" | "ink";
export const WALLET_COLORS: readonly WalletColor[] = ["teal", "amber", "red", "violet", "slate", "ink"];

export type WalletSource =
  /** BIP-86 account `account` of seed `seedId`: m/86'/coin'/account'. */
  | { kind: "seed"; seedId: string; account: number }
  /** A single address followed without keys. Can never spend. */
  | { kind: "watch"; address: string };

export interface VaultWallet {
  id: string;
  name: string;
  color: WalletColor;
  source: WalletSource;
  createdAt: number;
}

/** Schema 2: seeds and the wallets that point at them. */
export interface VaultContents {
  schema: 2;
  seeds: VaultSeed[];
  wallets: VaultWallet[];
}

/** Schema 1 (phases 2-4): one mnemonic embedded per wallet. */
interface LegacyContents {
  wallets: { id: string; name: string; mnemonic: string; createdAt: number }[];
}

/**
 * Upgrades any stored contents to the current schema. Schema 1 wallets each
 * become a seed plus a wallet on account 0 of it, keeping id, name and
 * creation time, so per-wallet settings keyed by wallet id carry over.
 */
export function migrateContents(raw: unknown): VaultContents {
  const r = raw as Partial<VaultContents> & Partial<LegacyContents>;
  if (r && r.schema === 2 && Array.isArray(r.seeds) && Array.isArray(r.wallets)) return r as VaultContents;
  if (r && r.schema === undefined && Array.isArray(r.wallets)) {
    const legacy = r as LegacyContents;
    return {
      schema: 2,
      seeds: legacy.wallets.map((w) => ({ id: `seed-${w.id}`, mnemonic: w.mnemonic, createdAt: w.createdAt })),
      wallets: legacy.wallets.map((w) => ({
        id: w.id,
        name: w.name,
        color: "teal" as const,
        source: { kind: "seed" as const, seedId: `seed-${w.id}`, account: 0 },
        createdAt: w.createdAt,
      })),
    };
  }
  throw new VaultError("vault contents malformed", "corrupt");
}

export interface KdfParams {
  name: "scrypt";
  N: number;
  r: number;
  p: number;
  salt: string;
}

interface VaultFile {
  v: 1;
  kdf: KdfParams;
  nonce: string;
  ct: string;
}

export class VaultError extends Error {
  override name = "VaultError";
  constructor(
    message: string,
    readonly code: "exists" | "missing" | "locked" | "wrong-password" | "weak-password" | "corrupt" | "throttled",
  ) {
    super(message);
  }
}

/** Measured 2026-09-18, pure-JS scrypt on a Ryzen 9 5900X: 2^16 580 ms,
 *  2^17 1.1 s, 2^18 2.2 s. 2^17 is right for the desktop extension; a phone
 *  will be several times slower, so the mobile shell may pick 2^16. The params
 *  are stored per vault, so either can change without breaking old vaults. */
export const DEFAULT_KDF = { N: 2 ** 17, r: 8, p: 1 } as const;
export const MIN_PASSWORD_LENGTH = 8;
/** Matches the design: "Locks itself after 15 minutes idle". */
export const DEFAULT_AUTO_LOCK_MS = 15 * 60 * 1000;

const VAULT_KEY = "vault.v1";
const ATTEMPTS_KEY = "vault.attempts";

/** Wrong passwords cost time, and the cost grows. scrypt already makes each
 *  guess expensive; this makes a run of them pointless, and it survives a
 *  worker restart because it is written down rather than held in memory.
 *  The first few are free: people mistype their own password. */
const FREE_ATTEMPTS = 3;
const BACKOFF_MS = [5_000, 15_000, 60_000, 5 * 60_000, 15 * 60_000];
const SESSION_KEY = "vault.key";
const SESSION_ACTIVITY = "vault.activity";

export class Vault {
  /** Read on every check, so a changed setting applies immediately. */
  private readonly autoLockMs: () => number | Promise<number>;
  private readonly kdf: { N: number; r: number; p: number };

  constructor(
    private readonly platform: Platform,
    opts: {
      autoLockMs?: number | (() => number | Promise<number>);
      kdf?: { N: number; r: number; p: number };
    } = {},
  ) {
    const a = opts.autoLockMs ?? DEFAULT_AUTO_LOCK_MS;
    this.autoLockMs = typeof a === "function" ? a : () => a;
    this.kdf = opts.kdf ?? DEFAULT_KDF;
  }

  async exists(): Promise<boolean> {
    return (await this.platform.storage.get(VAULT_KEY)) !== null;
  }

  /** Creates the vault and leaves it unlocked. Refuses to overwrite. */
  async create(password: string, contents: VaultContents): Promise<void> {
    if (await this.exists()) throw new VaultError("a vault already exists", "exists");
    checkPassword(password);
    const kdf: KdfParams = {
      name: "scrypt",
      ...this.kdf,
      salt: base64.encode(this.platform.random.bytes(16)),
    };
    const key = await deriveKey(password, kdf);
    await this.platform.storage.set(VAULT_KEY, JSON.stringify(this.seal(key, kdf, contents)));
    await this.startSession(key);
  }

  /**
   * Deletes the vault from this device. The only way back is the seed phrase,
   * so callers must have the user confirm that explicitly. Used by "forgot
   * password, restore from seed", which replaces the vault with a new one.
   */
  async destroy(): Promise<void> {
    await this.lock();
    await this.platform.storage.delete(VAULT_KEY);
  }

  async unlock(password: string): Promise<void> {
    const wait = await this.throttleMs();
    if (wait > 0) {
      throw new VaultError(
        `Too many wrong passwords. Try again in ${wait < 60_000 ? `${Math.ceil(wait / 1000)} seconds` : `${Math.ceil(wait / 60_000)} minutes`}.`,
        "throttled",
      );
    }
    const file = await this.load();
    const key = await deriveKey(password, file.kdf);
    try {
      this.open(key, file); // throws wrong-password
    } catch (e) {
      await this.recordFailure();
      throw e;
    }
    await this.platform.storage.delete(ATTEMPTS_KEY);
    await this.startSession(key);
  }

  /** How long the next attempt has to wait, 0 when it may go ahead. */
  private async throttleMs(): Promise<number> {
    const raw = await this.platform.storage.get(ATTEMPTS_KEY);
    if (!raw) return 0;
    const { fails, last } = JSON.parse(raw) as { fails: number; last: number };
    const over = fails - FREE_ATTEMPTS;
    if (over <= 0) return 0;
    const delay = BACKOFF_MS[Math.min(over - 1, BACKOFF_MS.length - 1)]!;
    return Math.max(0, last + delay - this.platform.clock.now());
  }

  private async recordFailure(): Promise<void> {
    const raw = await this.platform.storage.get(ATTEMPTS_KEY);
    const fails = (raw ? (JSON.parse(raw) as { fails: number }).fails : 0) + 1;
    await this.platform.storage.set(ATTEMPTS_KEY, JSON.stringify({ fails, last: this.platform.clock.now() }));
  }

  /** For the unlock screen: how long it must wait, and how many tries are
   *  left before waiting starts. */
  async unlockDelayMs(): Promise<number> {
    return this.throttleMs();
  }

  /** The sealed file exactly as stored: still encrypted with the password,
   *  so it is safe to carry around and useless without it. */
  async exportSealed(): Promise<string> {
    const raw = await this.platform.storage.get(VAULT_KEY);
    if (!raw) throw new VaultError("there is no vault to export", "missing");
    return raw;
  }

  /** Replaces the vault on this device with a sealed file, after proving the
   *  password opens it. Leaves it locked: restoring is not unlocking. */
  async importSealed(sealed: string, password: string): Promise<void> {
    let file: VaultFile;
    try {
      file = JSON.parse(sealed) as VaultFile;
    } catch {
      throw new VaultError("that file is not an Oyster backup", "corrupt");
    }
    if (file?.v !== 1 || !file.kdf || typeof file.nonce !== "string" || typeof file.ct !== "string") {
      throw new VaultError("that file is not an Oyster backup", "corrupt");
    }
    const key = await deriveKey(password, file.kdf);
    this.open(key, file); // throws wrong-password, or corrupt
    await this.platform.storage.set(VAULT_KEY, JSON.stringify(file));
    await this.platform.storage.delete(ATTEMPTS_KEY);
    await this.lock();
  }

  async lock(): Promise<void> {
    await this.platform.session.delete(SESSION_KEY);
    await this.platform.session.delete(SESSION_ACTIVITY);
  }

  /** Applies the idle check, so a stale session reports locked and is wiped. */
  async isUnlocked(): Promise<boolean> {
    return (await this.sessionKey()) !== null;
  }

  /** Decrypted contents. Counts as activity for auto-lock. */
  async read(): Promise<VaultContents> {
    const key = await this.requireKey();
    return this.open(key, await this.load());
  }

  /**
   * Runs `fn` without it counting as activity.
   *
   * A timer refreshing a balance is not somebody using the wallet. Without
   * this, a popup or side panel left open would read the vault every few
   * minutes and auto-lock would never fire. The idle check itself still
   * runs inside `fn`, so a wallet past its time locks as usual.
   */
  async quietly<T>(fn: () => Promise<T>): Promise<T> {
    const before = await this.platform.session.get(SESSION_ACTIVITY);
    try {
      return await fn();
    } finally {
      if (before !== null && (await this.platform.session.get(SESSION_KEY)) !== null) {
        await this.platform.session.set(SESSION_ACTIVITY, before);
      }
    }
  }

  /** Re-encrypts with the current key and a fresh nonce. */
  async write(contents: VaultContents): Promise<void> {
    const key = await this.requireKey();
    const file = await this.load();
    await this.platform.storage.set(VAULT_KEY, JSON.stringify(this.seal(key, file.kdf, contents)));
  }

  /** Verifies the old password even while unlocked: this is the one action a
   *  person at an unlocked, unattended machine must not be able to do. */
  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    const file = await this.load();
    const contents = this.open(await deriveKey(oldPassword, file.kdf), file);
    checkPassword(newPassword);
    const kdf: KdfParams = {
      name: "scrypt",
      ...this.kdf,
      salt: base64.encode(this.platform.random.bytes(16)),
    };
    const key = await deriveKey(newPassword, kdf);
    await this.platform.storage.set(VAULT_KEY, JSON.stringify(this.seal(key, kdf, contents)));
    await this.startSession(key);
  }

  /** Re-checks the password before a sensitive action (export seed, send). */
  async verifyPassword(password: string): Promise<boolean> {
    const file = await this.load();
    try {
      this.open(await deriveKey(password, file.kdf), file);
      return true;
    } catch (e) {
      if (e instanceof VaultError && e.code === "wrong-password") return false;
      throw e;
    }
  }

  private seal(key: Uint8Array, kdf: KdfParams, contents: VaultContents): VaultFile {
    const nonce = this.platform.random.bytes(12);
    const ct = gcm(key, nonce, aad(kdf)).encrypt(utf8.decode(JSON.stringify(contents)));
    return { v: 1, kdf, nonce: base64.encode(nonce), ct: base64.encode(ct) };
  }

  private open(key: Uint8Array, file: VaultFile): VaultContents {
    let plain: Uint8Array;
    try {
      plain = gcm(key, base64.decode(file.nonce), aad(file.kdf)).decrypt(base64.decode(file.ct));
    } catch {
      // GCM cannot tell a wrong key from tampering; with a KDF'd key from a
      // typed password, wrong password is by far the likelier cause.
      throw new VaultError("wrong password", "wrong-password");
    }
    return migrateContents(JSON.parse(utf8.encode(plain)));
  }

  private async load(): Promise<VaultFile> {
    const raw = await this.platform.storage.get(VAULT_KEY);
    if (raw === null) throw new VaultError("no vault on this device", "missing");
    let file: VaultFile;
    try {
      file = JSON.parse(raw) as VaultFile;
    } catch {
      throw new VaultError("vault file is not valid JSON", "corrupt");
    }
    if (file.v !== 1 || file.kdf?.name !== "scrypt") {
      throw new VaultError(`unsupported vault format ${String(file.v)}`, "corrupt");
    }
    return file;
  }

  private async startSession(key: Uint8Array): Promise<void> {
    await this.platform.session.set(SESSION_KEY, base64.encode(key));
    await this.touch();
  }

  private async touch(): Promise<void> {
    await this.platform.session.set(SESSION_ACTIVITY, String(this.platform.clock.now()));
  }

  private async sessionKey(): Promise<Uint8Array | null> {
    const [key, last] = await Promise.all([
      this.platform.session.get(SESSION_KEY),
      this.platform.session.get(SESSION_ACTIVITY),
    ]);
    if (key === null) return null;
    const idle = this.platform.clock.now() - Number(last ?? 0);
    if (!Number.isFinite(idle) || idle >= (await this.autoLockMs())) {
      await this.lock();
      return null;
    }
    return base64.decode(key);
  }

  private async requireKey(): Promise<Uint8Array> {
    const key = await this.sessionKey();
    if (!key) throw new VaultError("wallet is locked", "locked");
    await this.touch();
    return key;
  }
}

function checkPassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new VaultError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`, "weak-password");
  }
}

function aad(kdf: KdfParams): Uint8Array {
  return utf8.decode(`pearl-vault/v1/scrypt/${kdf.N}/${kdf.r}/${kdf.p}/${kdf.salt}`);
}

async function deriveKey(password: string, kdf: KdfParams): Promise<Uint8Array> {
  return scryptAsync(password.normalize("NFKC"), base64.decode(kdf.salt), {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    dkLen: 32,
  });
}
