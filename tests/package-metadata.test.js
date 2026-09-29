const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));

test("npm, Deno, and JSR manifests use the scoped package identity", () => {
  const pkg = readJson("package.json");
  const deno = readJson("deno.json");
  const jsr = readJson("jsr.json");

  for (const metadata of [pkg, deno, jsr]) {
    assert.equal(metadata.name, "@manojgowdain/ssdiskdb");
    assert.equal(metadata.version, "0.1.0");
    assert.equal(metadata.license, "Apache-2.0");
  }
  assert.equal(pkg.bin.ssdiskdb.replace(/^\.\//, ""), "dist/cjs/cli.js");
  assert.deepEqual(jsr.publish.include, deno.publish.include);
  assert.ok(jsr.publish.include.includes("proto/ssdiskdb.proto"));
  assert.equal(pkg.repository.url, "git+https://github.com/manojgowdain/ssdiskdb.git");
  assert.equal(pkg.homepage, "https://manojgowda.in/");
  assert.match(fs.readFileSync(path.join(root, "readme.md"), "utf8"), /actions\/workflows\/ci\.yml\/badge\.svg/);
  assert.equal(fs.existsSync(path.join(root, ".github", "workflows", "ci.yml")), true);
  const site = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.match(site, /https:\/\/www\.npmjs\.com\/package\/@manojgowdain\/ssdiskdb/);
  assert.match(site, /https:\/\/jsr\.io\/@manojgowdain\/ssdiskdb/);
  assert.match(fs.readFileSync(path.join(root, "LICENSE"), "utf8"), /Apache License\s+Version 2\.0/);
});
