export async function validateApiKey(
  client: unknown,
  ip: string,
  serverId?: string,
  apiKey?: string
): Promise<boolean> {
  if (!apiKey) return false;
  const db = (client as any).db;
  if (!db) return false;
  const cleanIp = ip.startsWith("::ffff:") ? ip.substring(7) : ip;

  for (const identity of [serverId, cleanIp, ip]) {
    if (!identity) continue;
    try {
      const raw = await db.get(`config:server:${identity}`);
      if (!raw) continue;
      const data = JSON.parse(String(raw));
      if (data.status === "blocked") return false;
      if (data.apiKey === apiKey) return true;
    } catch (error) {
      if (!(error as any)?.notFound && (error as any)?.code !== "LEVEL_NOT_FOUND") continue;
    }
  }
  return false;
}
