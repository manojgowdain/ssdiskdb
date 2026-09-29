const test = require("node:test");
const assert = require("node:assert/strict");
const { connect, tempDir } = require("./helpers.cjs");
const fs = require("node:fs");

test("closing and reopening the database preserves strings TTL hash sorted set and namespaces", async () => {
  const storagePath = tempDir("ssdiskdb-crash-");
  try {
    let db = await connect({ storagePath, encryptionKey: "crash-key" });
    await db.set("plain", "saved");
    await db.set("ttl", "later", { ttl: 30_000 });
    await db.hset("hash", "field", "hvalue");
    await db.zset("z", "m", 9);
    const { scopedClient } = require("../dist/cjs/core/namespace.js");
    const scoped = scopedClient(db, "tenant");
    await scoped.set("user:1", "isolated");
    await db.close();

    db = await connect({ storagePath, encryptionKey: "crash-key" });
    try {
      assert.equal(await db.get("plain"), "saved");
      assert.equal(await db.get("ttl"), "later");
      assert.ok((await db.ttl("ttl")) >= 0);
      assert.equal(await db.hget("hash", "field"), "hvalue");
      assert.equal(await db.zget("z", "m"), 9);
      assert.equal(await scopedClient(db, "tenant").get("user:1"), "isolated");
      assert.equal(await db.get("user:1"), undefined);
    } finally {
      await db.close();
    }
  } finally {
    fs.rmSync(storagePath, { recursive: true, force: true });
  }
});
