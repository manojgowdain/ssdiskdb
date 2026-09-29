const test = require("node:test");
const assert = require("node:assert/strict");
const { openDb } = require("./helpers.cjs");

test("mget mset mdelete and batch cover empty mixed TTL and duplicates", async (t) => {
  const { db } = await openDb(t);

  assert.equal(await db.mset([]), 0);
  assert.deepEqual(await db.mget([]), []);
  assert.equal(await db.mdelete([]), 0);
  assert.equal(await db.batch([]), 0);

  assert.equal(await db.mset([["one", 1]]), 1);
  assert.deepEqual(await db.mget(["one"]), [1]);

  const ten = Array.from({ length: 10 }, (_, i) => [`k${i}`, i]);
  assert.equal(await db.mset(ten), 10);
  assert.deepEqual(await db.mget(["k0", "missing", "k9"]), [0, undefined, 9]);

  const hundred = Array.from({ length: 100 }, (_, i) => ({ key: `n${i}`, value: i }));
  assert.equal(await db.mset(hundred), 100);
  assert.equal((await db.mget(["n0", "n99"]))[1], 99);

  assert.equal(await db.mset([["dup", "first"], ["dup", "second"]]), 1);
  assert.equal(await db.get("dup"), "second");

  assert.equal(await db.batch([
    { type: "set", key: "batch-ttl", value: "temp", ttl: 5000 },
    { type: "set", key: "batch-keep", value: "ok" },
    { type: "delete", key: "one" }
  ]), 3);
  assert.equal(await db.get("one"), undefined);
  assert.equal(await db.get("batch-keep"), "ok");
  assert.ok((await db.ttl("batch-ttl")) >= 0);

  await assert.rejects(db.batch([{ type: "nope", key: "x" }]), TypeError);
});
