const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { connect } = require("../dist/cjs/index.js");

const sampleCount = Number(process.argv[2]) || 4000;
const percentile = (samples, p) =>
  samples.slice().sort((a, b) => a - b)[Math.min(samples.length - 1, Math.floor(samples.length * p))];

async function main() {
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "ssdiskdb-benchmark-"));
  let db;
  try {
    db = await connect({ storagePath });
    const measure = async (name, operation, operations = sampleCount) => {
      const samples = [];
      const cpuStart = process.cpuUsage();
      const memoryBefore = process.memoryUsage().rss;
      const start = process.hrtime.bigint();
      for (let i = 0; i < operations; i++) {
        const operationStart = process.hrtime.bigint();
        await operation(i);
        samples.push(Number(process.hrtime.bigint() - operationStart) / 1e6);
      }
      const elapsedSeconds = Number(process.hrtime.bigint() - start) / 1e9;
      const cpu = process.cpuUsage(cpuStart);
      console.log(JSON.stringify({
        name,
        operations,
        opsPerSecond: Math.round(operations / elapsedSeconds),
        averageMs: samples.reduce((sum, value) => sum + value, 0) / operations,
        p50Ms: percentile(samples, 0.5),
        p95Ms: percentile(samples, 0.95),
        p99Ms: percentile(samples, 0.99),
        rssDeltaBytes: process.memoryUsage().rss - memoryBefore,
        cpuMs: (cpu.user + cpu.system) / 1000
      }));
    };

    for (let i = 0; i < 500; i++) await db.set(`warm:${i}`, i);
    await measure("set-object", (i) => db.set(`set:${i}`, { i, label: "benchmark" }));
    for (let i = 0; i < sampleCount; i++) await db.set(`get:${i}`, { i, label: "benchmark" });
    await measure("get-object", (i) => db.get(`get:${i}`));
    await measure("exists", (i) => db.exists(`get:${i}`));
    await measure("set-sequential-reference", (i) => db.set(`batch:${i}`, i));
    await measure("delete", (i) => db.del(`get:${i}`));
    const batchCount = Math.max(1, Math.floor(sampleCount / 100));
    await measure("mset-100", (i) => db.mset(Array.from({ length: 100 }, (_, j) => [`mset:${i}:${j}`, j])), batchCount);
    await measure("mget-100", (i) => db.mget(Array.from({ length: 100 }, (_, j) => `mset:${i}:${j}`)), batchCount);
    await measure("mdelete-100", (i) => db.mdelete(Array.from({ length: 100 }, (_, j) => `mset:${i}:${j}`)), batchCount);
    await measure("batch-100", (i) => db.batch(Array.from({ length: 100 }, (_, j) => ({ type: "set", key: `batch:${i}:${j}`, value: j }))), batchCount);
    await measure("ttl-set", (i) => db.set(`ttl:${i}`, i, { ttl: 60_000 }));
    await measure("ttl-read", (i) => db.ttl(`ttl:${i}`));
    await measure("expire-persist", async (i) => { await db.expire(`ttl:${i}`, 60_000); await db.persist(`ttl:${i}`); });
    await measure("scan-page-100", () => db.scan({ prefix: "get:", limit: 100 }), 20);
    await measure("hash-get", async (i) => {
      await db.hset("hash", String(i), i);
      return db.hget("hash", String(i));
    });
    await measure("sorted-set-get", async (i) => {
      await db.zset("scores", String(i), i / 10);
      return db.zget("scores", String(i));
    });
  } finally {
    if (db) await db.close();
    fs.rmSync(storagePath, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
