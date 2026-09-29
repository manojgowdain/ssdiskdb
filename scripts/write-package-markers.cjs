const fs = require("node:fs");
const path = require("node:path");

for (const [directory, type] of [["esm", "module"], ["cjs", "commonjs"]]) {
  const output = path.join(__dirname, "..", "dist", directory);
  fs.writeFileSync(path.join(output, "package.json"), `${JSON.stringify({ type }, null, 2)}\n`);
}
