// Edge Function: add-entry
// POST { content: string, date?: "YYYY-MM-DD", mood?: 1-5 }
// Autoryzacja: Bearer JWT lub Bearer dzn_<token>.

import {
  AuthError,
  CORS_HEADERS,
  isYmd,
  jsonResponse,
  resolveUser,
  todayInWarsaw,
} from "../_shared/auth.ts";

const MAX_CONTENT = 500;
const DAILY_LIMIT = 5;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let auth;
  try {
    auth = await resolveUser(req);
  } catch (e) {
    const err = e as AuthError;
    return jsonResponse({ error: err.message }, err.status ?? 401);
  }
  const { userId, supabase } = auth;

  let body: { content?: unknown; date?: unknown; mood?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Niepoprawny JSON" }, 400);
  }

  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (content.length < 1 || content.length > MAX_CONTENT) {
    return jsonResponse(
      { error: `content musi miec 1-${MAX_CONTENT} znakow po trim.` },
      400,
    );
  }

  const date = body.date === undefined || body.date === null
    ? todayInWarsaw()
    : body.date;
  if (!isYmd(date)) {
    return jsonResponse({ error: "date musi byc w formacie YYYY-MM-DD." }, 400);
  }

  let mood: number | null = null;
  if (body.mood !== undefined && body.mood !== null) {
    const m = Number(body.mood);
    if (!Number.isInteger(m) || m < 1 || m > 5) {
      return jsonResponse({ error: "mood musi byc liczba calkowita 1-5." }, 400);
    }
    mood = m;
  }

  // Policz istniejace wpisy dnia (jawny filtr na user_id — dziala dla obu trybow auth).
  const { count, error: countErr } = await supabase
    .from("notes")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("date", date);
  if (countErr) {
    return jsonResponse({ error: `count: ${countErr.message}` }, 500);
  }
  const existing = count ?? 0;
  if (existing >= DAILY_LIMIT) {
    return jsonResponse(
      {
        error: `Limit ${DAILY_LIMIT} wpisow na dzien osiagniety.`,
        date,
        count: existing,
      },
      409,
    );
  }

  const position = existing + 1;
  const { data: inserted, error: insErr } = await supabase
    .from("notes")
    .insert({ user_id: userId, date, position, content })
    .select("id, position, content, created_at")
    .single();
  if (insErr) {
    return jsonResponse({ error: `insert: ${insErr.message}` }, 500);
  }

  let savedMood: number | null = null;
  if (mood !== null) {
    const { error: moodErr } = await supabase
      .from("day_moods")
      .upsert(
        { user_id: userId, date, mood, updated_at: new Date().toISOString() },
        { onConflict: "user_id,date" },
      );
    if (moodErr) {
      // Wpis dodany — mood nie. Sygnalizujemy w response, ale nie wycofujemy wpisu.
      return jsonResponse(
        {
          id: inserted.id,
          date,
          position: inserted.position,
          content: inserted.content,
          mood: null,
          warning: `mood upsert failed: ${moodErr.message}`,
        },
        200,
      );
    }
    savedMood = mood;
  }

  return jsonResponse({
    id: inserted.id,
    date,
    position: inserted.position,
    content: inserted.content,
    mood: savedMood,
  });
});
