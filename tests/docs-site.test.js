const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("documentation site artifacts that exist in this repository", () => {
  const root = path.resolve(__dirname, "..");
  const index = path.join(root, "index.html");
  assert.equal(fs.existsSync(index), true);
  const html = fs.readFileSync(index, "utf8");
  assert.match(html, /SSDiskDB/);
  assert.equal(fs.existsSync(path.join(root, "readme.md")), true);

  const vitepress = path.join(root, "website", ".vitepress");
  const aiagentsPage = path.join(root, "website", "aiagents", "index.md");
  const aiagentsJson = path.join(root, "website", "public", "aiagents.json");
  if (fs.existsSync(vitepress) || fs.existsSync(aiagentsPage) || fs.existsSync(aiagentsJson)) {
    assert.equal(fs.existsSync(aiagentsJson), true, "/aiagents.json is required when the docs site is present");
  } else {
    assert.equal(fs.existsSync(path.join(root, "aiagents")), false);
    assert.equal(fs.existsSync(path.join(root, "aiagents.json")), false);
  }
});
