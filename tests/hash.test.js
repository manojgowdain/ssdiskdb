const test = require("node:test");
const assert = require("node:assert/strict");
const { openDb } = require("./helpers.cjs");

test("hash field APIs hset hget hdel overwrite missing large and concurrent writes", async (t) => {
  const { db } = await openDb(t);

  assert.equal(await db.hget("users", "missing"), undefined);
  await db.hset("users", "name", "ada");
  assert.equal(await db.hget("users", "name"), "ada");
  await db.hset("users", "name", "grace");
  assert.equal(await db.hget("users", "name"), "grace");
  await db.hset("users", "city", "paris");
  assert.equal(await db.hget("users", "city"), "paris");
  await db.hdel("users", "city");
  assert.equal(await db.hget("users", "city"), undefined);
  assert.equal(await db.hget("users", "name"), "grace");

  const large = { blob: "y".repeat(64 * 1024) };
  await db.hset("users", "blob", large);
  assert.deepEqual(await db.hget("users", "blob"), large);

  await Promise.all(Array.from({ length: 50 }, (_, i) => db.hset("concurrent", `f${i}`, i)));
  assert.equal(await db.hget("concurrent", "f0"), 0);
  assert.equal(await db.hget("concurrent", "f49"), 49);

  await db.hset("ttl-hash", "field", "soon", { ttl: 40 });
  assert.equal(await db.hget("ttl-hash", "field"), "soon");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(await db.hget("ttl-hash", "field"), undefined);
});
