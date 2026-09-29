const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { connect } = require("../dist/cjs/index.js");

const sampleCount = Number(process.argv[2]) || 2000;
const percentile = (samples, p) => samples.slice().sort((a, b) => a - b)[Math.min(samples.length - 1, Math.floor(samples.length * p))];

async function main() {
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "ssdiskdb-grpc-benchmark-"));
  let local;
  let remote;
  try {
    local = await connect({ storagePath });
    const serverId = "benchmark-client";
    const apiKey = "benchmark-only-key";
    await local.db.put(`config:server:${serverId}`, JSON.stringify({ apiKey, status: "allowed" }));
    const address = await local.startGrpcServer({ host: "127.0.0.1", port: 0 });
    remote = await connect(`ssdiskdb+grpc://${apiKey}@${address}/${serverId}`);

    const measure = async (name, operation, operations = sampleCount) => {
      const samples = [];
      const cpuStart = process.cpuUsage();
      const rssBefore = process.memoryUsage().rss;
      const allStart = process.hrtime.bigint();
      for (let i = 0; i < operations; i++) {
        const start = process.hrtime.bigint();
        await operation(i);
        samples.push(Number(process.hrtime.bigint() - start) / 1e6);
      }
      const seconds = Number(process.hrtime.bigint() - allStart) / 1e9;
      const cpu = process.cpuUsage(cpuStart);
      console.log(JSON.stringify({ name, operations, opsPerSecond: Math.round(operations / seconds), averageMs: samples.reduce((sum, n) => sum + n, 0) / operations, p50Ms: percentile(samples, .5), p95Ms: percentile(samples, .95), p99Ms: percentile(samples, .99), rssDeltaBytes: process.memoryUsage().rss - rssBefore, cpuMs: (cpu.user + cpu.system) / 1000 }));
    };

    for (let i = 0; i < 100; i++) await remote.set(`warm:${i}`, i);
    await measure("grpc-set", (i) => remote.set(`set:${i}`, { i, text: "grpc benchmark" }));
    for (let i = 0; i < sampleCount; i++) await remote.set(`get:${i}`, { i, text: "grpc benchmark" });
    await measure("grpc-get", (i) => remote.get(`get:${i}`));
    await measure("grpc-ttl", (i) => remote.set(`ttl:${i}`, i, { ttl: 60_000 }));
    await measure("grpc-batch-100", (i) => remote.mset(Array.from({ length: 100 }, (_, j) => [`batch:${i}:${j}`, j])), Math.max(1, Math.floor(sampleCount / 100)));
    await measure("grpc-scan-page-100", () => remote.scan({ prefix: "get:", limit: 100 }), 20);
  } finally {
    if (remote) await remote.close();
    if (local) await local.close();
    fs.rmSync(storagePath, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
