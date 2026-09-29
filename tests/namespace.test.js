const test = require("node:test");
const assert = require("node:assert/strict");
const { scopedClient } = require("../dist/cjs/core/namespace.js");
const { openDb } = require("./helpers.cjs");

test("namespaces isolate the same logical key across tenants", async (t) => {
  const { db } = await openDb(t);
  const a = scopedClient(db, "namespace-a");
  const b = scopedClient(db, "namespace-b");

  await a.set("user:1", "from-a");
  await b.set("user:1", "from-b");
  assert.equal(await a.get("user:1"), "from-a");
  assert.equal(await b.get("user:1"), "from-b");
  assert.equal(await a.exists("user:1"), true);
  assert.equal(await db.get("user:1"), undefined);

  await a.set("ttl-key", "x", { ttl: 8_000 });
  assert.ok((await a.ttl("ttl-key")) >= 0);
  assert.equal(await b.ttl("ttl-key"), -2);

  await a.hset("profile", "role", "admin");
  assert.equal(await a.hget("profile", "role"), "admin");
  assert.equal(await b.hget("profile", "role"), undefined);

  await a.zset("scores", "m1", 2);
  assert.equal(await a.zget("scores", "m1"), 2);
  assert.equal(await b.zget("scores", "m1"), undefined);

  await a.mset([["batch-a", 1]]);
  await b.mset([["batch-a", 2]]);
  assert.deepEqual(await a.mget(["batch-a"]), [1]);
  assert.deepEqual(await b.mget(["batch-a"]), [2]);

  const scanned = await a.scan({ prefix: "user:", limit: 10 });
  assert.equal(scanned.entries.some((entry) => entry.value === "from-a"), true);
  assert.equal(scanned.entries.some((entry) => entry.value === "from-b"), false);

  await a.del("user:1");
  assert.equal(await a.get("user:1"), undefined);
  assert.equal(await b.get("user:1"), "from-b");
});
