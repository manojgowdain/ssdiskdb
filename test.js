const test = require("node:test");
const assert = require("node:assert");
const { connect } = require("./dist/cjs/index.js");


test("SSDiskDB Local Mode Integration Tests", async (t) => {
  let localDb;
  const storagePath = "./test-local-db";

  t.before(async () => {
    // Ensure clean start
    const fs = require("fs");
    fs.rmSync(storagePath, { recursive: true, force: true });
    localDb = await connect({ storagePath });
  });

  t.after(async () => {
    if (localDb) {
      await localDb.close();
    }
    // Clean up
    const fs = require("fs");
    fs.rmSync(storagePath, { recursive: true, force: true });
  });

  await t.test("String operations in local mode", async () => {
    await localDb.set("key1", "val1");
    assert.strictEqual(await localDb.get("key1"), "val1");
    assert.strictEqual(await localDb.exists("key1"), true);
    assert.strictEqual(await localDb.exists("nonexistent"), false);

    // JSON objects
    const obj = { x: 10, y: [true, null] };
    await localDb.set("key2", obj);
    assert.deepStrictEqual(await localDb.get("key2"), obj);

    // Incr
    assert.strictEqual(await localDb.incr("counter", 10), 10);
    assert.strictEqual(await localDb.incr("counter", 5), 15);

    // Del
    await localDb.del("key1");
    assert.strictEqual(await localDb.get("key1"), undefined);
  });

  await t.test("Hash operations in local mode", async () => {
    await localDb.hset("hash1", "field1", "val1");
    assert.strictEqual(await localDb.hget("hash1", "field1"), "val1");
    await localDb.hset("hash1", "field2", { nested: true });
    assert.deepStrictEqual(await localDb.hget("hash1", "field2"), { nested: true });

    await localDb.hdel("hash1", "field1");
    assert.strictEqual(await localDb.hget("hash1", "field1"), undefined);
  });

  await t.test("Sorted Set operations in local mode", async () => {
    await localDb.zset("zset1", "m1", 99.5);
    assert.strictEqual(await localDb.zget("zset1", "m1"), 99.5);
    await localDb.zdel("zset1", "m1");
    assert.strictEqual(await localDb.zget("zset1", "m1"), undefined);
  });

  await t.test("Encryption in local mode", async () => {
    const secretLocalDb = await connect("./test-local-secure-db", { encryptionKey: "local-secret" });
    await secretLocalDb.set("confidential", { password: "123" });

    // Correct decryption
    assert.deepStrictEqual(await secretLocalDb.get("confidential"), { password: "123" });

    // Close to release the database directory lock
    await secretLocalDb.close();

    // Open without encryption key and read raw string format
    const rawLocalDb = await connect("./test-local-secure-db");
    const raw = await rawLocalDb.get("confidential");
    assert.strictEqual(typeof raw, "string");
    assert.ok(raw.startsWith("gcm:v1:"));

    await rawLocalDb.close();

    const fs = require("fs");
    fs.rmSync("./test-local-secure-db", { recursive: true, force: true });
  });

  await t.test("Data persistence in local mode", async () => {
    await localDb.set("persistKey", "should be saved");
    await localDb.close();

    // Reconnect to same path
    localDb = await connect({ storagePath });
    assert.strictEqual(await localDb.get("persistKey"), "should be saved");
  });

  await t.test("Web Dashboard HTTP Server API", async () => {
    const dashboardPort = 9005;
    const testDbPath = "./test-dashboard-db";
    const fs = require("fs");
    fs.rmSync(testDbPath, { recursive: true, force: true });

    // Connect and start dashboard
    const client = await connect({
      storagePath: testDbPath,
      startDashboard: true,
      dashboardPort
    });

    const getAuthHeader = (un, pw) => ({
      "Authorization": "Basic " + Buffer.from(`${un}:${pw}`).toString("base64")
    });

    // 1. Unauthenticated request
    const res1 = await fetch(`http://localhost:${dashboardPort}/`);
    assert.strictEqual(res1.status, 401);

    // 2. Authenticated request (HTML)
    const res2 = await fetch(`http://localhost:${dashboardPort}/`, {
      headers: getAuthHeader("manoj", "manoj")
    });
    assert.strictEqual(res2.status, 200);
    const html = await res2.text();
    assert.ok(html.includes("SSDiskDB Insights"));

    // 3. Authenticated keys API (empty)
    const res3 = await fetch(`http://localhost:${dashboardPort}/api/keys`, {
      headers: getAuthHeader("manoj", "manoj")
    });
    assert.strictEqual(res3.status, 200);
    const keys = await res3.json();
    assert.deepStrictEqual(keys, []);

    // 4. Save key through API
    const res4 = await fetch(`http://localhost:${dashboardPort}/api/keys`, {
      method: "POST",
      headers: {
        ...getAuthHeader("manoj", "manoj"),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        type: "string",
        key: "dashboard_test_key",
        value: { message: "hello dashboard" }
      })
    });
    assert.strictEqual(res4.status, 200);

    // Verify key in client
    const value = await client.get("dashboard_test_key");
    assert.deepStrictEqual(value, { message: "hello dashboard" });

    // 5. Get keys listing through API
    const res5 = await fetch(`http://localhost:${dashboardPort}/api/keys`, {
      headers: getAuthHeader("manoj", "manoj")
    });
    assert.strictEqual(res5.status, 200);
    const keys2 = await res5.json();
    assert.strictEqual(keys2.length, 1);
    assert.strictEqual(keys2[0].rawKey, "s:dashboard_test_key");
    assert.deepStrictEqual(keys2[0].value, { message: "hello dashboard" });

    // 6. Delete key through API
    const res6 = await fetch(`http://localhost:${dashboardPort}/api/keys`, {
      method: "DELETE",
      headers: {
        ...getAuthHeader("manoj", "manoj"),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        key: "s:dashboard_test_key"
      })
    });
    assert.strictEqual(res6.status, 200);

    // Verify key deleted
    assert.strictEqual(await client.get("dashboard_test_key"), undefined);

    // Close client
    await client.close();

    // Verify server closed (fetch throws connection refused)
    await assert.rejects(async () => {
      await fetch(`http://localhost:${dashboardPort}/`);
    });

    // Cleanup
    fs.rmSync(testDbPath, { recursive: true, force: true });
  });

  await t.test("VPC Cross-Server Connections & Allowed Verification", async () => {
    const dashboardPort = 9006;
    const testDbPath = "./test-cross-server-db";
    const fs = require("fs");
    fs.rmSync(testDbPath, { recursive: true, force: true });

    // Connect and start dashboard server (central cache)
    const centralServer = await connect({
      storagePath: testDbPath,
      startDashboard: true,
      dashboardPort
    });

    // 1. Connection remote client should fail immediately on handshake if not registered/invalid key
    await assert.rejects(async () => {
      await connect({
        remoteUrl: `http://localhost:${dashboardPort}`,
        apiKey: "invalid_key",
        serverId: "server-a"
      });
    }, /Forbidden/);

    // 2. Register "server-a" and "server-b" in the central server
    const db = centralServer.db;
    const apiKeyA = "ssdb_key_a";
    const apiKeyB = "ssdb_key_b";
    await db.put("config:server:server-a", JSON.stringify({ registeredAt: Date.now(), apiKey: apiKeyA }));
    await db.put("config:server:server-b", JSON.stringify({ registeredAt: Date.now(), apiKey: apiKeyB }));

    // 3. Connection with valid apiKey should succeed now
    const clientA = await connect({
      remoteUrl: `http://localhost:${dashboardPort}`,
      apiKey: apiKeyA,
      serverId: "server-a"
    });

    // Now try set request, should succeed
    const resSet = await clientA.set("key1", "val1");
    assert.strictEqual(resSet, 1);

    // Verify key was saved with namespacing in central server
    assert.strictEqual(await centralServer.get("client:server-a:key1"), "val1");

    // Connect server-b client and set the same key to a different value
    const clientB = await connect({
      remoteUrl: `http://localhost:${dashboardPort}`,
      apiKey: apiKeyB,
      serverId: "server-b"
    });
    await clientB.set("key1", "val2");

    // Verify namespaced key isolation
    assert.strictEqual(await clientA.get("key1"), "val1");
    assert.strictEqual(await clientB.get("key1"), "val2");

    // Verify lists show both servers separately via HTTP API
    const resKeys = await fetch(`http://localhost:${dashboardPort}/api/keys`, {
      headers: {
        "Authorization": "Basic " + Buffer.from("manoj:manoj").toString("base64")
      }
    });
    const parsedKeys = await resKeys.json();
    
    // Should have 2 keys in list
    assert.strictEqual(parsedKeys.length, 2);
    
    const keyA = parsedKeys.find(k => k.server === "server-a");
    const keyB = parsedKeys.find(k => k.server === "server-b");
    assert.ok(keyA);
    assert.ok(keyB);
    assert.strictEqual(keyA.value, "val1");
    assert.strictEqual(keyB.value, "val2");

    // Close clients
    await clientA.close();
    await clientB.close();
    await centralServer.close();

    // Cleanup
    fs.rmSync(testDbPath, { recursive: true, force: true });
  });

  await t.test("Dashboard Sub-accounts & Role-Based Access Control (RBAC)", async () => {
    const dashboardPort = 9008;
    const testDbPath = "./test-subaccount-db";
    const fs = require("fs");
    fs.rmSync(testDbPath, { recursive: true, force: true });

    // 1. Connect and start dashboard
    const client = await connect({
      storagePath: testDbPath,
      startDashboard: true,
      dashboardPort
    });

    const getAuthHeader = (un, pw) => ({
      "Authorization": "Basic " + Buffer.from(`${un}:${pw}`).toString("base64")
    });

    // 2. Create sub-accounts: junior_dev (junior role) and senior_dev (senior role)
    const resCreateJunior = await fetch(`http://localhost:${dashboardPort}/api/subaccounts`, {
      method: "POST",
      headers: {
        ...getAuthHeader("manoj", "manoj"),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        username: "junior_dev",
        password: "junior_password",
        role: "junior",
        adminPassword: "manoj"
      })
    });
    assert.strictEqual(resCreateJunior.status, 200);

    const resCreateSenior = await fetch(`http://localhost:${dashboardPort}/api/subaccounts`, {
      method: "POST",
      headers: {
        ...getAuthHeader("manoj", "manoj"),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        username: "senior_dev",
        password: "senior_password",
        role: "senior",
        adminPassword: "manoj"
      })
    });
    assert.strictEqual(resCreateSenior.status, 200);

    // Try creating with wrong admin password - should fail (401)
    const resCreateFail = await fetch(`http://localhost:${dashboardPort}/api/subaccounts`, {
      method: "POST",
      headers: {
        ...getAuthHeader("manoj", "manoj"),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        username: "hacker_dev",
        password: "hacker_password",
        role: "senior",
        adminPassword: "wrong_admin_password"
      })
    });
    assert.strictEqual(resCreateFail.status, 401);

    // 3. Test GET sub-accounts (Admin only)
    const resListAdmin = await fetch(`http://localhost:${dashboardPort}/api/subaccounts`, {
      headers: getAuthHeader("manoj", "manoj")
    });
    assert.strictEqual(resListAdmin.status, 200);
    const subaccounts = await resListAdmin.json();
    assert.strictEqual(subaccounts.length, 2);
    assert.ok(subaccounts.find(s => s.username === "junior_dev" && s.role === "junior"));
    assert.ok(subaccounts.find(s => s.username === "senior_dev" && s.role === "senior"));

    // Junior request to list sub-accounts should fail (403)
    const resListJunior = await fetch(`http://localhost:${dashboardPort}/api/subaccounts`, {
      headers: getAuthHeader("junior_dev", "junior_password")
    });
    assert.strictEqual(resListJunior.status, 403);

    // 4. Test RBAC permissions on writing keys
    // Junior dev tries to set a key - should fail (403)
    const resSetJunior = await fetch(`http://localhost:${dashboardPort}/api/keys`, {
      method: "POST",
      headers: {
        ...getAuthHeader("junior_dev", "junior_password"),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ type: "string", key: "test_key", value: "val" })
    });
    assert.strictEqual(resSetJunior.status, 403);

    // Senior dev tries to set a key - should succeed (200)
    const resSetSenior = await fetch(`http://localhost:${dashboardPort}/api/keys`, {
      method: "POST",
      headers: {
        ...getAuthHeader("senior_dev", "senior_password"),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ type: "string", key: "test_key", value: "val" })
    });
    assert.strictEqual(resSetSenior.status, 200);

    // Verify key was set
    assert.strictEqual(await client.get("test_key"), "val");

    // 5. Test RBAC permissions on flushing database
    // Senior dev tries to flush - should fail (403)
    const resFlushSenior = await fetch(`http://localhost:${dashboardPort}/api/flush`, {
      method: "POST",
      headers: getAuthHeader("senior_dev", "senior_password")
    });
    assert.strictEqual(resFlushSenior.status, 403);

    // Admin tries to flush - should succeed (200)
    const resFlushAdmin = await fetch(`http://localhost:${dashboardPort}/api/flush`, {
      method: "POST",
      headers: getAuthHeader("manoj", "manoj")
    });
    assert.strictEqual(resFlushAdmin.status, 200);
    assert.strictEqual(await client.get("test_key"), undefined);

    // 6. Test sub-account deletion
    const resDelSub = await fetch(`http://localhost:${dashboardPort}/api/subaccounts`, {
      method: "DELETE",
      headers: {
        ...getAuthHeader("manoj", "manoj"),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        username: "junior_dev",
        adminPassword: "manoj"
      })
    });
    assert.strictEqual(resDelSub.status, 200);

    // Check list again
    const resListFinal = await fetch(`http://localhost:${dashboardPort}/api/subaccounts`, {
      headers: getAuthHeader("manoj", "manoj")
    });
    const subaccountsFinal = await resListFinal.json();
    assert.strictEqual(subaccountsFinal.length, 1);
    assert.strictEqual(subaccountsFinal[0].username, "senior_dev");

    // Clean up
    await client.close();
    fs.rmSync(testDbPath, { recursive: true, force: true });
  });

  await t.test("Web Dashboard Cookie-based Session Authentication", async () => {
    const dashboardPort = 9010;
    const testDbPath = "./test-cookie-auth-db";
    const fs = require("fs");
    fs.rmSync(testDbPath, { recursive: true, force: true });

    // Connect and start dashboard
    const client = await connect({
      storagePath: testDbPath,
      startDashboard: true,
      dashboardPort
    });

    // 1. Fetch root unauthenticated -> should serve Login Page HTML (Status 401)
    const resRoot = await fetch(`http://localhost:${dashboardPort}/`);
    assert.strictEqual(resRoot.status, 401);
    const htmlContent = await resRoot.text();
    assert.ok(htmlContent.includes("Login - SSDiskDB Insights"));
    assert.ok(htmlContent.includes("username"));
    assert.ok(htmlContent.includes("password"));

    // 2. Fetch API endpoint unauthenticated -> should return 401 JSON error
    const resKeysUnauth = await fetch(`http://localhost:${dashboardPort}/api/keys`);
    assert.strictEqual(resKeysUnauth.status, 401);
    const keysUnauthJson = await resKeysUnauth.json();
    assert.deepStrictEqual(keysUnauthJson, { error: "Unauthorized" });

    // 3. POST to /api/login with wrong password -> should return 401 JSON error
    const resLoginFail = await fetch(`http://localhost:${dashboardPort}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "manoj", password: "wrong_password" })
    });
    assert.strictEqual(resLoginFail.status, 401);
    const failJson = await resLoginFail.json();
    assert.ok(failJson.error);

    // 4. POST to /api/login with correct password -> should succeed, return user details, set session cookie
    const resLoginSuccess = await fetch(`http://localhost:${dashboardPort}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "manoj", password: "manoj" })
    });
    assert.strictEqual(resLoginSuccess.status, 200);
    const successJson = await resLoginSuccess.json();
    assert.strictEqual(successJson.status, "ok");
    assert.strictEqual(successJson.role, "admin");

    // Extract session cookie from Set-Cookie header
    const setCookie = resLoginSuccess.headers.get("set-cookie");
    assert.ok(setCookie);
    assert.ok(setCookie.includes("session="));
    const match = setCookie.match(/session=[^;]+/);
    const sessionCookie = match ? match[0] : "";
    assert.ok(sessionCookie);

    // 5. Fetch root with cookie -> should serve Dashboard UI HTML (Status 200)
    const resDashboard = await fetch(`http://localhost:${dashboardPort}/`, {
      headers: { "Cookie": sessionCookie }
    });
    assert.strictEqual(resDashboard.status, 200);
    const dashHtml = await resDashboard.text();
    assert.ok(dashHtml.includes("SSDiskDB Insights"));

    // 6. Fetch API keys with cookie -> should succeed (Status 200)
    const resKeysAuth = await fetch(`http://localhost:${dashboardPort}/api/keys`, {
      headers: { "Cookie": sessionCookie }
    });
    assert.strictEqual(resKeysAuth.status, 200);
    const keysArray = await resKeysAuth.json();
    assert.deepStrictEqual(keysArray, []);

    // 7. POST to /api/logout -> should succeed and clear cookie
    const resLogout = await fetch(`http://localhost:${dashboardPort}/api/logout`, {
      method: "POST",
      headers: { "Cookie": sessionCookie }
    });
    assert.strictEqual(resLogout.status, 200);
    const logoutJson = await resLogout.json();
    assert.strictEqual(logoutJson.status, "ok");
    const logoutCookie = resLogout.headers.get("set-cookie");
    assert.ok(logoutCookie);
    assert.ok(logoutCookie.includes("Max-Age=0"));

    // 8. Fetch API keys again -> should fail with 401
    const resKeysAfterLogout = await fetch(`http://localhost:${dashboardPort}/api/keys`, {
      headers: { "Cookie": sessionCookie }
    });
    assert.strictEqual(resKeysAfterLogout.status, 401);

    // Clean up
    await client.close();
    fs.rmSync(testDbPath, { recursive: true, force: true });
  });

  await t.test("Connection URI Parsing and Connect options parsing", async () => {
    const { parseConnectionString } = require("./dist/cjs/index.js");
    
    // 1. Valid non-encrypted URI
    const parsed1 = parseConnectionString("ssdiskdb://ssdb_key123@127.0.0.1:8971/server-x");
    assert.strictEqual(parsed1.remoteUrl, "http://127.0.0.1:8971");
    assert.strictEqual(parsed1.apiKey, "ssdb_key123");
    assert.strictEqual(parsed1.serverId, "server-x");
    assert.strictEqual(parsed1.encryptionKey, undefined);

    // 2. Valid encrypted URI
    const parsed2 = parseConnectionString("ssdiskdb+encry://ssdb_key123@127.0.0.1:8971/server-x?key=supersecretkey");
    assert.strictEqual(parsed2.remoteUrl, "http://127.0.0.1:8971");
    assert.strictEqual(parsed2.apiKey, "ssdb_key123");
    assert.strictEqual(parsed2.serverId, "server-x");
    assert.strictEqual(parsed2.encryptionKey, "supersecretkey");

    // 3. Invalid URI format throws
    assert.throws(() => {
      parseConnectionString("invalid://uri");
    }, /Invalid connection URI format/);
  });

  await t.test("Remote Client with URI and Encryption Integration", async () => {
    const dashboardPort = 9015;
    const testDbPath = "./test-uri-remote-db";
    const fs = require("fs");
    fs.rmSync(testDbPath, { recursive: true, force: true });

    // Start central server
    const centralServer = await connect({
      storagePath: testDbPath,
      startDashboard: true,
      dashboardPort
    });

    const apiKey = "ssdb_secret_key";
    await centralServer.db.put("config:server:server-enc", JSON.stringify({ registeredAt: Date.now(), apiKey }));

    // Connect remote client via encrypted connection URI
    const uri = `ssdiskdb+encry://${apiKey}@localhost:${dashboardPort}/server-enc?key=client-aes-key`;
    const client = await connect(uri);

    // Perform CRUD operations
    await client.set("secure_key", { confidential: "remote data" });
    assert.deepStrictEqual(await client.get("secure_key"), { confidential: "remote data" });

    // Verify raw content on central server is encrypted
    const rawVal = await centralServer.get("client:server-enc:secure_key");
    assert.strictEqual(typeof rawVal, "string");
    assert.ok(rawVal.startsWith("gcm:v1:")); // Verify authenticated ciphertext format

    // Incr operation on client-side encrypted remote
    await client.set("counter", 10);
    assert.strictEqual(await client.incr("counter", 5), 15);
    assert.strictEqual(await client.get("counter"), 15);

    // Hash operations
    await client.hset("hash-enc", "field1", { data: 42 });
    assert.deepStrictEqual(await client.hget("hash-enc", "field1"), { data: 42 });

    // Get all keys (verifying decryption works and s: prefix is restored)
    const allKeys = await client.getAllKeys();
    assert.ok(allKeys.some(k => k.key === "s:secure_key" && k.value.confidential === "remote data"));
    assert.ok(allKeys.some(k => k.key === "s:counter" && k.value === 15));
    assert.ok(allKeys.some(k => k.key === "h:hash-enc:field1" && k.value.data === 42));

    await client.close();
    await centralServer.close();
    fs.rmSync(testDbPath, { recursive: true, force: true });
  });

  await t.test("Dashboard Dual-Mode Login and Proxy Verification", async () => {
    const dashboardPort = 9020;
    const centralPort = 9021;
    const dbPath1 = "./test-dual-dashboard-1";
    const dbPath2 = "./test-dual-dashboard-2";
    const fs = require("fs");
    fs.rmSync(dbPath1, { recursive: true, force: true });
    fs.rmSync(dbPath2, { recursive: true, force: true });

    // Start Central server (the target remote server)
    const centralServer = await connect({
      storagePath: dbPath2,
      startDashboard: true,
      dashboardPort: centralPort
    });
    const apiKey = "central_key";
    await centralServer.db.put("config:server:server-y", JSON.stringify({ registeredAt: Date.now(), apiKey }));

    // Start local server (the one hosting our dual-mode dashboard)
    const localServer = await connect({
      storagePath: dbPath1,
      startDashboard: true,
      dashboardPort
    });

    // 1. Perform local login to dashboard and confirm local mode works
    const resLocalLogin = await fetch(`http://localhost:${dashboardPort}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "manoj", password: "manoj" })
    });
    assert.strictEqual(resLocalLogin.status, 200);
    const localLoginJson = await resLocalLogin.json();
    assert.strictEqual(localLoginJson.role, "admin");

    // 2. Perform remote URI login to connect to the central server
    const remoteUri = `ssdiskdb://central_key@localhost:${centralPort}/server-y`;
    const resRemoteLogin = await fetch(`http://localhost:${dashboardPort}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "remote", connectionUri: remoteUri })
    });
    assert.strictEqual(resRemoteLogin.status, 200);
    const remoteCookie = resRemoteLogin.headers.get("set-cookie").match(/session=[^;]+/)[0];

    // 3. Save a key through the dashboard under remote session
    const resSaveKey = await fetch(`http://localhost:${dashboardPort}/api/keys`, {
      method: "POST",
      headers: {
        "Cookie": remoteCookie,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ type: "string", key: "remote_dash_key", value: "hello from proxy dashboard" })
    });
    assert.strictEqual(resSaveKey.status, 200);

    // Verify key was saved in central server namespace, NOT local server
    assert.strictEqual(await localServer.get("remote_dash_key"), undefined);
    assert.strictEqual(await centralServer.get("client:server-y:remote_dash_key"), "hello from proxy dashboard");

    // 4. Retrieve keys via proxy dashboard
    const resGetKeys = await fetch(`http://localhost:${dashboardPort}/api/keys`, {
      headers: { "Cookie": remoteCookie }
    });
    assert.strictEqual(resGetKeys.status, 200);
    const keys = await resGetKeys.json();
    const found = keys.find(k => k.key === "remote_dash_key" && k.server === "server-y");
    assert.ok(found);
    assert.strictEqual(found.value, "hello from proxy dashboard");

    // 5. Try calling forbidden server allowed configurations on remote session
    const resForbiddenAdd = await fetch(`http://localhost:${dashboardPort}/api/servers`, {
      method: "POST",
      headers: {
        "Cookie": remoteCookie,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ address: "attacker-ip" })
    });
    assert.strictEqual(resForbiddenAdd.status, 403);

    // Clean up
    const resLogout = await fetch(`http://localhost:${dashboardPort}/api/logout`, {
      method: "POST",
      headers: { "Cookie": remoteCookie }
    });
    assert.strictEqual(resLogout.status, 200);

    await localServer.close();
    await centralServer.close();
    fs.rmSync(dbPath1, { recursive: true, force: true });
    fs.rmSync(dbPath2, { recursive: true, force: true });
  });
});

