const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { connect } = require("./dist/cjs/index.js");

test("persistent TTL is part of the public database API", async (t) => {
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "ssdiskdb-ttl-"));
  let db = await connect({ storagePath, ttl: { cleanupInterval: 25, cleanupBatchSize: 2 } });
  t.after(async () => {
    if (db) await db.close();
    fs.rmSync(storagePath, { recursive: true, force: true });
  });

  await db.set("ttl:session", { userId: 123 }, { ttl: 1200 });
  assert.deepEqual(await db.get("ttl:session"), { userId: 123 });
  assert.equal(await db.ttl("ttl:session") >= 0, true);
  assert.equal(await db.ttl("missing"), -2);
  await assert.rejects(db.set("ttl:negative", "invalid", { ttl: -1 }), RangeError);
  await db.set("ttl:zero", "gone", { ttl: 0 });
  assert.equal(await db.get("ttl:zero"), undefined);

  await db.set("ttl:permanent", "value");
  assert.equal(await db.ttl("ttl:permanent"), -1);
  await db.expire("ttl:permanent", 5000);
  assert.equal(await db.ttl("ttl:permanent") >= 0, true);
  await db.persist("ttl:permanent");
  assert.equal(await db.ttl("ttl:permanent"), -1);
  await db.set("ttl:replacement", "old", { ttl: 40 });
  await db.set("ttl:replacement", "new");
  assert.equal(await db.ttl("ttl:replacement"), -1);
  assert.equal(await db.get("ttl:replacement"), "new");

  await db.hset("session", "field", "hash value", { ttl: 150 });
  assert.equal(await db.hget("session", "field"), "hash value");
  await db.zset("rank", "member", 1.5, { ttl: 150 });
  assert.equal(await db.zget("rank", "member"), 1.5);
  for (let i = 0; i < 20; i++) await db.set(`ttl:cleanup:${i}`, i, { ttl: 40 });
  await db.set("ttl:cleanup:live", "keep", { ttl: 5000 });

  await db.close();
  db = await connect({ storagePath, ttl: { cleanupInterval: 25, cleanupBatchSize: 2 } });
  assert.deepEqual(await db.get("ttl:session"), { userId: 123 });
  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.equal(await db.db.get("s:ttl:cleanup:0"), undefined);
  assert.equal(await db.get("ttl:cleanup:live"), "keep");
  const remainingTtlIndex = [];
  for await (const key of db.db.keys({ gte: "ttl/", lt: "ttl0" })) remainingTtlIndex.push(key);
  assert.equal(remainingTtlIndex.length, 1);
  assert.ok(remainingTtlIndex[0].endsWith("s:ttl:cleanup:live"));
  assert.equal(await db.get("ttl:session"), undefined);
  assert.equal(await db.exists("ttl:session"), false);
  assert.equal(await db.ttl("ttl:session"), -2);
  assert.equal(await db.hget("session", "field"), undefined);
  assert.equal(await db.zget("rank", "member"), undefined);
});

test("bulk operations and prefix scans use the public client", async (t) => {
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "ssdiskdb-bulk-"));
  const db = await connect({ storagePath });
  t.after(async () => {
    await db.close();
    fs.rmSync(storagePath, { recursive: true, force: true });
  });

  await db.mset([["user:1", { id: 1 }], ["user:2", { id: 2 }], ["other:1", "skip"]]);
  assert.deepEqual(await db.mget(["user:2", "missing", "user:1"]), [{ id: 2 }, undefined, { id: 1 }]);
  const first = await db.scan({ prefix: "user:", limit: 1 });
  assert.equal(first.entries.length, 1);
  assert.equal(first.entries[0].key, "user:1");
  assert.ok(first.cursor);
  const second = await db.scan({ prefix: "user:", limit: 1, cursor: first.cursor });
  assert.deepEqual(second.entries, [{ key: "user:2", value: { id: 2 } }]);
  assert.equal(second.cursor, null);

  await db.batch([
    { type: "set", key: "user:3", value: { id: 3 }, ttl: 5000 },
    { type: "delete", key: "user:1" }
  ]);
  assert.deepEqual(await db.mget(["user:1", "user:3"]), [undefined, { id: 3 }]);
  await db.mdelete(["user:2", "user:3"]);
  assert.deepEqual(await db.mget(["user:1", "user:2", "user:3"]), [undefined, undefined, undefined]);
});

test("binary values round-trip and legacy JSON records remain readable", async (t) => {
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "ssdiskdb-codec-"));
  const { Level } = require("level");
  const legacy = new Level(storagePath);
  await legacy.open();
  await legacy.put("s:legacy", JSON.stringify({ old: true }));
  await legacy.close();

  const db = await connect({ storagePath });
  t.after(async () => {
    await db.close();
    fs.rmSync(storagePath, { recursive: true, force: true });
  });

  const bytes = Buffer.from([0, 1, 2, 127, 128, 255]);
  await db.set("binary", bytes);
  assert.deepEqual(await db.get("binary"), bytes);

  const encryptedPath = fs.mkdtempSync(path.join(os.tmpdir(), "ssdiskdb-binary-encrypted-"));
  const encrypted = await connect({ storagePath: encryptedPath, encryptionKey: "binary-key" });
  t.after(async () => {
    await encrypted.close();
    fs.rmSync(encryptedPath, { recursive: true, force: true });
  });
  await encrypted.set("binary", bytes);
  assert.deepEqual(await encrypted.get("binary"), bytes);
  assert.deepEqual(await db.get("legacy"), { old: true });
});

test("bounded cache invalidates writes and never serves expired records", async (t) => {
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "ssdiskdb-cache-"));
  const db = await connect({ storagePath, cache: { enabled: true, maxEntries: 1, ttl: 100 } });
  t.after(async () => {
    await db.close();
    fs.rmSync(storagePath, { recursive: true, force: true });
  });

  await db.set("cached", "old");
  assert.equal(await db.get("cached"), "old");
  assert.equal(await db.get("cached"), "old");
  assert.equal((await db.stats()).cacheHits, 1);
  await db.set("cached", "new");
  assert.equal(await db.get("cached"), "new");
  await db.del("cached");
  assert.equal(await db.get("cached"), undefined);

  await db.set("expires", "soon", { ttl: 80 });
  assert.equal(await db.get("expires"), "soon");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await db.get("expires"), undefined);
});

test("namespace flush removes its data, TTL index, and cache entries", async (t) => {
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "ssdiskdb-namespace-cache-"));
  const db = await connect({ storagePath, cache: { enabled: true, maxEntries: 20 } });
  const scoped = require("./dist/cjs/core/namespace.js").scopedClient(db, "tenant-a");
  t.after(async () => {
    await db.close();
    fs.rmSync(storagePath, { recursive: true, force: true });
  });

  await scoped.set("key", "value", { ttl: 60_000 });
  assert.equal(await scoped.get("key"), "value");
  await scoped.flush();
  assert.equal(await scoped.get("key"), undefined);
  const indexes = [];
  for await (const key of db.db.keys({ gte: "ttl/", lt: "ttl0" })) indexes.push(key);
  assert.deepEqual(indexes, []);
});

test("encrypted records reject ciphertext tampering", async (t) => {
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "ssdiskdb-cipher-"));
  const db = await connect({ storagePath, encryptionKey: "correct-key" });
  t.after(async () => {
    await db.close();
    fs.rmSync(storagePath, { recursive: true, force: true });
  });

  await db.set("secret", { token: "sensitive" });
  assert.deepEqual(await db.get("secret"), { token: "sensitive" });
  const { decodeRecord, encodeRecord } = require("./dist/cjs/core/codec.js");
  const raw = await db.db.get("s:secret", { valueEncoding: "buffer" });
  const record = decodeRecord(raw);
  const payload = Buffer.from(record.payload);
  const ciphertext = payload.subarray(1).toString("utf8");
  const segments = ciphertext.split(":");
  segments[3] = `${segments[3][0] === "0" ? "1" : "0"}${segments[3].substring(1)}`;
  const tampered = segments.join(":");
  await db.db.put("s:secret", encodeRecord(Buffer.concat([Buffer.from([0]), Buffer.from(tampered)]), record.expiresAt), { valueEncoding: "buffer" });
  await assert.rejects(db.get("secret"), /Decryption failed/);
});

test("gRPC reuses a channel and serves the shared database API", async (t) => {
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "ssdiskdb-grpc-"));
  const local = await connect({ storagePath });
  const remotes = [];
  t.after(async () => {
    for (const remote of remotes) await remote.close();
    await local.close();
    fs.rmSync(storagePath, { recursive: true, force: true });
  });

  const apiKey = "grpc-test-key";
  await local.db.put("config:server:grpc-client", JSON.stringify({ apiKey, status: "allowed" }));
  await local.db.put("config:server:grpc-other", JSON.stringify({ apiKey: "other-key", status: "allowed" }));
  await local.db.put("config:server:grpc-encrypted", JSON.stringify({ apiKey: "encrypted-key", status: "allowed" }));
  const address = await local.startGrpcServer({ host: "127.0.0.1", port: 0 });
  const remote = await connect(`ssdiskdb+grpc://${apiKey}@${address}/grpc-client`);
  remotes.push(remote);
  const other = await connect(`ssdiskdb+grpc://other-key@${address}/grpc-other`);
  remotes.push(other);
  const encrypted = await connect(`ssdiskdb+grpc+encry://encrypted-key@${address}/grpc-encrypted?key=client-secret`);
  remotes.push(encrypted);

  await remote.set("key", { value: 1 }, { ttl: 5000 });
  assert.deepEqual(await remote.get("key"), { value: 1 });
  assert.equal(await other.get("key"), undefined);
  await other.set("key", "other value");
  assert.deepEqual(await remote.get("key"), { value: 1 });
  assert.equal(await remote.ttl("key") > 0, true);
  await remote.mset([["a", 1], ["b", 2]]);
  assert.deepEqual(await remote.mget(["a", "b"]), [1, 2]);
  const streamed = [];
  for await (const entry of remote.streamScan({ prefix: "", limit: 2 })) streamed.push(entry.key);
  assert.ok(streamed.includes("a"));
  assert.ok(streamed.includes("b"));
  await remote.hset("hash", "field", "value");
  assert.equal(await remote.hget("hash", "field"), "value");
  await remote.zset("scores", "m1", 1.5);
  assert.equal(await remote.zget("scores", "m1"), 1.5);
  assert.ok((await remote.stats()).writes > 0);
  const binary = Buffer.from([0, 7, 128, 255]);
  await remote.set("binary", binary);
  assert.deepEqual(await remote.get("binary"), binary);
  await encrypted.set("private", { password: "never in plaintext" });
  assert.deepEqual(await encrypted.get("private"), { password: "never in plaintext" });
  const encryptedBinary = Buffer.from([0, 1, 127, 128, 255]);
  await encrypted.set("private-binary", encryptedBinary);
  assert.deepEqual(await encrypted.get("private-binary"), encryptedBinary);
  const ciphertext = await local.get("client:grpc-encrypted:private");
  assert.equal(typeof ciphertext, "string");
  assert.doesNotMatch(ciphertext, /never in plaintext/);

  await assert.rejects(
    connect(`ssdiskdb+grpc://invalid@${address}/grpc-client`),
    /Invalid API key|UNAUTHENTICATED|Authentication required/
  );
});

test("gRPC TLS and mutual TLS validate certificates", { skip: spawnSync("openssl", ["version"], { stdio: "ignore" }).status !== 0 }, async (t) => {
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "ssdiskdb-mtls-"));
  const certPath = fs.mkdtempSync(path.join(os.tmpdir(), "ssdiskdb-certs-"));
  const local = await connect({ storagePath });
  const clients = [];
  const servers = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    for (const server of servers) await server.close();
    await local.close();
    fs.rmSync(storagePath, { recursive: true, force: true });
    fs.rmSync(certPath, { recursive: true, force: true });
  });

  const file = (name) => path.join(certPath, name);
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", file("server.key"), "-out", file("server.crt"), "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost", "-addext", "basicConstraints=critical,CA:TRUE"], { stdio: "ignore" });
  execFileSync("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", file("client.key"), "-out", file("client.csr"), "-subj", "/CN=ssdiskdb-client"], { stdio: "ignore" });
  execFileSync("openssl", ["x509", "-req", "-in", file("client.csr"), "-CA", file("server.crt"), "-CAkey", file("server.key"), "-CAcreateserial", "-out", file("client.crt"), "-days", "1"], { stdio: "ignore" });
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", file("wrong-ca.key"), "-out", file("wrong-ca.crt"), "-days", "1", "-subj", "/CN=wrong-ca"], { stdio: "ignore" });

  const apiKey = "tls-client-key";
  await local.db.put("config:server:tls-client", JSON.stringify({ apiKey, status: "allowed" }));
  const { startGrpcServer } = require("./dist/cjs/grpc/server.js");
  const server = await startGrpcServer(local, {
    host: "127.0.0.1",
    port: 0,
    privateKey: fs.readFileSync(file("server.key")),
    certChain: fs.readFileSync(file("server.crt"))
  });
  servers.push(server);
  const secure = await connect({ grpcTarget: server.address, apiKey, serverId: "tls-client", grpcTls: { rootCert: fs.readFileSync(file("server.crt")), serverName: "localhost" } });
  clients.push(secure);
  await secure.set("tls", "verified");
  assert.equal(await secure.get("tls"), "verified");
  await assert.rejects(connect({ grpcTarget: server.address, apiKey, serverId: "tls-client", grpcTls: { rootCert: fs.readFileSync(file("wrong-ca.crt")), serverName: "localhost" }, requestTimeoutMs: 1500 }));

  const mtlsServer = await startGrpcServer(local, {
    host: "127.0.0.1",
    port: 0,
    privateKey: fs.readFileSync(file("server.key")),
    certChain: fs.readFileSync(file("server.crt")),
    rootCert: fs.readFileSync(file("server.crt")),
    requireClientCertificate: true
  });
  servers.push(mtlsServer);
  const mutual = await connect({
    grpcTarget: mtlsServer.address,
    apiKey,
    serverId: "tls-client",
    grpcTls: {
      rootCert: fs.readFileSync(file("server.crt")),
      serverName: "localhost",
      privateKey: fs.readFileSync(file("client.key")),
      certChain: fs.readFileSync(file("client.crt"))
    }
  });
  clients.push(mutual);
  await mutual.set("mtls", "verified");
  assert.equal(await mutual.get("mtls"), "verified");
  await assert.rejects(connect({ grpcTarget: mtlsServer.address, apiKey, serverId: "tls-client", grpcTls: { rootCert: fs.readFileSync(file("server.crt")), serverName: "localhost" }, requestTimeoutMs: 1500 }));
});

