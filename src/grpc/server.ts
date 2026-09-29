import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import type { SSDiskDBClient, BatchOperation, MSetEntry, ScanOptions } from "../index.ts";
import { validateApiKey } from "../core/auth.ts";
import { scopedClient } from "../core/namespace.ts";
import { decodeValue, encodeValue, ProtoValue } from "./value.ts";

export interface GrpcServerOptions {
  host?: string;
  port?: number;
  privateKey?: Buffer | string;
  certChain?: Buffer | string;
  rootCert?: Buffer | string;
  requireClientCertificate?: boolean;
  maxMessageBytes?: number;
  maxBatchOperations?: number;
}

export interface GrpcServerHandle {
  address: string;
  close(): Promise<void>;
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

type ValueMessage = ProtoValue;

function mapError(error: unknown): grpc.ServiceError {
  const err = error as Error & { code?: string };
  const code = err instanceof RangeError || err instanceof TypeError
    ? grpc.status.INVALID_ARGUMENT
    : err.code === "LEVEL_LOCKED" || err.code === "LEVEL_DATABASE_NOT_OPEN"
      ? grpc.status.FAILED_PRECONDITION
      : grpc.status.INTERNAL;
  const message = code === grpc.status.INTERNAL ? "Internal database error" : err.message;
  return Object.assign(new Error(message), { code, details: message, metadata: new grpc.Metadata() });
}

export async function startGrpcServer(
  database: SSDiskDBClient,
  options: GrpcServerOptions = {}
): Promise<GrpcServerHandle> {
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
  const maxMessageBytes = options.maxMessageBytes ?? 16 * 1024 * 1024;
  const maxBatchOperations = options.maxBatchOperations ?? 1000;
  const server = new grpc.Server({
    "grpc.max_receive_message_length": maxMessageBytes,
    "grpc.max_send_message_length": maxMessageBytes,
    "grpc.keepalive_time_ms": 60_000,
    "grpc.keepalive_timeout_ms": 20_000
  });

  const authorize = async (call: grpc.ServerUnaryCall<any, any>, expectedServerId?: string): Promise<SSDiskDBClient> => {
    const metadataServerId = call.metadata.get("x-ssdiskdb-server-id")[0];
    const serverId = String(metadataServerId || "");
    const authorization = call.metadata.get("authorization")[0];
    const match = typeof authorization === "string" ? authorization.match(/^Bearer\s+(.+)$/i) : null;
    if (!serverId || !match) {
      const error = new Error("Authentication required");
      Object.assign(error, { code: grpc.status.UNAUTHENTICATED, details: error.message, metadata: new grpc.Metadata() });
      throw error;
    }
    if (expectedServerId && expectedServerId !== serverId) {
      const error = new Error("Server identity mismatch");
      Object.assign(error, { code: grpc.status.PERMISSION_DENIED, details: error.message, metadata: new grpc.Metadata() });
      throw error;
    }
    const peer = call.getPeer();
    const ip = peer.startsWith("ipv4:") ? peer.split(":")[1] : peer.replace(/^ipv6:/, "").replace(/^\[|\]:\d+$/g, "");
    if (!(await validateApiKey(database, ip, serverId, match[1]))) {
      const error = new Error("Invalid API key or server registration");
      Object.assign(error, { code: grpc.status.UNAUTHENTICATED, details: error.message, metadata: new grpc.Metadata() });
      throw error;
    }
    return serverId === "Local" ? database : scopedClient(database, serverId);
  };

  const unary = (operation: (client: SSDiskDBClient, request: any) => Promise<any>) =>
    (call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) => {
      void (async () => {
        try {
          const client = await authorize(call);
          callback(null, await operation(client, call.request));
        } catch (error) {
          callback((error as any)?.code ? error as grpc.ServiceError : mapError(error), null);
        }
      })();
    };

  const checkBatchSize = (size: number) => {
    if (size > maxBatchOperations) {
      const error = new Error(`Batch exceeds the ${maxBatchOperations} operation limit`);
      Object.assign(error, { code: grpc.status.RESOURCE_EXHAUSTED, details: error.message, metadata: new grpc.Metadata() });
      throw error;
    }
  };

  const implementation = {
    handshake: (call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) => {
      void authorize(call, call.request.serverId).then(() => callback(null, { accepted: true, serverId: call.request.serverId }))
        .catch((error) => callback((error as any)?.code ? error as grpc.ServiceError : mapError(error), null));
    },
    get: unary(async (client, request) => {
      const value = await client.get(request.key);
      return { found: value !== undefined, value: value === undefined ? undefined : encodeValue(value) };
    }),
    set: unary(async (client, request) => ({
      affected: await client.set(request.key, decodeValue(request.value), request.hasTtl ? { ttl: request.ttlMs } : undefined)
    })),
    delete: unary(async (client, request) => ({ affected: await client.del(request.key) })),
    exists: unary(async (client, request) => ({ exists: await client.exists(request.key) })),
    incr: unary(async (client, request) => ({ value: await client.incr(request.key, request.amount || 1) })),
    expire: unary(async (client, request) => ({ value: await client.expire(request.key, request.ttlMs) })),
    ttl: unary(async (client, request) => ({ ttlMs: await client.ttl(request.key) })),
    persist: unary(async (client, request) => ({ value: await client.persist(request.key) })),
    mGet: unary(async (client, request) => {
      checkBatchSize(request.keys.length);
      const values = await client.mget(request.keys);
      return { values: values.map((value) => ({ found: value !== undefined, value: value === undefined ? undefined : encodeValue(value) })) };
    }),
    mSet: unary(async (client, request) => {
      checkBatchSize(request.entries.length);
      const entries: MSetEntry[] = request.entries.map((entry: any) => ({
        key: entry.key,
        value: decodeValue(entry.value),
        ...(entry.hasTtl ? { ttl: entry.ttlMs } : {})
      }));
      return { affected: await client.mset(entries) };
    }),
    mDelete: unary(async (client, request) => {
      checkBatchSize(request.keys.length);
      return { affected: await client.mdelete(request.keys) };
    }),
    batch: unary(async (client, request) => {
      checkBatchSize(request.operations.length);
      const operations: BatchOperation[] = request.operations.map((operation: any) => operation.set
        ? {
          type: "set",
          key: operation.set.key,
          value: decodeValue(operation.set.value),
          ...(operation.set.hasTtl ? { ttl: operation.set.ttlMs } : {})
        }
        : { type: "delete", key: operation.deleteKey });
      return { affected: await client.batch(operations) };
    }),
    hashGet: unary(async (client, request) => {
      const value = await client.hget(request.name, request.field);
      return { found: value !== undefined, value: value === undefined ? undefined : encodeValue(value) };
    }),
    hashSet: unary(async (client, request) => ({
      affected: await client.hset(request.name, request.field, decodeValue(request.value), request.hasTtl ? { ttl: request.ttlMs } : undefined)
    })),
    hashDelete: unary(async (client, request) => ({ affected: await client.hdel(request.name, request.field) })),
    zGet: unary(async (client, request) => {
      const value = await client.zget(request.name, request.member);
      return { found: value !== undefined, value: value === undefined ? undefined : encodeValue(value) };
    }),
    zSet: unary(async (client, request) => ({
      affected: await client.zset(request.name, request.member, request.score, request.hasTtl ? { ttl: request.ttlMs } : undefined)
    })),
    zDelete: unary(async (client, request) => ({ affected: await client.zdel(request.name, request.member) })),
    scan: unary(async (client, request) => {
      const result = await client.scan({
        prefix: request.prefix,
        limit: request.limit || 100,
        cursor: request.cursor || undefined
      } as ScanOptions);
      return {
        cursor: result.cursor || "",
        hasMore: result.cursor !== null,
        entries: result.entries.map((entry) => ({ key: entry.key, value: encodeValue(entry.value) }))
      };
    }),
    getAllKeys: unary(async (client) => ({
      entries: (await client.getAllKeys()).map((entry) => ({ key: entry.key, value: encodeValue(entry.value) }))
    })),
    stats: unary(async (client) => client.stats()),
    flush: unary(async (client) => {
      await client.flush();
      return { affected: 1 };
    }),
    streamScan: async (call: grpc.ServerWritableStream<any, any>) => {
      try {
        const client = await authorize(call as any);
        let cursor: string | undefined;
        do {
          const result = await client.scan({ prefix: call.request.prefix, limit: 500, cursor });
          for (const entry of result.entries) {
            if (!call.write({ key: entry.key, value: encodeValue(entry.value) })) await once(call, "drain");
          }
          cursor = result.cursor || undefined;
        } while (cursor);
        call.end();
      } catch (error) {
        call.destroy((error as any)?.code ? error as Error : mapError(error));
      }
    }
  };

  server.addService(Service.service, implementation);
  const tlsConfigured = options.privateKey !== undefined || options.certChain !== undefined || options.rootCert !== undefined;
  let credentials: grpc.ServerCredentials = grpc.ServerCredentials.createInsecure();
  if (tlsConfigured) {
    if (!options.privateKey || !options.certChain) throw new TypeError("TLS requires both privateKey and certChain");
    credentials = grpc.ServerCredentials.createSsl(
      options.rootCert ? Buffer.from(options.rootCert) : null,
      [{ private_key: Buffer.from(options.privateKey), cert_chain: Buffer.from(options.certChain) }],
      options.requireClientCertificate ?? false
    );
  }
  const host = options.host ?? "0.0.0.0";
  const port = options.port ?? 8972;
  const boundPort = await new Promise<number>((resolve, reject) => {
    server.bindAsync(`${host}:${port}`, credentials, (error, bound) => error ? reject(error) : resolve(bound));
  });
  return {
    address: `${host === "0.0.0.0" ? "127.0.0.1" : host}:${boundPort}`,
    close: () => new Promise<void>((resolve) => server.tryShutdown(() => resolve()))
  };
}
import { Buffer } from "node:buffer";
