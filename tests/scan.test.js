const test = require("node:test");
const assert = require("node:assert/strict");
const { openDb } = require("./helpers.cjs");

test("scan prefix limit cursor pagination has no duplicates or missing keys", async (t) => {
  const { db } = await openDb(t);

  const empty = await db.scan({ prefix: "none:", limit: 10 });
  assert.deepEqual(empty.entries, []);
  assert.equal(empty.cursor, null);

  const keys = [];
  for (let i = 0; i < 1000; i++) {
    const key = `item:${String(i).padStart(4, "0")}`;
    keys.push(key);
    await db.set(key, i);
  }
  await db.set("other:0", "skip");

  const seen = [];
  let cursor = undefined;
  let pages = 0;
  while (true) {
    const page = await db.scan({ prefix: "item:", limit: 100, cursor });
    pages += 1;
    for (const entry of page.entries) seen.push(entry.key);
    if (!page.cursor) break;
    cursor = page.cursor;
  }

  assert.equal(seen.length, 1000);
  assert.deepEqual([...new Set(seen)].sort(), keys.slice().sort());
  assert.ok(pages >= 10);
  assert.ok(seen.every((key) => key.startsWith("item:")));
  assert.equal(seen.includes("other:0"), false);

  const first = await db.scan({ prefix: "item:", limit: 3 });
  assert.equal(first.entries.length, 3);
  assert.ok(first.cursor);
  const second = await db.scan({ prefix: "item:", limit: 3, cursor: first.cursor });
  const overlap = first.entries.map((entry) => entry.key).filter((key) => second.entries.some((entry) => entry.key === key));
  assert.deepEqual(overlap, []);
});
