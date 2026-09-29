$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("ssdiskdb-consumer-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $temp | Out-Null
try {
  Push-Location $repo
  try {
    $packManifest = npm pack --dry-run --json | ConvertFrom-Json
    $packedPaths = @($packManifest[0].files | ForEach-Object { $_.path })
    if ($packedPaths | Where-Object { $_ -match '(^|/)(tests?|benchmark|\.claude|node_modules)(/|$)' }) {
      throw "npm tarball contains development-only files"
    }
    if (-not ($packedPaths -contains "proto/ssdiskdb.proto")) {
      throw "npm tarball manifest is missing the protobuf schema"
    }
    npm pack --pack-destination $temp | Out-Null
  } finally {
    Pop-Location
  }
  $tarball = Get-ChildItem -LiteralPath $temp -Filter "*.tgz" | Select-Object -First 1
  if (-not $tarball) { throw "npm pack did not create a tarball" }
  npm init --yes --prefix $temp | Out-Null
  npm install --prefix $temp --no-audit --no-fund $tarball.FullName | Out-Null

  @'
import assert from "node:assert/strict";
import { connect } from "@manojgowdain/ssdiskdb";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const storagePath = await mkdtemp(path.join(os.tmpdir(), "ssdiskdb-npm-esm-"));
const db = await connect({ storagePath });
try { await db.set("answer", 42); assert.equal(await db.get("answer"), 42); }
finally { await db.close(); await rm(storagePath, { recursive: true, force: true }); }
'@ | Set-Content -LiteralPath (Join-Path $temp "consumer.mjs") -Encoding utf8
  node (Join-Path $temp "consumer.mjs")

  @'
const assert = require("node:assert/strict");
const { connect } = require("@manojgowdain/ssdiskdb");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
(async () => {
 const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "ssdiskdb-npm-cjs-"));
 const db = await connect({ storagePath });
 try { await db.set("answer", 42); assert.equal(await db.get("answer"), 42); }
 finally { await db.close(); fs.rmSync(storagePath, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
'@ | Set-Content -LiteralPath (Join-Path $temp "consumer.cjs") -Encoding utf8
  node (Join-Path $temp "consumer.cjs")

  @'
import { connect } from "@manojgowdain/ssdiskdb";
void connect;
'@ | Set-Content -LiteralPath (Join-Path $temp "consumer.ts") -Encoding utf8
  Push-Location $temp
  try { & (Join-Path $repo "node_modules/.bin/tsc.cmd") --noEmit --strict --module NodeNext --moduleResolution NodeNext consumer.ts }
  finally { Pop-Location }

  $cli = Join-Path $temp "node_modules/.bin/ssdiskdb.cmd"
  & $cli --help | Out-Null
  if (-not (Test-Path -LiteralPath (Join-Path $temp "node_modules/@manojgowdain/ssdiskdb/proto/ssdiskdb.proto"))) {
    throw "Published tarball is missing the protobuf schema"
  }
  Write-Output "npm tarball ESM, CommonJS, types, CLI, and protobuf consumer checks passed"
} finally {
  if ((Get-Location).Path -eq $temp) { Pop-Location }
  node -e "const fs=require('node:fs'); fs.rmSync(process.argv[1], {recursive:true, force:true})" $temp
}
