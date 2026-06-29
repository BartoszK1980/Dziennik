// Edge Function: embed-notes
// Generuje embeddingi (OpenAI text-embedding-3-small, 1536 wymiarow) dla wpisow
// uzytkownika, ktore jeszcze ich nie maja. Jeden wpis = jeden wektor, bez chunkowania.
//
// POST (body opcjonalne): { batchSize?: number }  — ile wpisow na jedno wywolanie OpenAI (domyslnie 100)
// Autoryzacja: Bearer JWT lub Bearer dzn_<token>. Embeduje tylko wpisy zalogowanego user_id.
//
// Sekret wymagany w Edge Function: OPENAI_API_KEY.

import {
  AuthError,
  CORS_HEADERS,
  jsonResponse,
  resolveUser,
} from "../_shared/auth.ts";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const EMBEDDING_MODEL = "text-embedding-3-small";
const OPENAI_BATCH = 100; // OpenAI przyjmuje wiele inputow na raz

interface NoteRow {
  id: string;
  content: string;
}

async function embedBatch(inputs: string[]): Promise<number[][]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: inputs,
      encoding_format: "float",
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI ${res.status}: ${text}`);
  }
  const json = await res.json();
  // Zachowaj kolejnosc — OpenAI zwraca data[] z polem index.
  const sorted = (json.data as Array<{ index: number; embedding: number[] }>)
    .slice()
    .sort((a, b) => a.index - b.index);
  return sorted.map((d) => d.embedding);
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

  let batchSize = OPENAI_BATCH;
  try {
    const body = await req.json();
    if (typeof body?.batchSize === "number" && body.batchSize > 0) {
      batchSize = Math.min(body.batchSize, OPENAI_BATCH);
    }
  } catch {
    // body opcjonalne
  }

  // Pobierz wpisy bez embeddingu (jawny filtr na user_id — dziala dla JWT i service_role).
  const { data: notes, error: fetchErr } = await supabase
    .from("notes")
    .select("id, content")
    .eq("user_id", userId)
    .is("embedding", null);

  if (fetchErr) {
    return jsonResponse({ error: `notes lookup: ${fetchErr.message}` }, 500);
  }
  const pending = (notes ?? []) as NoteRow[];
  if (pending.length === 0) {
    return jsonResponse({ done: true, embedded: 0, message: "Wszystkie wpisy maja juz embeddingi." });
  }

  let embedded = 0;
  for (let i = 0; i < pending.length; i += batchSize) {
    const slice = pending.slice(i, i + batchSize);
    let vectors: number[][];
    try {
      vectors = await embedBatch(slice.map((n) => n.content));
    } catch (e) {
      return jsonResponse(
        { error: `OpenAI embeddings: ${(e as Error).message}`, embedded },
        502,
      );
    }

    // Zapisz embeddingi (pgvector przyjmuje tekstowy format "[...]").
    for (let j = 0; j < slice.length; j++) {
      const { error: updErr } = await supabase
        .from("notes")
        .update({ embedding: JSON.stringify(vectors[j]) })
        .eq("id", slice[j].id)
        .eq("user_id", userId);
      if (updErr) {
        return jsonResponse(
          { error: `update ${slice[j].id}: ${updErr.message}`, embedded },
          500,
        );
      }
      embedded++;
    }
  }

  return jsonResponse({ done: true, embedded, total: pending.length });
});
