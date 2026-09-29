const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { connect } = require("../dist/cjs/index.js");

function tempDir(prefix = "ssdiskdb-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function openDb(t, options = {}) {
  const storagePath = options.storagePath || tempDir();
  const db = await connect({ ...options, storagePath });
  t.after(async () => {
    try {
      await db.close();
    } catch {
      // already closed
    }
    fs.rmSync(storagePath, { recursive: true, force: true });
  });
  return { db, storagePath };
}

module.exports = { connect, tempDir, openDb };
