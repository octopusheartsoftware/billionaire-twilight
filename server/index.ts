// Supabase Edge Function: Billionaire Twilight game API.
// The game logic lives in engine/, bundled to server/bundle.mjs with:
//   npx esbuild engine/api.js --bundle --format=esm --minify --platform=neutral --outfile=server/bundle.mjs
// The deployed function imports that bundle from GitHub pinned to an exact commit.
// After changing engine/, rebuild the bundle, push, and redeploy with the new commit hash.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { handle } from "https://raw.githubusercontent.com/octopusheartsoftware/billionaire-twilight/a0b98f52cd1ae25faace5a3310b363e873f6ffe5/server/bundle.mjs";

const URL = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(URL, KEY, { auth: { persistSession: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Tell every phone in the room "something changed": an instant broadcast,
// plus a row change in game_signals as a backup path.
async function signal(code: string, version: number, status: string) {
  await Promise.allSettled([
    fetch(`${URL}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: KEY, Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ messages: [{ topic: `room-${code}`, event: "update", payload: { version, status } }] }),
    }),
    sb.from("game_signals").upsert({ code, version, status, updated_at: new Date().toISOString() }),
  ]);
}

const db = {
  async load(code: string) {
    const { data, error } = await sb.from("games").select("code,version,status,data").eq("code", code).maybeSingle();
    if (error) throw error;
    return data;
  },
  async insert(code: string, row: any) {
    const { error } = await sb.from("games").insert({ code, version: row.version, status: row.status, data: row.data });
    if (error) { if ((error as any).code === "23505") return false; throw error; }
    await signal(code, row.version, row.status);
    return true;
  },
  async update(code: string, row: any, expected: number) {
    const { data, error } = await sb.from("games")
      .update({ version: row.version, status: row.status, data: row.data, updated_at: new Date().toISOString() })
      .eq("code", code).eq("version", expected).select("code");
    if (error) throw error;
    if (!data || data.length !== 1) return false;
    await signal(code, row.version, row.status);
    return true;
  },
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "POST only" }), { status: 405, headers: { ...CORS, "Content-Type": "application/json" } });
  }
  let body: any = {};
  try { body = await req.json(); } catch { /* empty body */ }
  const res = await handle(body, db);
  return new Response(JSON.stringify(res.json), { status: res.status, headers: { ...CORS, "Content-Type": "application/json" } });
});
