const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { connect, tempDir } = require("./helpers.cjs");

const cli = path.resolve(__dirname, "../dist/cjs/cli.js");

function runCli(args, extra = {}) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", ...extra });
}

test("CLI help unknown command ttl expire persist and server list", async () => {
  const help = runCli(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /ssdiskdb <command>/);

  const helpAlias = runCli(["help"]);
  assert.equal(helpAlias.status, 0);

  const unknown = runCli(["not-a-command"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr + unknown.stdout, /Unknown command/);

  const storagePath = tempDir("ssdiskdb-cli-");
  try {
    const db = await connect({ storagePath });
    await db.set("session", "alive", { ttl: 15_000 });
    await db.close();

    const ttl = runCli(["ttl", "session", "--path", storagePath]);
    assert.equal(ttl.status, 0, ttl.stderr);
    assert.ok(Number(ttl.stdout.trim()) >= 0);

    const expire = runCli(["expire", "session", "20000", "--path", storagePath]);
    assert.equal(expire.status, 0, expire.stderr);
    assert.equal(expire.stdout.trim(), "true");

    const persist = runCli(["persist", "session", "--path", storagePath]);
    assert.equal(persist.status, 0, persist.stderr);
    assert.equal(persist.stdout.trim(), "true");

    const list = runCli(["server", "list", "--path", storagePath]);
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /Allowed Remote Servers/);
  } finally {
    fs.rmSync(storagePath, { recursive: true, force: true });
  }
});
