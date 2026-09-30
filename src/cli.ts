#!/usr/bin/env node
import { connect } from "./index.ts";
import crypto from "node:crypto";
import readline from "node:readline";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

function getPackageVersion(): string {
  try {
    // process.argv[1] is the executing script path in both CommonJS and ESM.
    const scriptPath = process.argv[1];
    const here = scriptPath ? dirname(scriptPath) : process.cwd();
    const pkg = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function printHelp() {
  console.log(`
SSDiskDB CLI - Manage your embedded cache and dashboard server

Usage:
  ssdiskdb <command> [options]

Commands:
  start           Starts the local cache and web dashboard console, or connects as a remote client
  credentials     Updates the admin username and password stored in the database
  server          Manages allowed servers list (VPC access control)
  subaccount      Manages sub-accounts (junior / senior developers) for the dashboard
  ttl             Reads a key's remaining TTL in milliseconds
  expire          Sets a key's TTL in milliseconds
  persist         Removes a key's expiration

Options for 'start':
  --port <port>     Port to run the dashboard on (default: 8971)
  --path <path>     Path to the LevelDB database folder (default: ./ssdb-local-db)
  --remote <url>    Connect as a remote client to the specified central server URL
  --grpc <target>   Connect to the gRPC server at host:port (primary remote transport)
  --apiKey <key>    API key for remote client connection
  --serverId <id>   Server ID for remote client connection
  --grpc-port <n>   Local gRPC server port (default: 8972)

Options for 'credentials':
  --username <un>  New admin username (required)
  --password <pw>  New admin password (required)
  --path <path>    Path to the LevelDB database folder (default: ./ssdb-local-db)

Options for 'server':
  add <address> [key]  Add an IP, Domain, or Server ID to allowed list (optionally specify custom API key)
  remove <address>     Remove an IP or Domain from allowed list
  list                 List all allowed servers and status
  --path <path>        Path to the LevelDB database folder (default: ./ssdb-local-db)

Options for 'subaccount':
  create --username <un> --password <pw> [--role <role>]  Create a new sub-account (role: junior or senior)
  remove <username>                                        Remove a sub-account
  list                                                     List all sub-accounts
  --path <path>                                            Path to the LevelDB database folder (default: ./ssdb-local-db)

Examples:
  npx ssdiskdb start --port 8971
  npx ssdiskdb start --remote http://localhost:8971 --apiKey mykey --serverId client-a
  npx ssdiskdb start --grpc localhost:8972 --apiKey mykey --serverId client-a
  npx ssdiskdb credentials --username admin --password secret
  npx ssdiskdb server add 10.0.0.5 my_custom_key
  npx ssdiskdb server list
  npx ssdiskdb subaccount create --username junior_dev --password pass --role junior
  npx ssdiskdb subaccount list
  `);
}

function promptPassword(query: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "--version" || command === "-v" || command === "version") {
    console.log(`ssdiskdb ${getPackageVersion()}`);
    process.exit(0);
  }

  if (!command || command === "--help" || command === "-h" || command === "help") {
    printHelp();
    process.exit(0);
  }

  // Helper to parse flag arguments
  const getFlagValue = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    if (idx !== -1 && idx + 1 < args.length) {
      return args[idx + 1];
    }
    return undefined;
  };

  const dbPath = getFlagValue("--path") || process.env.SSDISKDB_DATA_DIR || "./ssdb-local-db";

  if (command === "start") {
    let connectionUri = getFlagValue("--uri");
    if (!connectionUri) {
      const positional = args.find(a => a.startsWith("ssdiskdb://") || a.startsWith("ssdiskdb+encry://") || a.startsWith("ssdiskdb+grpc://") || a.startsWith("ssdiskdb+grpc+encry://"));
      if (positional) {
        connectionUri = positional;
      }
    }

    if (connectionUri) {
      const portStr = getFlagValue("--port") || "8971";
      const port = parseInt(portStr, 10);
      if (isNaN(port)) {
        console.error("Error: Invalid port specified");
        process.exit(1);
      }
      console.log(`Connecting to remote SSDiskDB server via URI: ${connectionUri}...`);
      try {
        const client = await connect(connectionUri, {
          startDashboard: true,
          dashboardPort: port
        });
        console.log(`Connected successfully in remote client mode.`);
        console.log(`Dashboard is running at: http://localhost:${port} (dedicated remote console)`);
        console.log(`Press Ctrl+C to disconnect...`);

        // Keep process alive
        process.on("SIGINT", async () => {
          console.log("\nDisconnecting...");
          await client.close();
          process.exit(0);
        });
      } catch (err: any) {
        console.error("Failed to connect to remote server:", err.message);
        process.exit(1);
      }
    } else {
      const remoteUrl = getFlagValue("--remote") || getFlagValue("--remoteUrl");
      const grpcTarget = getFlagValue("--grpc");
      const apiKey = getFlagValue("--apiKey") || getFlagValue("--api-key");
      const serverId = getFlagValue("--serverId") || getFlagValue("--server-id");

      if (grpcTarget) {
        if (!apiKey || !serverId) {
          console.error("Error: Both --apiKey and --serverId are required for gRPC client connection.");
          process.exit(1);
        }
        console.log(`Connecting to gRPC SSDiskDB server at ${grpcTarget}...`);
        try {
          const client = await connect({ grpcTarget, apiKey, serverId });
          console.log(`Connected successfully over gRPC.`);
          console.log(`Server ID: ${serverId}`);
          console.log(`Press Ctrl+C to disconnect...`);
          process.on("SIGINT", async () => {
            console.log("\nDisconnecting...");
            await client.close();
            process.exit(0);
          });
        } catch (err: any) {
          console.error("Failed to connect to gRPC server:", err.message);
          process.exit(1);
        }
      } else if (remoteUrl) {
        if (!apiKey || !serverId) {
          console.error("Error: Both --apiKey and --serverId are required for remote client connection.");
          process.exit(1);
        }
        console.log(`Connecting to remote SSDiskDB server at ${remoteUrl}...`);
        try {
          const client = await connect({
            remoteUrl,
            apiKey,
            serverId
          });
          console.log(`Connected successfully in remote client mode.`);
          console.log(`Server ID: ${serverId}`);
          console.log(`Press Ctrl+C to disconnect...`);

          // Keep process alive
          process.on("SIGINT", async () => {
            console.log("\nDisconnecting...");
            await client.close();
            process.exit(0);
          });
        } catch (err: any) {
          console.error("Failed to connect to remote server:", err.message);
          process.exit(1);
        }
      } else {
        const portStr = getFlagValue("--port") || process.env.SSDISKDB_PORT || "8971";
        const port = parseInt(portStr, 10);
        if (isNaN(port)) {
          console.error("Error: Invalid port specified");
          process.exit(1);
        }

        console.log(`Initializing SSDiskDB in local mode...`);
        console.log(`Database directory: ${dbPath}`);

        try {
          const client = await connect({
            storagePath: dbPath,
            startDashboard: true,
            dashboardPort: port
          });

          const grpcPort = parseInt(getFlagValue("--grpc-port") || "8972", 10);
          if (isNaN(grpcPort) || grpcPort < 0 || grpcPort > 65535) {
            throw new Error("Invalid gRPC port specified");
          }
          const grpcAddress = await client.startGrpcServer({ host: "0.0.0.0", port: grpcPort });

          // Optional environment-based initial credentials: only applied when the
          // database has never had credentials configured, so restarts never
          // overwrite an existing admin password.
          const envUser = process.env.SSDISKDB_USERNAME;
          const envPass = process.env.SSDISKDB_PASSWORD;
          if (envUser && envPass) {
            const existing = await (client as any).getCredentials();
            const defaultHash = crypto.createHash("sha256").update("manoj").digest("hex");
            const isDefault = existing.username === "manoj" && existing.passwordHash === defaultHash;
            if (isDefault) {
              await (client as any).setCredentials(envUser, crypto.createHash("sha256").update(envPass).digest("hex"));
              console.log(`Initialized admin credentials from SSDISKDB_USERNAME/SSDISKDB_PASSWORD.`);
            }
          }

          console.log(`SSDiskDB Local Engine started successfully.`);
          console.log(`Dashboard is running at: http://0.0.0.0:${port}`);
          console.log(`gRPC server is listening at: ${grpcAddress}`);

          // Report the actual credential state instead of a hardcoded default.
          const creds = await (client as any).getCredentials();
          const isDefault = creds.username === "manoj" && creds.passwordHash === crypto.createHash("sha256").update("manoj").digest("hex");
          if (isDefault) {
            console.log(`Default credentials: manoj / manoj (Use 'ssdiskdb credentials' to change)`);
          } else {
            console.log(`Credentials configured for user: ${creds.username}`);
          }
          console.log(`Press Ctrl+C to terminate...`);

          // Keep process alive
          process.on("SIGINT", async () => {
            console.log("\nStopping server...");
            await client.close();
            process.exit(0);
          });
        } catch (err: any) {
          console.error("Failed to start server:", err.message);
          process.exit(1);
        }
      }
    }
  } else if (["ttl", "expire", "persist"].includes(command)) {
    const key = args[1];
    if (!key || (command === "expire" && args[2] === undefined)) {
      console.error(`Error: Usage is ttl <key>, expire <key> <milliseconds>, or persist <key>.`);
      process.exit(1);
    }
    try {
      const client = await connect({ storagePath: dbPath });
      if (command === "ttl") console.log(await client.ttl(key));
      else if (command === "persist") console.log(await client.persist(key));
      else {
        const ttl = Number(args[2]);
        if (!Number.isFinite(ttl) || ttl < 0) throw new Error("TTL must be a non-negative number of milliseconds");
        console.log(await client.expire(key, ttl));
      }
      await client.close();
    } catch (err: any) {
      console.error("TTL operation failed:", err.message);
      process.exit(1);
    }
  } else if (command === "credentials") {
    const username = getFlagValue("--username");
    const password = getFlagValue("--password");

    if (!username || !password) {
      console.error("Error: Both --username and --password are required.");
      printHelp();
      process.exit(1);
    }

    try {
      console.log(`Opening database at ${dbPath}...`);
      const client = await connect({
        storagePath: dbPath
      });

      if (typeof (client as any).setCredentials === "function") {
        const passwordHash = crypto.createHash("sha256").update(password).digest("hex");
        await (client as any).setCredentials(username, passwordHash);
        console.log(`Credentials updated successfully.`);
        console.log(`Username set to: ${username}`);
        console.log(`Password updated. The password is not shown for security.`);
      } else {
        console.error("Error: Client configuration does not support setting credentials.");
      }

      await client.close();
      process.exit(0);
    } catch (err: any) {
      console.error("Failed to update credentials:", err.message);
      process.exit(1);
    }
  } else if (command === "server") {
    const subCommand = args[1];
    if (!subCommand || !["add", "remove", "list"].includes(subCommand)) {
      console.error("Error: Subcommand 'add', 'remove', or 'list' is required.");
      printHelp();
      process.exit(1);
    }

    try {
      console.log(`Opening database at ${dbPath}...`);
      const client = await connect({
        storagePath: dbPath
      });
      const db = (client as any).db;

      if (subCommand === "add") {
        const address = args[2];
        if (!address) {
          console.error("Error: Address (IP or Domain) is required.");
          process.exit(1);
        }
        const apiKey = args[3] || "ssdb_" + crypto.randomBytes(16).toString("hex");
        await db.put("config:server:" + address, JSON.stringify({ registeredAt: Date.now(), apiKey, status: "allowed" }));
        console.log(`Successfully allowed server: ${address}`);
        console.log(`Used API Key: ${apiKey}`);
      } else if (subCommand === "remove") {
        const address = args[2];
        if (!address) {
          console.error("Error: Address (IP or Domain) is required.");
          process.exit(1);
        }
        await db.del("config:server:" + address);
        console.log(`Successfully removed server: ${address}`);
      } else if (subCommand === "list") {
        console.log(`\nAllowed Remote Servers:`);
        console.log(`------------------------`);
        let count = 0;
        for await (const [key, val] of db.iterator({ gte: "config:server:", lte: "config:server:\xff" })) {
          const addr = key.substring("config:server:".length);
          let apiKey = "(None)";
          try {
            const data = JSON.parse(val);
            if (data.apiKey) {
              apiKey = data.apiKey;
            }
          } catch (e) {}
          console.log(`- ${addr}  (API Key: ${apiKey})`);
          count++;
        }
        if (count === 0) {
          console.log(`(No remote servers allowed yet. Access is currently deny-all.)`);
        }
        console.log("");
      }

      await client.close();
      process.exit(0);
    } catch (err: any) {
      console.error("Failed to manage servers:", err.message);
      process.exit(1);
    }
  } else if (command === "subaccount") {
    const subCommand = args[1];
    if (!subCommand || !["create", "remove", "list"].includes(subCommand)) {
      console.error("Error: Subcommand 'create', 'remove', or 'list' is required.");
      printHelp();
      process.exit(1);
    }

    try {
      console.log(`Opening database at ${dbPath}...`);
      const client = await connect({
        storagePath: dbPath
      });
      const db = (client as any).db;

      if (subCommand === "create") {
        const username = getFlagValue("--username");
        const password = getFlagValue("--password");
        const role = getFlagValue("--role") || "junior";

        if (!username || !password) {
          console.error("Error: Both --username and --password are required.");
          process.exit(1);
        }
        if (!["junior", "senior"].includes(role)) {
          console.error("Error: Invalid role. Must be 'junior' or 'senior'.");
          process.exit(1);
        }

        // Ask for admin password
        const adminPass = await promptPassword("Enter Admin Password to verify: ");
        if (!adminPass) {
          console.error("Error: Admin password verification required.");
          process.exit(1);
        }

        // Fetch stored admin credentials
        const storedCreds = await (client as any).getCredentials();
        const adminHash = crypto.createHash("sha256").update(adminPass).digest("hex");

        if (adminHash !== storedCreds.passwordHash) {
          console.error("Error: Invalid Admin Password. Operation aborted.");
          process.exit(1);
        }

        const passwordHash = crypto.createHash("sha256").update(password).digest("hex");
        await db.put("config:subaccount:" + username, JSON.stringify({
          passwordHash,
          role,
          createdAt: Date.now()
        }));
        console.log(`Successfully created sub-account: ${username} (${role})`);

      } else if (subCommand === "remove") {
        const username = args[2];
        if (!username) {
          console.error("Error: Username is required.");
          process.exit(1);
        }

        // Ask for admin password
        const adminPass = await promptPassword("Enter Admin Password to verify: ");
        if (!adminPass) {
          console.error("Error: Admin password verification required.");
          process.exit(1);
        }

        // Fetch stored admin credentials
        const storedCreds = await (client as any).getCredentials();
        const adminHash = crypto.createHash("sha256").update(adminPass).digest("hex");

        if (adminHash !== storedCreds.passwordHash) {
          console.error("Error: Invalid Admin Password. Operation aborted.");
          process.exit(1);
        }

        // Check if subaccount exists
        try {
          await db.get("config:subaccount:" + username);
          await db.del("config:subaccount:" + username);
          console.log(`Successfully removed sub-account: ${username}`);
        } catch (e) {
          console.error(`Error: Sub-account "${username}" not found.`);
        }

      } else if (subCommand === "list") {
        console.log(`\nRegistered Sub-accounts:`);
        console.log(`------------------------`);
        let count = 0;
        for await (const [key, val] of db.iterator({ gte: "config:subaccount:", lte: "config:subaccount:\xff" })) {
          const username = key.substring("config:subaccount:".length);
          let role = "junior";
          try {
            const data = JSON.parse(val);
            if (data.role) role = data.role;
          } catch (e) {}
          console.log(`- ${username}  (Role: ${role})`);
          count++;
        }
        if (count === 0) {
          console.log(`(No sub-accounts registered yet.)`);
        }
        console.log("");
      }

      await client.close();
      process.exit(0);
    } catch (err: any) {
      console.error("Failed to manage sub-accounts:", err.message);
      process.exit(1);
    }
  } else {
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
  }
}

main().catch(err => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
