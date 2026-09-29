const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { connect, tempDir } = require("./helpers.cjs");

test("encryption round-trips SET GET DELETE TTL batch hash sorted set and rejects wrong or missing keys", async () => {
  const storagePath = tempDir("ssdiskdb-enc-");
  const db = await connect({ storagePath, encryptionKey: "correct-test-key" });
  try {
    await db.set("secret", { token: "hidden" });
    assert.deepEqual(await db.get("secret"), { token: "hidden" });
    await db.set("ttl", "alive", { ttl: 8_000 });
    assert.ok((await db.ttl("ttl")) >= 0);
    await db.mset([{ key: "bulk", value: "enc", ttl: 8_000 }]);
    assert.equal(await db.get("bulk"), "enc");
    await db.hset("h", "f", "hv");
    assert.equal(await db.hget("h", "f"), "hv");
    await db.zset("z", "m", 1.25);
    assert.equal(await db.zget("z", "m"), 1.25);
    await db.del("secret");
    assert.equal(await db.get("secret"), undefined);
    await db.set("still-there", "yes");
  } finally {
    await db.close();
  }

  const missing = await connect({ storagePath });
  try {
    await assert.rejects(missing.get("still-there"), /Encryption key is required/);
  } finally {
    await missing.close();
  }

  const wrong = await connect({ storagePath, encryptionKey: "wrong-test-key" });
  try {
    await assert.rejects(wrong.get("still-there"), /Decryption failed/);
  } finally {
    await wrong.close();
    fs.rmSync(storagePath, { recursive: true, force: true });
  }
});
