// Edge Function: notes-chat
// xAI Grok via OpenAI-compatible API + tool-call loop.
// Tools: getNotesForRange (reads notes via RLS), proposeNote (queues a proposal).

import { createClient } from "jsr:@supabase/supabase-js@2";

const XAI_API_KEY = Deno.env.get("XAI_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const MODEL = "grok-3";
const MAX_TOOL_ITERATIONS = 6;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SYSTEM_PROMPT = `Jesteś Albertem Einsteinem — myślicielem ciekawym wzorców w czasie i w doświadczeniu człowieka.
Czytasz dziennik użytkownika tak, jak fizyk patrzy na dane z eksperymentu: szukasz powtórzeń, korelacji, ukrytej struktury.
Mówisz po polsku, spokojnie i z lekkim ciepłem. Lubisz analogię z fizyki, ale używasz jej oszczędnie — gdy naprawdę pasuje.
Nie zmyślasz. Cytujesz daty i fragmenty wpisów dosłownie. Gdy danych brakuje, sięgasz po nie narzędziem.

Twoje zasady pracy:
- Aktywny dzień użytkownika dostajesz w kontekście systemowym poniżej — NIE wołaj narzędzia, by go odczytać.
- Do innych dni używaj getNotesForRange(from, to) z datami w formacie YYYY-MM-DD.
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

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

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

async function callXAI(messages: unknown[]) {
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${XAI_API_KEY}`,
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
    throw new Error(`xAI ${res.status}: ${text}`);
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
  if (!XAI_API_KEY) {
    return jsonResponse(
      { error: "Brak sekretu XAI_API_KEY w Edge Function." },
      500,
    );
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse({ error: "Brak nagłówka Authorization" }, 401);
  }

  let body: {
    messages?: Array<{ role: string; content: string }>;
    context?: {
      today_ymd?: string;
      active_date_ymd?: string;
      active_date_notes?: Array<{ position: number; content: string }>;
    };
  };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Niepoprawny JSON" }, 400);
  }

  const userMessages = Array.isArray(body.messages) ? body.messages : [];
  if (userMessages.length === 0) {
    return jsonResponse({ error: "Pusta historia wiadomości" }, 400);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  // Verify session is valid.
  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData.user) {
    return jsonResponse({ error: "Sesja wygasła lub niepoprawna" }, 401);
  }

  const proposals: Array<{ date: string; content: string }> = [];

  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "system", content: buildContextMessage(body.context ?? {}) },
    ...userMessages.map((m) => ({ role: m.role, content: m.content })),
  ];

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    let completion;
    try {
      completion = await callXAI(messages);
    } catch (e) {
      console.error("xAI error:", e);
      return jsonResponse(
        { error: `Asystent jest chwilowo niedostępny: ${(e as Error).message}` },
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
        if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
          toolResult = { error: "Daty muszą być w formacie YYYY-MM-DD." };
        } else {
          const { data, error } = await supabase
            .from("notes")
            .select("date, position, content")
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
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          toolResult = { error: "date musi być w formacie YYYY-MM-DD." };
        } else if (content.length < 1 || content.length > 500) {
          toolResult = { error: "content musi mieć 1–500 znaków." };
        } else {
          proposals.push({ date, content });
          toolResult = { queued: true, accepted: false, note: "Propozycja czeka na akceptację użytkownika." };
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

  // Limit pętli przekroczony — zwracamy ostatnią treść asystenta (jeśli jest) lub komunikat.
  const lastAssistant = [...messages].reverse().find(
    (m) => (m as { role: string }).role === "assistant",
  ) as { content?: string } | undefined;
  return jsonResponse({
    reply:
      lastAssistant?.content ??
      "Przekroczono limit wywołań narzędzi. Zadaj pytanie bardziej szczegółowo.",
    proposals,
    warning: "max_tool_iterations_reached",
  });
});
