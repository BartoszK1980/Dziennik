// Edge Function: search-notes
// Wyszukiwanie hybrydowe po wpisach zalogowanego uzytkownika: laczy search wektorowy
// (OpenAI text-embedding-3-small, 1536 wymiarow) z klasycznym (full-text + pg_trgm),
// scalajac oba rankingi metoda RRF w funkcji SQL public.search_notes_hybrid.
//
// POST { query: string, limit?: number }  — limit zaciskany do 1..50 (domyslnie 30).
// Autoryzacja: Bearer JWT lub Bearer dzn_<token>. Szuka tylko we wpisach swojego user_id.
//
// Sekret wymagany w Edge Function: OPENAI_API_KEY (ten sam, ktorego uzywa embed-notes).

import {
  AuthError,
  CORS_HEADERS,
  jsonResponse,
  resolveUser,
  todayInWarsaw,
} from "../_shared/auth.ts";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 50;
const RECENT_DAYS = 7; // kontekst czasowy: zawsze doklejamy wpisy z ostatnich N dni

// Odejmuje `days` dni od daty YYYY-MM-DD (arytmetyka w UTC, bez wplywu strefy).
function shiftYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

async function embedQuery(input: string): Promise<number[]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: [input],
      encoding_format: "float",
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI ${res.status}: ${text}`);
  }
  const json = await res.json();
  return (json.data as Array<{ embedding: number[] }>)[0].embedding;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }
  if (!OPENAI_API_KEY) {
    return jsonResponse(
      { error: "Brak sekretu OPENAI_API_KEY w Edge Function." },
      500,
    );
  }

  let auth;
  try {
    auth = await resolveUser(req);
  } catch (e) {
    const err = e as AuthError;
    return jsonResponse({ error: err.message }, err.status ?? 401);
  }
  const { userId, supabase } = auth;

  let query = "";
  let limit = DEFAULT_LIMIT;
  try {
    const body = await req.json();
    if (typeof body?.query === "string") query = body.query.trim();
    if (typeof body?.limit === "number" && body.limit > 0) {
      limit = Math.min(Math.floor(body.limit), MAX_LIMIT);
    }
  } catch {
    // brak/niepoprawne body
  }
  if (!query) {
    return jsonResponse({ error: "Brak frazy wyszukiwania (query)." }, 400);
  }

  let vector: number[];
  try {
    vector = await embedQuery(query);
  } catch (e) {
    return jsonResponse(
      { error: `OpenAI embeddings: ${(e as Error).message}` },
      502,
    );
  }

  const { data, error } = await supabase.rpc("search_notes_hybrid", {
    p_user_id: userId,
    query_embedding: JSON.stringify(vector),
    query_text: query,
    match_count: limit,
  });

  if (error) {
    return jsonResponse({ error: `search rpc: ${error.message}` }, 500);
  }

  // Kontekst czasowy: niezaleznie od trafien doklejamy wpisy z ostatnich RECENT_DAYS dni.
  const today = todayInWarsaw();
  const from = shiftYmd(today, -(RECENT_DAYS - 1)); // wlacznie z dzisiaj => okno N dni
  const { data: recent } = await supabase
    .from("notes")
    .select("id, date, position, content")
    .eq("user_id", userId)
    .gte("date", from)
    .lte("date", today)
    .order("date", { ascending: false })
    .order("position", { ascending: true });

  return jsonResponse({ results: data ?? [], recent: recent ?? [] });
});
