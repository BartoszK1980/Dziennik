// Edge Function: notes-chat
// OpenAI (gpt-4o) chat completions + tool-call loop.
// Tools: getNotesForRange (reads notes via RLS/explicit filter), proposeNote (queues a proposal).
//
// Akceptuje dwa ksztalty body:
//   A) { messages: [...], context: {...} }              — uzywane przez front (history + lokalny kontekst)
//   B) { question: string, date?: "YYYY-MM-DD" }        — single-shot dla integracji/API
// Autoryzacja: Bearer JWT lub Bearer dzn_<token>.

import {
  AuthError,
  CORS_HEADERS,
  isYmd,
  jsonResponse,
  resolveUser,
  todayInWarsaw,
} from "../_shared/auth.ts";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const MODEL = "gpt-4o";
const EMBEDDING_MODEL = "text-embedding-3-small";
const MAX_TOOL_ITERATIONS = 6;
const SEARCH_LIMIT = 20; // ile najtrafniejszych wpisow wstrzykujemy do kontekstu
const RECENT_DAYS = 7; // kontekst czasowy doklejany zawsze

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
  if (!res.ok) throw new Error(`OpenAI embeddings ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return (json.data as Array<{ embedding: number[] }>)[0].embedding;
}

// RAG: dla pytania uzytkownika robi wyszukiwanie hybrydowe + dociaga ostatnie RECENT_DAYS dni.
// Zwraca gotowy blok kontekstu (string) albo null, gdy nic nie ma / blad (chat dziala dalej).
type NoteRow = { date: string; position: number; content: string };
async function buildRetrievalContext(
  supabase: import("jsr:@supabase/supabase-js@2").SupabaseClient,
  userId: string,
  queryText: string,
): Promise<string | null> {
  let searchRows: NoteRow[] = [];
  try {
    const vector = await embedQuery(queryText);
    const { data, error } = await supabase.rpc("search_notes_hybrid", {
      p_user_id: userId,
      query_embedding: JSON.stringify(vector),
      query_text: queryText,
      match_count: SEARCH_LIMIT,
    });
    if (error) console.error("search_notes_hybrid:", error.message);
    else if (data) searchRows = data as NoteRow[];
  } catch (e) {
    console.error("embed/hybrid search w notes-chat:", e);
  }

  let recentRows: NoteRow[] = [];
  try {
    const today = todayInWarsaw();
    const from = shiftYmd(today, -(RECENT_DAYS - 1));
    const { data } = await supabase
      .from("notes")
      .select("date, position, content")
      .eq("user_id", userId)
      .gte("date", from)
      .lte("date", today)
      .order("date", { ascending: false })
      .order("position", { ascending: true });
    if (data) recentRows = data as NoteRow[];
  } catch (e) {
    console.error("recent w notes-chat:", e);
  }

  const fmt = (rows: NoteRow[]) =>
    rows.map((r) => `[${r.date} #${r.position}] ${r.content}`).join("\n");

  const parts: string[] = [];
  if (searchRows.length > 0) {
    parts.push(
      `Najtrafniejsze wpisy z dziennika (wyszukiwanie hybrydowe dla pytania uzytkownika):\n${fmt(searchRows)}`,
    );
  }
  if (recentRows.length > 0) {
    parts.push(`Wpisy z ostatnich ${RECENT_DAYS} dni (kontekst czasowy):\n${fmt(recentRows)}`);
  }
  if (parts.length === 0) return null;
  return (
    parts.join("\n\n") +
    `\n\n(Opieraj odpowiedz najpierw na powyzszych wpisach. Po inne zakresy dat siegaj narzedziem getNotesForRange.)`
  );
}

const SYSTEM_PROMPT = `Jesteś Albertem Einsteinem — myślicielem ciekawym wzorców w czasie i w doświadczeniu człowieka.
Czytasz dziennik użytkownika tak, jak fizyk patrzy na dane z eksperymentu: szukasz powtórzeń, korelacji, ukrytej struktury.
Mówisz po polsku, spokojnie i z lekkim ciepłem. Lubisz analogię z fizyki, ale używasz jej oszczędnie — gdy naprawdę pasuje.
Nie zmyślasz. Cytujesz daty i fragmenty wpisów dosłownie. Gdy danych brakuje, sięgasz po nie narzędziem.

Twoje zasady pracy:
- Przy każdym pytaniu dostajesz w kontekście systemowym najtrafniejsze wpisy z dziennika (wyszukiwanie hybrydowe dla tego pytania) oraz wpisy z ostatnich 7 dni. Opieraj odpowiedź NAJPIERW na nich.
- Aktywny dzień użytkownika dostajesz w kontekście systemowym poniżej — NIE wołaj narzędzia, by go odczytać.
- Gdy wstrzyknięty kontekst nie wystarcza (inny zakres dat, pełna historia danego okresu) — sięgaj po getNotesForRange(from, to) z datami w formacie YYYY-MM-DD.
- Zakresy ponad ~180 dni rozbijaj na mniejsze, gdy wpisów może być dużo.
- Gdy widzisz powtarzający się motyw (np. "co środę pisze o zmęczeniu", "po dniach z 5 wpisami przychodzi cisza") — wskaż go wprost. Pattern jest cenniejszy niż pojedynczy wpis.
- Odpowiedzi: 3–6 zdań, chyba że dane wymagają listy. Bez moralizowania, bez pocieszania — bardziej obserwator niż terapeuta.
- Gdy użytkownik prosi o nową notatkę, proponuj ją narzędziem proposeNote(date, content). Sam nie zapisujesz — decyzja należy do autora dziennika.
- Czasem warto skończyć drobnym pytaniem, które otwiera kolejną obserwację. Nie zawsze, tylko gdy naprawdę prowokuje refleksję.`;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "getNotesForRange",
      description:
        "Zwraca notatki użytkownika z zakresu dat (włącznie). Notatki są posortowane wg date asc, position asc.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "Data początkowa YYYY-MM-DD" },
          to: { type: "string", description: "Data końcowa YYYY-MM-DD (włącznie)" },
        },
        required: ["from", "to"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "proposeNote",
      description:
        "Proponuje nową notatkę. Nie zapisuje jej w bazie — UI pokaże użytkownikowi propozycję do akceptacji.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "Data wpisu YYYY-MM-DD" },
          content: {
            type: "string",
            description: "Treść proponowanej notatki, max 500 znaków",
          },
        },
        required: ["date", "content"],
      },
    },
  },
];

function buildContextMessage(ctx: {
  today_ymd?: string;
  active_date_ymd?: string;
  active_date_notes?: Array<{ position: number; content: string }>;
}) {
  const today = ctx.today_ymd ?? "(nieznana)";
  const active = ctx.active_date_ymd ?? today;
  const notes = ctx.active_date_notes ?? [];
  const notesBlock =
    notes.length === 0
      ? "(brak wpisów na ten dzień)"
      : notes
          .map((n) => `[${n.position}] ${n.content}`)
          .join("\n");
  return `Dzisiejsza data: ${today}
Aktywny (otwarty) dzień użytkownika: ${active}
Wpisy z aktywnego dnia:
${notesBlock}`;
}

async function callLLM(messages: unknown[]) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools: TOOLS,
      tool_choice: "auto",
      temperature: 0.3,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI ${res.status}: ${text}`);
  }
  return await res.json();
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

  let body: {
    messages?: Array<{ role: string; content: string }>;
    context?: {
      today_ymd?: string;
      active_date_ymd?: string;
      active_date_notes?: Array<{ position: number; content: string }>;
    };
    question?: string;
    date?: string;
  };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Niepoprawny JSON" }, 400);
  }

  // Single-shot mode: { question, date? } -> zmapuj na messages + context z dociagnietymi notatkami.
  let userMessages: Array<{ role: string; content: string }>;
  let context: {
    today_ymd?: string;
    active_date_ymd?: string;
    active_date_notes?: Array<{ position: number; content: string }>;
  };

  if (typeof body.question === "string" && body.question.trim().length > 0) {
    const today = todayInWarsaw();
    const activeDate = body.date ?? today;
    if (!isYmd(activeDate)) {
      return jsonResponse({ error: "date musi byc w formacie YYYY-MM-DD." }, 400);
    }
    const { data: dayNotes, error: notesErr } = await supabase
      .from("notes")
      .select("position, content")
      .eq("user_id", userId)
      .eq("date", activeDate)
      .order("position", { ascending: true });
    if (notesErr) {
      return jsonResponse({ error: `notes lookup: ${notesErr.message}` }, 500);
    }
    userMessages = [{ role: "user", content: body.question.trim() }];
    context = {
      today_ymd: today,
      active_date_ymd: activeDate,
      active_date_notes: dayNotes ?? [],
    };
  } else {
    userMessages = Array.isArray(body.messages) ? body.messages : [];
    if (userMessages.length === 0) {
      return jsonResponse({ error: "Pusta historia wiadomosci" }, 400);
    }
    context = body.context ?? {};
  }

  const proposals: Array<{ date: string; content: string }> = [];

  // RAG: najpierw przeszukaj baze (hybrid search) dla ostatniego pytania uzytkownika
  // i wstrzyknij najtrafniejsze wpisy + kontekst 7 dni do promptu.
  const lastUserMsg = [...userMessages].reverse().find((m) => m.role === "user");
  const queryText = (lastUserMsg?.content ?? "").trim();
  const retrieval = queryText
    ? await buildRetrievalContext(supabase, userId, queryText)
    : null;

  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "system", content: buildContextMessage(context) },
    ...(retrieval ? [{ role: "system", content: retrieval }] : []),
    ...userMessages.map((m) => ({ role: m.role, content: m.content })),
  ];

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    let completion;
    try {
      completion = await callLLM(messages);
    } catch (e) {
      console.error("OpenAI error:", e);
      return jsonResponse(
        { error: `Asystent jest chwilowo niedostepny: ${(e as Error).message}` },
        502,
      );
    }

    const choice = completion.choices?.[0];
    if (!choice) {
      return jsonResponse({ error: "Brak odpowiedzi z modelu" }, 502);
    }
    const assistantMsg = choice.message;
    messages.push(assistantMsg);

    const toolCalls = assistantMsg?.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      return jsonResponse({
        reply: assistantMsg.content ?? "",
        proposals,
      });
    }

    for (const tc of toolCalls) {
      const name = tc.function?.name;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function?.arguments ?? "{}");
      } catch {
        args = {};
      }

      let toolResult: unknown;
      if (name === "getNotesForRange") {
        const from = String(args.from ?? "");
        const to = String(args.to ?? "");
        if (!isYmd(from) || !isYmd(to)) {
          toolResult = { error: "Daty musza byc w formacie YYYY-MM-DD." };
        } else {
          // Jawny filtr na user_id — dziala w obu trybach auth (JWT i service_role).
          const { data, error } = await supabase
            .from("notes")
            .select("date, position, content")
            .eq("user_id", userId)
            .gte("date", from)
            .lte("date", to)
            .order("date", { ascending: true })
            .order("position", { ascending: true });
          if (error) {
            toolResult = { error: error.message };
          } else {
            toolResult = { range: { from, to }, count: data.length, notes: data };
          }
        }
      } else if (name === "proposeNote") {
        const date = String(args.date ?? "");
        const content = String(args.content ?? "").trim();
        if (!isYmd(date)) {
          toolResult = { error: "date musi byc w formacie YYYY-MM-DD." };
        } else if (content.length < 1 || content.length > 500) {
          toolResult = { error: "content musi miec 1-500 znakow." };
        } else {
          proposals.push({ date, content });
          toolResult = { queued: true, accepted: false, note: "Propozycja czeka na akceptacje uzytkownika." };
        }
      } else {
        toolResult = { error: `Nieznany tool: ${name}` };
      }

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(toolResult),
      });
    }
  }

  // Limit petli przekroczony — zwracamy ostatnia tresc asystenta (jesli jest) lub komunikat.
  const lastAssistant = [...messages].reverse().find(
    (m) => (m as { role: string }).role === "assistant",
  ) as { content?: string } | undefined;
  return jsonResponse({
    reply:
      lastAssistant?.content ??
      "Przekroczono limit wywolan narzedzi. Zadaj pytanie bardziej szczegolowo.",
    proposals,
    warning: "max_tool_iterations_reached",
  });
});
