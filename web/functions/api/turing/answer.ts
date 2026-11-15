import { ensureTable, err, json, type Env } from "./_shared";

interface Round {
  id: string;
  set: "raw" | "harmonized";
  modis_is: "a" | "b";
}

export const onRequestPost = async ({ request, env }: { request: Request; env: Env }) => {
  let body: { round_id?: unknown; choice?: unknown };
  try {
    body = await request.json();
  } catch {
    return err("invalid_geometry", "Send JSON with round_id and choice.", 422);
  }
  const rounds = (await (await env.ASSETS.fetch(new URL("/static/turing_rounds.json", request.url).toString())).json()) as { rounds: Round[] };
  const r = rounds.rounds.find((x) => x.id === body.round_id);
  if (!r) return err("not_found", "Unknown round.", 404);
  if (body.choice !== "a" && body.choice !== "b") return err("invalid_geometry", "choice must be 'a' or 'b'.", 422);
  const ok = body.choice === r.modis_is;
  try {
    await ensureTable(env);
    await env.DB.prepare("INSERT INTO answers (set_name, correct, ts) VALUES (?, ?, ?)").bind(r.set, ok ? 1 : 0, Date.now()).run();
  } catch {
    // the answer is still checked when the database is unavailable
  }
  return json({ correct: ok, modis_is: r.modis_is });
};
