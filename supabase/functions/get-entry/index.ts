// Edge Function: get-entry
// GET /get-entry?date=YYYY-MM-DD   (date opcjonalne — domyslnie dzisiaj w Europe/Warsaw)
// Autoryzacja: Bearer JWT lub Bearer dzn_<token>.
// Zwraca: { date, notes: [{id, position, content, created_at, updated_at}], mood: 1-5|null }

import {
  AuthError,
  CORS_HEADERS,
  isYmd,
  jsonResponse,
  resolveUser,
  todayInWarsaw,
} from "../_shared/auth.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "GET" && req.method !== "POST") {
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

  // date z query (GET) lub z body (POST — wygoda dla skryptow).
  let dateParam: unknown = new URL(req.url).searchParams.get("date");
  if (!dateParam && req.method === "POST") {
    try {
      const body = await req.json();
      dateParam = body?.date;
    } catch {
      // brak/zly body — uzyj domyslnej
    }
  }
  const date = dateParam ? dateParam : todayInWarsaw();
  if (!isYmd(date)) {
    return jsonResponse({ error: "date musi byc w formacie YYYY-MM-DD." }, 400);
  }

  const [notesRes, moodRes] = await Promise.all([
    supabase
      .from("notes")
      .select("id, position, content, created_at, updated_at")
      .eq("user_id", userId)
      .eq("date", date)
      .order("position", { ascending: true }),
    supabase
      .from("day_moods")
      .select("mood")
      .eq("user_id", userId)
      .eq("date", date)
      .maybeSingle(),
  ]);

  if (notesRes.error) {
    return jsonResponse({ error: `notes: ${notesRes.error.message}` }, 500);
  }
  if (moodRes.error) {
    return jsonResponse({ error: `mood: ${moodRes.error.message}` }, 500);
  }

  return jsonResponse({
    date,
    notes: notesRes.data ?? [],
    mood: moodRes.data?.mood ?? null,
  });
});
