import { parseConnectionString } from "../mod.ts";

Deno.test("Deno public entrypoint parses gRPC connection URIs", () => {
  const parsed = parseConnectionString(
    "ssdiskdb+grpc://token@localhost:8971/server-a",
  );
  if (parsed.grpcTarget !== "localhost:8971") {
    throw new Error("Deno entrypoint did not parse the gRPC target");
  }
  if (parsed.apiKey !== "token" || parsed.serverId !== "server-a") {
    throw new Error("Deno entrypoint did not parse connection credentials");
  }
});
