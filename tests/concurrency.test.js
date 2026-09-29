const test = require("node:test");
const assert = require("node:assert/strict");
const { openDb } = require("./helpers.cjs");

test("concurrent GET SET DELETE EXPIRE and batch do not lose updates", async (t) => {
  const { db } = await openDb(t);
  const counts = process.env.SSDISKDB_LARGE_TESTS === "1"
    ? [10, 50, 100, 500]
    : [10, 50, 100];

  for (const n of counts) {
    await db.set("counter", 0);
    await Promise.all(Array.from({ length: n }, (_, i) => db.set(`c:${n}:${i}`, i)));
    const values = await Promise.all(Array.from({ length: n }, (_, i) => db.get(`c:${n}:${i}`)));
    assert.deepEqual(values, Array.from({ length: n }, (_, i) => i));

    await Promise.all(Array.from({ length: n }, (_, i) => db.set("shared", i)));
    const shared = await db.get("shared");
    assert.ok(shared >= 0 && shared < n);

    await Promise.all([
      ...Array.from({ length: Math.min(n, 40) }, (_, i) => db.set(`ttl:${i}`, i, { ttl: 10_000 })),
      ...Array.from({ length: Math.min(n, 40) }, (_, i) => db.expire(`ttl:${i}`, 20_000))
    ]);
    assert.ok((await db.ttl("ttl:0")) >= 0);

    await db.batch(Array.from({ length: Math.min(n, 80) }, (_, i) => ({ type: "set", key: `batch:${i}`, value: i })));
    await Promise.all(Array.from({ length: Math.min(n, 40) }, (_, i) => db.del(`c:${n}:${i}`)));
    assert.equal(await db.get(`c:${n}:0`), undefined);
  }
});
