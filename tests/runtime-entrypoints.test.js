const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const cjs = require("../dist/cjs/index.js");

async function verifyClient(t, connect) {
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "ssdiskdb-entrypoint-"));
  const db = await connect({ storagePath });
  t.after(async () => {
    await db.close();
    fs.rmSync(storagePath, { recursive: true, force: true });
  });
  await db.set("answer", { value: 42 });
  assert.deepEqual(await db.get("answer"), { value: 42 });
  assert.equal(await db.exists("answer"), true);
  await db.set("ttl", "alive", { ttl: 10_000 });
  assert.ok(await db.ttl("ttl") > 0);
  assert.equal(await db.del("answer"), 1);
  assert.equal(await db.get("answer"), undefined);
}

test("CommonJS entrypoint opens and operates on a database", async (t) => {
  assert.equal(cjs.default.connect, cjs.connect);
  await verifyClient(t, cjs.connect);
});

test("ES module entrypoint opens and operates on a database", async (t) => {
  const entry = path.resolve(__dirname, "../dist/esm/index.js");
  const esm = await import(pathToFileURL(entry).href);
  assert.equal(esm.default.connect, esm.connect);
  await verifyClient(t, esm.connect);
});
