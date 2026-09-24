import { describe, it, expect } from "vitest";
import { DEFAULT_AUTO_LOCK_MS, migrateContents, Vault, VaultError, type VaultContents } from "../src/vault/vault.js";
import { memoryPlatform } from "./memory-platform.js";

// Tiny scrypt cost so the suite stays fast; the default is exercised in production.
const FAST = { N: 2 ** 10, r: 8, p: 1 };
const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const contents = (): VaultContents => ({
  schema: 2,
  seeds: [{ id: "s1", mnemonic: PHRASE, createdAt: 1 }],
  wallets: [{ id: "w1", name: "Main wallet", color: "teal", source: { kind: "seed", seedId: "s1", account: 0 }, createdAt: 1 }],
});

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "resolved";
  } catch (e) {
    return e instanceof VaultError ? e.code : String(e);
  }
};

describe("Vault", () => {
  it("creates unlocked and reads back what it stored", async () => {
    const { platform } = memoryPlatform();
    const v = new Vault(platform, { kdf: FAST });
    await v.create("correct-horse-battery", contents());
    expect(await v.isUnlocked()).toBe(true);
    expect((await v.read()).seeds[0]!.mnemonic).toBe(PHRASE);
  });

  it("never writes the phrase or the password to disk", async () => {
    const { platform, storage } = memoryPlatform();
    await new Vault(platform, { kdf: FAST }).create("correct-horse-battery", contents());
    const disk = [...storage.data.values()].join("");
    expect(disk).not.toContain("abandon");
    expect(disk).not.toContain("correct-horse");
  });

  it("rejects a wrong password and a short one", async () => {
    const { platform } = memoryPlatform();
    const v = new Vault(platform, { kdf: FAST });
    expect(await code(v.create("short", contents()))).toBe("weak-password");
    await v.create("correct-horse-battery", contents());
    await v.lock();
    expect(await code(v.unlock("wrong-password-here"))).toBe("wrong-password");
    await v.unlock("correct-horse-battery");
    expect(await v.isUnlocked()).toBe(true);
  });

  it("refuses to overwrite an existing vault", async () => {
    const { platform } = memoryPlatform();
    const v = new Vault(platform, { kdf: FAST });
    await v.create("correct-horse-battery", contents());
    expect(await code(v.create("another-password", { schema: 2, seeds: [], wallets: [] }))).toBe("exists");
  });

  it("locks itself after 15 idle minutes, and activity pushes that back", async () => {
    const { platform, session, advance } = memoryPlatform();
    const v = new Vault(platform, { kdf: FAST });
    await v.create("correct-horse-battery", contents());

    advance(DEFAULT_AUTO_LOCK_MS - 1000);
    await v.read(); // activity
    advance(DEFAULT_AUTO_LOCK_MS - 1000);
    expect(await v.isUnlocked()).toBe(true);

    advance(1000);
    expect(await v.isUnlocked()).toBe(false);
    expect(await code(v.read())).toBe("locked");
    // The key is actually gone, not just reported as locked.
    expect(session.data.size).toBe(0);
  });

  it("does not count a quiet read as activity, so a refresh timer cannot hold it open", async () => {
    const { platform, advance } = memoryPlatform();
    const v = new Vault(platform, { kdf: FAST });
    await v.create("correct-horse-battery", contents());

    // A timer reading every two minutes for longer than the lock window.
    for (let t = 0; t < DEFAULT_AUTO_LOCK_MS - 120_000; t += 120_000) {
      advance(120_000);
      await v.quietly(() => v.read());
    }
    advance(120_000);
    expect(await v.isUnlocked()).toBe(false);
    // And once past its time, a quiet read is refused like any other.
    expect(await code(v.quietly(() => v.read()))).toBe("locked");
  });

  it("applies a changed auto-lock setting immediately", async () => {
    const { platform, advance } = memoryPlatform();
    let minutes = 15;
    const v = new Vault(platform, { kdf: FAST, autoLockMs: () => minutes * 60_000 });
    await v.create("correct-horse-battery", contents());
    advance(2 * 60_000);
    expect(await v.isUnlocked()).toBe(true);
    minutes = 1;
    expect(await v.isUnlocked()).toBe(false);
  });

  it("detects tampering with the stored KDF parameters", async () => {
    const { platform, storage } = memoryPlatform();
    const v = new Vault(platform, { kdf: FAST });
    await v.create("correct-horse-battery", contents());
    const file = JSON.parse(storage.data.get("vault.v1")!);
    file.kdf.r = 1;
    storage.data.set("vault.v1", JSON.stringify(file));
    await v.lock();
    expect(await code(v.unlock("correct-horse-battery"))).toBe("wrong-password");
  });

  it("changes the password only with the old one, even while unlocked", async () => {
    const { platform } = memoryPlatform();
    const v = new Vault(platform, { kdf: FAST });
    await v.create("correct-horse-battery", contents());
    expect(await code(v.changePassword("not-the-password", "new-password-123"))).toBe("wrong-password");
    await v.changePassword("correct-horse-battery", "new-password-123");
    await v.lock();
    expect(await code(v.unlock("correct-horse-battery"))).toBe("wrong-password");
    await v.unlock("new-password-123");
    expect((await v.read()).wallets).toHaveLength(1);
  });

  it("destroy removes the vault and the session, and allows a new one", async () => {
    const { platform, storage, session } = memoryPlatform();
    const v = new Vault(platform, { kdf: FAST });
    await v.create("correct-horse-battery", contents());
    await v.destroy();
    expect(await v.exists()).toBe(false);
    expect(storage.data.size).toBe(0);
    expect(session.data.size).toBe(0);
    await v.create("another-password", { schema: 2, seeds: [], wallets: [] });
    expect(await v.exists()).toBe(true);
  });

  it("migrates schema 1 contents (one mnemonic per wallet) to seeds + wallets", () => {
    const m = migrateContents({ wallets: [{ id: "abc", name: "Main wallet", mnemonic: PHRASE, createdAt: 7 }] });
    expect(m.schema).toBe(2);
    expect(m.seeds).toEqual([{ id: "seed-abc", mnemonic: PHRASE, createdAt: 7 }]);
    // Same wallet id, so settings stored per wallet carry over.
    expect(m.wallets[0]).toMatchObject({ id: "abc", name: "Main wallet", source: { kind: "seed", seedId: "seed-abc", account: 0 } });
    expect(() => migrateContents({ nonsense: true })).toThrow(VaultError);
  });

  it("re-encrypts with a fresh nonce on every write", async () => {
    const { platform, storage } = memoryPlatform();
    const v = new Vault(platform, { kdf: FAST });
    await v.create("correct-horse-battery", contents());
    const before = JSON.parse(storage.data.get("vault.v1")!).nonce;
    const c = contents();
    await v.write({ ...c, wallets: [...c.wallets, { id: "w2", name: "Mining", color: "amber", source: { kind: "seed", seedId: "s1", account: 1 }, createdAt: 2 }] });
    expect(JSON.parse(storage.data.get("vault.v1")!).nonce).not.toBe(before);
    expect((await v.read()).wallets.map((w) => w.name)).toEqual(["Main wallet", "Mining"]);
  });

  it("makes a run of wrong passwords wait, and forgets it after a good one", async () => {
    const { platform, advance } = memoryPlatform();
    const v = new Vault(platform, { kdf: FAST });
    await v.create("correct-horse-battery", contents());
    await v.lock();

    // The first few mistypes are free: people fumble their own password.
    for (let i = 0; i < 3; i++) {
      await expect(v.unlock("wrong")).rejects.toMatchObject({ code: "wrong-password" });
    }
    await expect(v.unlock("wrong")).rejects.toMatchObject({ code: "wrong-password" });
    // Now it is throttled, and says so rather than pretending the password is wrong.
    await expect(v.unlock("correct-horse-battery")).rejects.toMatchObject({ code: "throttled" });

    advance(5_000);
    await v.unlock("correct-horse-battery");
    expect(await v.isUnlocked()).toBe(true);

    // A good password wipes the record, so the next mistake starts over.
    await v.lock();
    await expect(v.unlock("wrong")).rejects.toMatchObject({ code: "wrong-password" });
    await v.unlock("correct-horse-battery");
    expect(await v.isUnlocked()).toBe(true);
  });

  it("does not treat asking whether it is unlocked as activity", async () => {
    // A window that polls "are we still unlocked?" must not hold the wallet
    // open by asking. Reading the vault is activity; checking is not.
    const { platform, advance } = memoryPlatform();
    const v = new Vault(platform, { kdf: FAST, autoLockMs: 60_000 });
    await v.create("correct-horse-battery", contents());

    for (let i = 0; i < 5; i++) {
      advance(20_000);
      await v.isUnlocked();
    }
    expect(await v.isUnlocked()).toBe(false);
  });

  it("still counts reading the vault as activity", async () => {
    const { platform, advance } = memoryPlatform();
    const v = new Vault(platform, { kdf: FAST, autoLockMs: 60_000 });
    await v.create("correct-horse-battery", contents());

    for (let i = 0; i < 5; i++) {
      advance(20_000);
      await v.read();
    }
    expect(await v.isUnlocked()).toBe(true);
  });
});
