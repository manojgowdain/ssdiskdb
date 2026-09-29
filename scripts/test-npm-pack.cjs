#!/usr/bin/env node
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const pack = spawnSync("npm", ["pack", "--json"], { cwd: root, encoding: "utf8", shell: true });
if (pack.status !== 0) {
  process.stderr.write(pack.stderr || pack.stdout);
  process.exit(pack.status || 1);
}
const jsonStart = pack.stdout.indexOf("[");
if (jsonStart < 0) {
  process.stderr.write(pack.stdout);
  throw new Error("npm pack --json did not print a JSON array");
}
const packed = JSON.parse(pack.stdout.slice(jsonStart));
const tarballName = packed[0].filename;
const tarball = path.join(root, tarballName);
const consumer = fs.mkdtempSync(path.join(os.tmpdir(), "ssdiskdb-npm-consumer-"));

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", shell: true, stdio: "pipe" });
  if (result.status !== 0) {
    process.stderr.write(result.stdout + result.stderr);
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
  return result;
}

try {
  fs.writeFileSync(path.join(consumer, "package.json"), JSON.stringify({
    name: "ssdiskdb-consumer",
    private: true,
    type: "commonjs"
  }, null, 2));
  run("npm", ["install", tarball], consumer);

  const packedFiles = new Set((packed[0].files || []).map((file) => String(file.path).replaceAll("\\", "/")));
  const has = (name) => [...packedFiles].some((file) => file === name || file.endsWith(`/${name}`) || file.toLowerCase() === name.toLowerCase());
  for (const required of [
    "package.json",
    "dist/cjs/index.js",
    "dist/esm/index.js",
    "dist/esm/index.d.ts",
    "dist/cjs/cli.js",
    "proto/ssdiskdb.proto"
  ]) {
    if (!has(required)) throw new Error(`packed tarball is missing ${required}`);
  }
  if (!has("README.md") && !has("readme.md")) throw new Error("packed tarball is missing README");
  if (!has("LICENSE") && !has("LICENSE.txt")) throw new Error("packed tarball is missing LICENSE");

  const cjsProbe = path.join(consumer, "probe.cjs");
  fs.writeFileSync(cjsProbe, `
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const { connect } = require("@manojgowdain/ssdiskdb");
    (async () => {
      const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "ssdiskdb-consumer-db-"));
      const db = await connect({ storagePath });
      try {
        await db.set("k", "v");
        if (await db.get("k") !== "v") throw new Error("consumer GET mismatch");
      } finally {
        await db.close();
        fs.rmSync(storagePath, { recursive: true, force: true });
      }
    })().catch((error) => { console.error(error); process.exit(1); });
  `);
  run(process.execPath, [cjsProbe], consumer);

  const esmDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssdiskdb-esm-consumer-"));
  fs.writeFileSync(path.join(esmDir, "package.json"), JSON.stringify({ name: "ssdiskdb-esm-consumer", private: true, type: "module" }));
  run("npm", ["install", tarball], esmDir);
  fs.writeFileSync(path.join(esmDir, "probe.mjs"), `
    import fs from "node:fs";
    import os from "node:os";
    import path from "node:path";
    import { connect } from "@manojgowdain/ssdiskdb";
    const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "ssdiskdb-consumer-esm-"));
    const db = await connect({ storagePath });
    await db.set("k", 1);
    if (await db.get("k") !== 1) throw new Error("esm consumer GET mismatch");
    await db.close();
    fs.rmSync(storagePath, { recursive: true, force: true });
  `);
  run(process.execPath, [path.join(esmDir, "probe.mjs")], esmDir);
  fs.rmSync(esmDir, { recursive: true, force: true });

  const help = spawnSync(path.join(consumer, "node_modules", ".bin", "ssdiskdb"), ["--help"], {
    encoding: "utf8",
    shell: true
  });
  if (help.status !== 0 || !help.stdout.includes("ssdiskdb <command>")) {
    throw new Error("installed CLI --help failed");
  }

  run("npm", ["install", "--no-save", "typescript"], consumer);
  fs.writeFileSync(path.join(consumer, "probe.ts"), `
    import { connect } from "@manojgowdain/ssdiskdb";
    export async function check(): Promise<string> {
      const db = await connect({ storagePath: "./unused" });
      await db.close();
      return "ok";
    }
  `);
  run(path.join(consumer, "node_modules", ".bin", "tsc"), ["--strict", "--module", "commonjs", "--esModuleInterop", "--skipLibCheck", "probe.ts"], consumer);
  console.log("npm package consumer: PASS");
  console.log(tarballName);
} finally {
  fs.rmSync(consumer, { recursive: true, force: true });
  fs.rmSync(tarball, { force: true });
}
