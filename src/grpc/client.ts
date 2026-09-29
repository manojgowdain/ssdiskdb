import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import fs from "node:fs";
import path from "node:path";
import type { SSDiskDBClient, SetOptions, MSetEntry, BatchOperation, ScanOptions, ScanResult } from "../index.ts";
import { decrypt, encrypt, encryptBuffer, decryptBuffer } from "../core/encryption.ts";
import { StatsSnapshot } from "../core/metrics.ts";
import { decodeValue, encodeValue } from "./value.ts";

export interface GrpcTlsClientOptions {
  rootCert?: Buffer | string;
  privateKey?: Buffer | string;
  certChain?: Buffer | string;
  serverName?: string;
}

export interface GrpcClientOptions {
  target: string;
  apiKey: string;
  serverId: string;
  encryptionKey?: string;
  tls?: GrpcTlsClientOptions;
  requestTimeoutMs?: number;
  maxMessageBytes?: number;
  keepaliveTimeMs?: number;
}

function protoFilePath(): string {
  const fromBuild = typeof __dirname === "string"
    ? path.resolve(__dirname, "../../../proto/ssdiskdb.proto")
    : "";
  const candidates = [fromBuild, path.resolve(process.cwd(), "proto/ssdiskdb.proto"), path.resolve(process.cwd(), "node_modules/ssdiskdb/proto/ssdiskdb.proto")];
  const found = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  if (!found) throw new Error("SSDiskDB protobuf schema is missing from this installation");
  return found;
}

function bytes(value?: Buffer | string): Buffer | null {
  return value === undefined ? null : Buffer.isBuffer(value) ? value : Buffer.from(value);
}

export class GrpcSSDiskDBClient implements SSDiskDBClient {
  private readonly client: any;
  private readonly metadata: grpc.Metadata;
  private readonly timeoutMs: number;
  private dashboardServer: any;
  private closed = false;

  constructor(private readonly options: GrpcClientOptions) {
    const definition = protoLoader.loadSync(protoFilePath(), {
      keepCase: false,
      longs: Number,
      enums: String,
      defaults: true,
      oneofs: true,
      bytes: Buffer
    });
    const packageDefinition = grpc.loadPackageDefinition(definition) as any;
    const Service = packageDefinition.ssdiskdb.v1.SSDiskDB;
    const tls = options.tls;
    const credentials = tls
      ? grpc.credentials.createSsl(bytes(tls.rootCert), bytes(tls.privateKey), bytes(tls.certChain))
      : grpc.credentials.createInsecure();
    const maxMessageBytes = options.maxMessageBytes ?? 16 * 1024 * 1024;
    this.client = new Service(options.target, credentials, {
      "grpc.max_receive_message_length": maxMessageBytes,
      "grpc.max_send_message_length": maxMessageBytes,
      "grpc.keepalive_time_ms": options.keepaliveTimeMs ?? 60_000,
      "grpc.keepalive_timeout_ms": 20_000,
      ...(tls?.serverName ? { "grpc.ssl_target_name_override": tls.serverName, "grpc.default_authority": tls.serverName } : {})
    });
    this.metadata = new grpc.Metadata();
    this.metadata.set("authorization", `Bearer ${options.apiKey}`);
    this.metadata.set("x-ssdiskdb-server-id", options.serverId);
    this.timeoutMs = options.requestTimeoutMs ?? 5000;
  }

  /** The long-lived gRPC stub reused for every RPC on this client. */
  get grpcStub(): unknown {
    return this.client;
  }

  async handshake(): Promise<void> {
    const response = await this.call("handshake", { serverId: this.options.serverId });
    if (!response.accepted) throw new Error("gRPC server rejected the client handshake");
  }

  private call(method: string, request: any): Promise<any> {
    if (this.closed) return Promise.reject(new Error("gRPC client is closed"));
    return new Promise((resolve, reject) => {
      this.client[method](request, this.metadata, { deadline: Date.now() + this.timeoutMs }, (error: grpc.ServiceError | null, response: any) => {
        if (error) {
          const safe = new Error(error.details || error.message);
          (safe as any).code = error.code;
          reject(safe);
        } else resolve(response);
      });
    });
  }

  private encodeClientValue(value: any): any {
    if (!this.options.encryptionKey) return encodeValue(value);
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      return { encoding: "BYTES", payload: encryptBuffer(Buffer.from(value), this.options.encryptionKey) };
    }
    const serialized = JSON.stringify(value === undefined ? null : value);
    return encodeValue(encrypt(serialized, this.options.encryptionKey));
  }

  private decodeClientValue(value: any): any {
    const decoded = decodeValue(value);
    if (this.options.encryptionKey && Buffer.isBuffer(decoded)) {
      return decryptBuffer(decoded, this.options.encryptionKey);
    }
    if (!this.options.encryptionKey || typeof decoded !== "string") return decoded;
    const plaintext = decrypt(decoded, this.options.encryptionKey);
    if (plaintext.startsWith("ssdiskdb:bytes:")) return Buffer.from(plaintext.substring(15), "base64");
    try {
      return JSON.parse(plaintext);
    } catch {
      return plaintext;
    }
  }

  async set(key: string, value: any, options: SetOptions = {}): Promise<number> {
    const response = await this.call("set", {
      key,
      value: this.encodeClientValue(value),
      hasTtl: options.ttl !== undefined,
      ttlMs: options.ttl ?? 0
    });
    return response.affected;
  }

  async get(key: string): Promise<any> {
    const response = await this.call("get", { key });
    return response.found ? this.decodeClientValue(response.value) : undefined;
  }

  async del(key: string): Promise<number> {
    return (await this.call("delete", { key })).affected;
  }

  async exists(key: string): Promise<boolean> {
    return (await this.call("exists", { key })).exists;
  }

  async incr(key: string, num = 1): Promise<number> {
    return (await this.call("incr", { key, amount: num })).value;
  }

  async expire(key: string, ttl: number): Promise<boolean> {
    return (await this.call("expire", { key, ttlMs: ttl })).value;
  }

  async ttl(key: string): Promise<number> {
    return (await this.call("ttl", { key })).ttlMs;
  }

  async persist(key: string): Promise<boolean> {
    return (await this.call("persist", { key })).value;
  }

  async mget(keys: string[]): Promise<any[]> {
    const response = await this.call("mGet", { keys });
    return response.values.map((item: any) => item.found ? this.decodeClientValue(item.value) : undefined);
  }

  async mset(entries: MSetEntry[]): Promise<number> {
    const normalized = entries.map((entry) => Array.isArray(entry)
      ? { key: entry[0], value: entry[1], ttl: undefined }
      : { key: entry.key, value: entry.value, ttl: entry.ttl });
    const request = normalized.map((entry) => ({
      key: entry.key,
      value: this.encodeClientValue(entry.value),
      hasTtl: entry.ttl !== undefined,
      ttlMs: entry.ttl ?? 0
    }));
    return (await this.call("mSet", { entries: request })).affected;
  }

  async mdelete(keys: string[]): Promise<number> {
    return (await this.call("mDelete", { keys })).affected;
  }

  async batch(operations: BatchOperation[]): Promise<number> {
    const request = operations.map((operation) => operation.type === "set"
      ? { set: { key: operation.key, value: this.encodeClientValue(operation.value), hasTtl: operation.ttl !== undefined, ttlMs: operation.ttl ?? 0 } }
      : { deleteKey: operation.key });
    return (await this.call("batch", { operations: request })).affected;
  }

  async hset(name: string, key: string, value: any, options: SetOptions = {}): Promise<number> {
    return (await this.call("hashSet", {
      name,
      field: key,
      value: this.encodeClientValue(value),
      hasTtl: options.ttl !== undefined,
      ttlMs: options.ttl ?? 0
    })).affected;
  }

  async hget(name: string, key: string): Promise<any> {
    const response = await this.call("hashGet", { name, field: key });
    return response.found ? this.decodeClientValue(response.value) : undefined;
  }

  async hdel(name: string, key: string): Promise<number> {
    return (await this.call("hashDelete", { name, field: key })).affected;
  }

  async zset(name: string, key: string, score: number, options: SetOptions = {}): Promise<number> {
    return (await this.call("zSet", {
      name,
      member: key,
      score,
      hasTtl: options.ttl !== undefined,
      ttlMs: options.ttl ?? 0
    })).affected;
  }

  async zget(name: string, key: string): Promise<any> {
    const response = await this.call("zGet", { name, member: key });
    return response.found ? this.decodeClientValue(response.value) : undefined;
  }

  async zdel(name: string, key: string): Promise<number> {
    return (await this.call("zDelete", { name, member: key })).affected;
  }

  async scan(options: ScanOptions = {}): Promise<ScanResult> {
    const response = await this.call("scan", {
      prefix: options.prefix ?? "",
      limit: options.limit ?? 100,
      cursor: options.cursor ?? ""
    });
    return {
      cursor: response.hasMore ? response.cursor : null,
      entries: response.entries.map((entry: any) => ({ key: entry.key, value: this.decodeClientValue(entry.value) }))
    };
  }

  async *streamScan(options: ScanOptions = {}): AsyncIterable<{ key: string; value: any }> {
    const stream = this.client.streamScan({
      prefix: options.prefix ?? "",
      limit: options.limit ?? 500,
      cursor: options.cursor ?? ""
    }, this.metadata, { deadline: Date.now() + this.timeoutMs });
    for await (const entry of stream as AsyncIterable<any>) {
      yield { key: entry.key, value: this.decodeClientValue(entry.value) };
    }
  }

  async getAllKeys(): Promise<Array<{ key: string; value: any }>> {
    const response = await this.call("getAllKeys", {});
    return response.entries.map((entry: any) => ({ key: entry.key, value: this.decodeClientValue(entry.value) }));
  }

  async stats(): Promise<StatsSnapshot> {
    return this.call("stats", {});
  }

  async flush(): Promise<void> {
    await this.call("flush", {});
  }

  async startDashboard(port = 8971): Promise<void> {
    if (this.dashboardServer) return;
    const { startDashboardServer } = await import("../dashboard");
    this.dashboardServer = await startDashboardServer(this, port, async () => ({ username: "admin", passwordHash: "" }));
  }

  async close(): Promise<void> {
    if (this.dashboardServer) {
      await this.dashboardServer.close();
      this.dashboardServer = undefined;
    }
    this.closed = true;
    this.client.close();
  }

  async setCredentials(): Promise<void> {
    throw new Error("Method not supported on a remote client connection");
  }

  async getCredentials(): Promise<{ username: string; passwordHash: string }> {
    throw new Error("Method not supported on a remote client connection");
  }

  async startGrpcServer(): Promise<string> {
    throw new Error("Cannot start a gRPC server from a remote connection");
  }
}
import { Buffer } from "node:buffer";
