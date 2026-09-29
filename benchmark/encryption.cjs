const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { connect } = require("../dist/cjs/index.js");

const samples = Number(process.argv[2]) || 100;
const percentile = (values, p) => values.slice().sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];

async function main() {
  const paths = [
    fs.mkdtempSync(path.join(os.tmpdir(), "ssdiskdb-plain-bench-")),
    fs.mkdtempSync(path.join(os.tmpdir(), "ssdiskdb-encrypted-bench-"))
  ];
  let clients = [];
  try {
    clients = [await connect({ storagePath: paths[0] }), await connect({ storagePath: paths[1], encryptionKey: "benchmark-only-secret" })];
    for (const size of [32, 128, 1024, 4096, 16384, 65536, 1048576]) {
      const payload = Buffer.alloc(size, 0x61);
      for (let clientIndex = 0; clientIndex < clients.length; clientIndex++) {
        const client = clients[clientIndex];
        const encryption = clientIndex === 1 ? "encrypted" : "plain";
        const key = `${encryption}:${size}`;
        await client.set(key, payload);
        for (const operation of ["set", "get"]) {
          const latency = [];
          const cpuStart = process.cpuUsage();
          const rssBefore = process.memoryUsage().rss;
          const start = process.hrtime.bigint();
          for (let i = 0; i < samples; i++) {
            const oneStart = process.hrtime.bigint();
            if (operation === "set") await client.set(key, payload);
            else await client.get(key);
            latency.push(Number(process.hrtime.bigint() - oneStart) / 1e6);
          }
          const seconds = Number(process.hrtime.bigint() - start) / 1e9;
          const cpu = process.cpuUsage(cpuStart);
          console.log(JSON.stringify({ name: `${encryption}-${operation}`, payloadBytes: size, operations: samples, opsPerSecond: Math.round(samples / seconds), p50Ms: percentile(latency, .5), p95Ms: percentile(latency, .95), p99Ms: percentile(latency, .99), rssDeltaBytes: process.memoryUsage().rss - rssBefore, cpuMs: (cpu.user + cpu.system) / 1000 }));
        }
      }
    }
  } finally {
    for (const client of clients) await client.close();
    for (const storagePath of paths) fs.rmSync(storagePath, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
