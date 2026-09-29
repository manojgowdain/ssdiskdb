const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { openDb } = require("./helpers.cjs");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

test("dashboard API keys reject missing invalid and allow valid credentials", async (t) => {
  const port = await freePort();
  const { db } = await openDb(t, { startDashboard: true, dashboardPort: port });
  const apiKey = `ci-${process.pid}-${Date.now()}`;
  await db.db.put("config:server:auth-client", JSON.stringify({ registeredAt: Date.now(), apiKey, status: "allowed" }));

  const unauth = await fetch(`http://127.0.0.1:${port}/api/keys`);
  assert.equal(unauth.status, 401);

  await assert.rejects(
    require("./helpers.cjs").connect({
      remoteUrl: `http://127.0.0.1:${port}`,
      apiKey: "invalid-ci-key",
      serverId: "auth-client"
    }),
    /Forbidden/
  );

  const client = await require("./helpers.cjs").connect({
    remoteUrl: `http://127.0.0.1:${port}`,
    apiKey,
    serverId: "auth-client"
  });
  t.after(async () => { await client.close(); });
  await client.set("k", "ok");
  assert.equal(await client.get("k"), "ok");
});
