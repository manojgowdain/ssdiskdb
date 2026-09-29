const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { connect, tempDir } = require("./helpers.cjs");

test("TTL EXPIRE PERSIST sentinels overwrite and invalid values", async (t) => {
  const { db } = await openDb(t, { ttl: { cleanupInterval: 50, cleanupBatchSize: 16 } });

  assert.equal(await db.ttl("missing"), -2);
  await db.set("permanent", "keep");
  assert.equal(await db.ttl("permanent"), -1);
  assert.equal(await db.persist("permanent"), false);

  await db.set("session", "alive", { ttl: 5000 });
  const remaining = await db.ttl("session");
  assert.ok(remaining >= 0);
  assert.equal(await db.get("session"), "alive");
  assert.equal(await db.exists("session"), true);

  await db.expire("permanent", 8000);
  assert.ok((await db.ttl("permanent")) >= 0);
  assert.equal(await db.persist("permanent"), true);
  assert.equal(await db.ttl("permanent"), -1);

  await db.set("replaced", "old", { ttl: 60_000 });
  await db.set("replaced", "new");
  assert.equal(await db.get("replaced"), "new");
  assert.equal(await db.ttl("replaced"), -1);

  await db.set("zero", "gone", { ttl: 0 });
  assert.equal(await db.get("zero"), undefined);
  assert.equal(await db.exists("zero"), false);
  assert.equal(await db.ttl("zero"), -2);

  await assert.rejects(db.set("neg", "x", { ttl: -1 }), RangeError);
  await assert.rejects(db.expire("permanent", -5), RangeError);

  await db.set("soon", "x", { ttl: 40 });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(await db.get("soon"), undefined);
  assert.equal(await db.exists("soon"), false);
  assert.equal(await db.ttl("soon"), -2);
});

test("TTL metadata persists across a process restart then expires", async () => {
  const storagePath = tempDir("ssdiskdb-ttl-restart-");
  const root = path.resolve(__dirname, "..");
  const writer = `
    const { connect } = require(${JSON.stringify(path.join(root, "dist/cjs/index.js"))});
    (async () => {
      const db = await connect({ storagePath: ${JSON.stringify(storagePath)} });
      await db.set("restart", "value", { ttl: 2500 });
      const ttl = await db.ttl("restart");
      if (!(ttl >= 0)) throw new Error("writer did not store a remaining TTL");
      await db.close();
    })().catch((error) => { console.error(error); process.exit(1); });
  `;
  try {
    const wrote = spawnSync(process.execPath, ["-e", writer], { encoding: "utf8" });
    assert.equal(wrote.status, 0, wrote.stderr || wrote.stdout);

    const db = await connect({ storagePath, ttl: { cleanupInterval: 40, cleanupBatchSize: 8 } });
    try {
      assert.equal(await db.get("restart"), "value");
      assert.ok((await db.ttl("restart")) >= 0);
      await new Promise((resolve) => setTimeout(resolve, 2700));
      assert.equal(await db.get("restart"), undefined);
      assert.equal(await db.exists("restart"), false);
      assert.equal(await db.ttl("restart"), -2);
    } finally {
      await db.close();
    }
  } finally {
    fs.rmSync(storagePath, { recursive: true, force: true });
  }
});

test("TTL cleanup removes 1000 expired records without corrupting live keys", async (t) => {
  const { db, storagePath } = await openDb(t, { ttl: { cleanupInterval: 20, cleanupBatchSize: 64 } });
  for (let i = 0; i < 1000; i++) await db.set(`expire:${i}`, i, { ttl: 30 });
  await db.set("live", "keep", { ttl: 30_000 });
  await db.set("forever", "ok");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await db.get("expire:0") === undefined && await db.get("expire:999") === undefined) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(await db.get("expire:0"), undefined);
  assert.equal(await db.get("expire:999"), undefined);
  assert.equal(await db.get("live"), "keep");
  assert.equal(await db.get("forever"), "ok");
  assert.equal(await db.set("after-cleanup", 1), 1);
  assert.equal(await db.get("after-cleanup"), 1);

  const index = [];
  for await (const key of db.db.keys({ gte: "ttl/", lt: "ttl0" })) index.push(String(key));
  assert.equal(index.some((key) => key.includes("s:expire:")), false);
  assert.ok(index.some((key) => key.endsWith("s:live")));
  assert.equal(typeof storagePath, "string");
});
