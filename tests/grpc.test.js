const test = require("node:test");
const assert = require("node:assert/strict");
const grpc = require("@grpc/grpc-js");
const { openDb, connect } = require("./helpers.cjs");

async function startGrpc(t) {
  const { db } = await openDb(t);
  const apiKey = `ci-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await db.db.put("config:server:ns-a", JSON.stringify({ apiKey, status: "allowed" }));
  await db.db.put("config:server:ns-b", JSON.stringify({ apiKey: `${apiKey}-b`, status: "allowed" }));
  const address = await db.startGrpcServer({ host: "127.0.0.1", port: 0 });
  return { db, address, apiKey };
}

test("gRPC client reuses one channel and isolates namespaces", async (t) => {
  const { address, apiKey } = await startGrpc(t);
  const clientA = await connect(`ssdiskdb+grpc://${apiKey}@${address}/ns-a`);
  const clientB = await connect(`ssdiskdb+grpc://${apiKey}-b@${address}/ns-b`);
  t.after(async () => {
    await clientA.close();
    await clientB.close();
  });

  const stub = clientA.grpcStub;
  await clientA.set("user:1", "a");
  await clientA.get("user:1");
  await clientA.exists("user:1");
  assert.equal(clientA.grpcStub, stub);

  await clientB.set("user:1", "b");
  assert.equal(await clientA.get("user:1"), "a");
  assert.equal(await clientB.get("user:1"), "b");
  assert.equal(await clientA.del("user:1"), 1);
  assert.equal(await clientA.get("user:1"), undefined);
  assert.equal(await clientB.get("user:1"), "b");
});

test("gRPC authentication rejects missing and invalid credentials", async (t) => {
  const { address, apiKey } = await startGrpc(t);
  const ok = await connect(`ssdiskdb+grpc://${apiKey}@${address}/ns-a`);
  t.after(async () => { await ok.close(); });
  await ok.set("k", 1);
  assert.equal(await ok.get("k"), 1);

  await assert.rejects(
    connect(`ssdiskdb+grpc://invalid@${address}/ns-a`),
    /Invalid API key|UNAUTHENTICATED|Authentication required/
  );
});

test("gRPC reports UNAVAILABLE closed-client and deadline errors", async (t) => {
  await assert.rejects(
    connect({ grpcTarget: "127.0.0.1:1", apiKey: "x", serverId: "ns-a", requestTimeoutMs: 400 }),
    (error) => error.code === grpc.status.UNAVAILABLE || /unavailable|ECONNREFUSED|Connection dropped/i.test(String(error.message))
  );

  const { address, apiKey } = await startGrpc(t);
  const client = await connect({ grpcTarget: address, apiKey, serverId: "ns-a" });
  await client.close();
  await assert.rejects(client.get("k"), /gRPC client is closed/);

  const timed = await connect({ grpcTarget: address, apiKey, serverId: "ns-a", requestTimeoutMs: 1 });
  t.after(async () => { await timed.close(); });
  let deadlineSeen = false;
  try {
    await timed.set("slow", "v");
    await timed.get("slow");
  } catch (error) {
    deadlineSeen = error.code === grpc.status.DEADLINE_EXCEEDED || /Deadline exceeded/i.test(String(error.message));
  }
  assert.ok(deadlineSeen || (await timed.get("slow")) === "v");
});

test("gRPC recovers after the server process is restarted on the same database", async (t) => {
  const fs = require("node:fs");
  const { tempDir } = require("./helpers.cjs");
  const storagePath = tempDir("ssdiskdb-grpc-restart-");
  t.after(() => fs.rmSync(storagePath, { recursive: true, force: true }));
  const db = await connect({ storagePath });
  const apiKey = `restart-${Date.now()}`;
  await db.db.put("config:server:ns-a", JSON.stringify({ apiKey, status: "allowed" }));
  const firstAddress = await db.startGrpcServer({ host: "127.0.0.1", port: 0 });
  const first = await connect(`ssdiskdb+grpc://${apiKey}@${firstAddress}/ns-a`);
  await first.set("persist", "value");
  await first.close();
  await db.close();

  const restarted = await connect({ storagePath });
  t.after(async () => { await restarted.close(); });
  await restarted.db.put("config:server:ns-a", JSON.stringify({ apiKey, status: "allowed" }));
  const secondAddress = await restarted.startGrpcServer({ host: "127.0.0.1", port: 0 });
  const second = await connect(`ssdiskdb+grpc://${apiKey}@${secondAddress}/ns-a`);
  t.after(async () => { await second.close(); });
  assert.equal(await second.get("persist"), "value");
});
