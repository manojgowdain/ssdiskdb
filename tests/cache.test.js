const test = require("node:test");
const assert = require("node:assert/strict");
const { openDb } = require("./helpers.cjs");

test("cache hits misses invalidation expire persist flush and disabled mode", async (t) => {
  const { db } = await openDb(t, { cache: { enabled: true, maxEntries: 2, ttl: 5_000 } });

  await db.set("a", "old");
  assert.equal(await db.get("a"), "old");
  assert.equal(await db.get("a"), "old");
  const afterHit = await db.stats();
  assert.ok(afterHit.cacheHits >= 1);

  await db.set("a", "new");
  assert.equal(await db.get("a"), "new");

  await db.set("b", "b");
  await db.set("c", "c");
  assert.equal(await db.get("c"), "c");

  await db.del("a");
  assert.equal(await db.get("a"), undefined);

  await db.set("ttl", "soon", { ttl: 50 });
  assert.equal(await db.get("ttl"), "soon");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(await db.get("ttl"), undefined);

  await db.set("persist-me", "x", { ttl: 10_000 });
  assert.equal(await db.get("persist-me"), "x");
  await db.persist("persist-me");
  assert.equal(await db.get("persist-me"), "x");
  assert.equal(await db.ttl("persist-me"), -1);

  await db.set("flush-me", "y");
  assert.equal(await db.get("flush-me"), "y");
  await db.flush();
  assert.equal(await db.get("flush-me"), undefined);
});

test("disabled cache still returns the newest value", async (t) => {
  const { db } = await openDb(t);
  await db.set("k", "1");
  await db.set("k", "2");
  assert.equal(await db.get("k"), "2");
  assert.equal((await db.stats()).cacheHits, 0);
});
