const test = require("node:test");
const assert = require("node:assert/strict");
const { openDb } = require("./helpers.cjs");

test("SET GET DELETE EXISTS overwrite missing empty large and binary values", async (t) => {
  const { db } = await openDb(t);

  assert.equal(await db.get("missing"), undefined);
  assert.equal(await db.exists("missing"), false);
  assert.equal(await db.set("k", "v"), 1);
  assert.equal(await db.get("k"), "v");
  assert.equal(await db.exists("k"), true);
  await db.set("k", "v2");
  assert.equal(await db.get("k"), "v2");

  await db.set("empty", "");
  assert.equal(await db.get("empty"), "");

  const large = "x".repeat(256 * 1024);
  await db.set("large", large);
  assert.equal(await db.get("large"), large);

  const bytes = Buffer.from([0, 1, 2, 127, 128, 255]);
  await db.set("bin", bytes);
  assert.deepEqual(await db.get("bin"), bytes);

  assert.equal(await db.del("k"), 1);
  assert.equal(await db.get("k"), undefined);
  assert.equal(await db.exists("k"), false);
});
