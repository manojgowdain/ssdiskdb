const test = require("node:test");
const assert = require("node:assert/strict");
const { openDb } = require("./helpers.cjs");

test("sorted set member APIs zset zget zdel scores updates and deletion", async (t) => {
  const { db } = await openDb(t);

  assert.equal(await db.zget("rank", "missing"), undefined);
  await db.zset("rank", "a", 1);
  await db.zset("rank", "b", -2.5);
  await db.zset("rank", "c", 1);
  await db.zset("rank", "d", 3.75);
  assert.equal(await db.zget("rank", "a"), 1);
  assert.equal(await db.zget("rank", "b"), -2.5);
  assert.equal(await db.zget("rank", "c"), 1);
  assert.equal(await db.zget("rank", "d"), 3.75);

  await db.zset("rank", "a", 10);
  assert.equal(await db.zget("rank", "a"), 10);

  const members = ["a", "b", "c", "d"];
  const scores = [];
  for (const member of members) scores.push({ member, score: await db.zget("rank", member) });
  const ordered = scores.slice().sort((left, right) => left.score - right.score || left.member.localeCompare(right.member));
  assert.deepEqual(ordered.map((row) => row.member), ["b", "c", "d", "a"]);

  await db.zdel("rank", "c");
  assert.equal(await db.zget("rank", "c"), undefined);
  assert.equal(await db.zget("rank", "d"), 3.75);

  for (let i = 0; i < 200; i++) await db.zset("large", `m${i}`, i / 10);
  assert.equal(await db.zget("large", "m0"), 0);
  assert.equal(await db.zget("large", "m199"), 19.9);
});
