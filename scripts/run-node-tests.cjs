const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const extra = fs.readdirSync(path.join(root, "tests"))
  .filter((file) => file.endsWith(".test.js"))
  .map((file) => path.join("tests", file));
const result = spawnSync(process.execPath, ["--test", "test.js", "test-upgrade.js", ...extra], {
  cwd: root,
  stdio: "inherit"
});
process.exit(result.status === null ? 1 : result.status);
