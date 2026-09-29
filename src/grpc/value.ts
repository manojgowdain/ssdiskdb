export interface ProtoValue {
  encoding: "JSON" | "BYTES" | number;
  payload: Buffer;
}

export function encodeValue(value: any): ProtoValue {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { encoding: "BYTES", payload: Buffer.from(value) };
  }
  return {
    encoding: "JSON",
    payload: Buffer.from(JSON.stringify(value === undefined ? null : value), "utf8")
  };
}

export function decodeValue(value?: ProtoValue): any {
  if (!value || value.payload == null) throw new TypeError("A protobuf value is required");
  const payload = Buffer.from(value.payload);
  if (value.encoding === "BYTES" || value.encoding === 1) return payload;
  try {
    return JSON.parse(payload.toString("utf8"));
  } catch {
    throw new TypeError("The protobuf JSON value is malformed");
  }
}
import { Buffer } from "node:buffer";
