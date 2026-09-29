/**
 * Key Encoder
 *
 * Centralized, deterministic key construction. The on-disk data-key format is
 * UNCHANGED from the original SSDiskDB so that every existing LevelDB database
 * opens and reads without migration:
 *
 *   String:          s:<key>
 *   Hash field:      h:<name>:<field>
 *   ZSet member:     z:<name>:<member>
 *   Remote client:   s:client:<serverId>:<key> / h:client:<serverId>:<name>:<field> / z:client:<serverId>:<name>:<member>
 *
 * The TTL expiration index uses a separate, ordered namespace so LevelDB range
 * iteration over it is cheap and does not collide with data keys:
 *
 *   ttl/<expiresAt:019d>/<prefix>/<key>
 *
 * expiresAt is zero-padded to 19 digits (max uint64) so lexicographic order
 * equals chronological order. Range iteration from `ttl/000...` to the current
 * time yields exactly the expired entries, oldest first.
 */

export const PREFIX_STRING = "s";
export const PREFIX_HASH = "h";
export const PREFIX_ZSET = "z";
export const PREFIX_CLIENT = "client";
export const PREFIX_CONFIG = "config";
export const PREFIX_TTL_INDEX = "ttl";

export type Kind = "string" | "hash" | "zset";

export function dataKey(kind: Kind, name: string, key?: string): string {
  if (kind === "string") {
    return key === undefined ? `${PREFIX_STRING}:${name}` : `${PREFIX_STRING}:${name}:${key}`;
  }
  return key === undefined ? `${PREFIX_HASH}:${name}` : `${PREFIX_HASH}:${name}:${key}`;
}

export function clientDataKey(kind: Kind, serverId: string, name: string, key?: string): string {
  const base = `${PREFIX_STRING}:client:${serverId}`;
  if (kind === "string") {
    return key === undefined ? `${base}:${name}` : `${base}:${name}:${key}`;
  }
  return key === undefined ? `${PREFIX_HASH}:${base}:${name}` : `${PREFIX_HASH}:${base}:${name}:${key}`;
}

export function configKey(suffix: string): string {
  return `${PREFIX_CONFIG}:${suffix}`;
}

/**
 * Encode an expiration index key.
 *
 *   ttl/<19-digit-expiresAt>/<fullDataKey>
 *
 * The full data key (e.g. `s:client:server-a:my/key`) is appended verbatim
 * after the second slash, so keys containing slashes do not break parsing:
 * parse by locating the first two slashes only.
 */
export function ttlIndexKey(expiresAt: number, fullDataKey: string): string {
  const ts = String(Math.max(0, Math.floor(expiresAt))).padStart(19, "0");
  return `${PREFIX_TTL_INDEX}/${ts}/${fullDataKey}`;
}

/** Range over every index entry whose expiresAt <= nowMs. */
export function ttlIndexRange(nowMs: number): { gte: string; lte: string } {
  const end = String(Math.floor(nowMs)).padStart(19, "0");
  return { gte: `${PREFIX_TTL_INDEX}/0000000000000000000/`, lte: `${PREFIX_TTL_INDEX}/${end}/￿` };
}

/** Parse the data prefix (`s`, `h`, `z`) out of a raw LevelDB key. */
export function parseKind(rawKey: string): Kind | "client" | "config" | "unknown" {
  if (rawKey.startsWith("s:client:")) return "client";
  if (rawKey.startsWith("h:client:")) return "client";
  if (rawKey.startsWith("z:client:")) return "client";
  if (rawKey.startsWith("s:")) return "string";
  if (rawKey.startsWith("h:")) return "hash";
  if (rawKey.startsWith("z:")) return "zset";
  if (rawKey.startsWith("config:")) return "config";
  return "unknown";
}