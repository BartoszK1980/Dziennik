// Vercel serverless function: MCP server dla Dziennika.
//
// Transport: HTTP JSON-RPC (stateless). Kompatybilny z Claude Code, Claude Desktop, Cursor.
// Auth: Bearer dzn_<token> w naglowku Authorization. Token waliduje gateway Supabase
//       przy wywolaniu odpowiedniej Edge Function — tu tylko forwardujemy naglowek.
//
// Tools:
//   - add_entry(content, date?, mood?)  -> POST add-entry
//   - get_entry(date?)                  -> GET  get-entry?date=...
//   - ask(question, date?)              -> POST notes-chat
//
// Endpoint:   POST /api/mcp     -> JSON-RPC request, JSON-RPC response
//             GET  /api/mcp     -> krotki opis (do debugu z przegladarki)
//             OPTIONS /api/mcp  -> CORS preflight

import type { VercelRequest, VercelResponse } from "@vercel/node";

const SUPABASE_FUNCTIONS_URL =
  process.env.SUPABASE_FUNCTIONS_URL ??
  "https://kkegymepatwufnemtldr.functions.supabase.co";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_NAME = "dziennik-mcp";
const SERVER_VERSION = "1.0.0";

const TOOLS = [
  {
    name: "add_entry",
    description:
      "Dodaje wpis do dziennika autoryzowanego uzytkownika. Maks. 5 wpisow na dzien, " +
      "1-500 znakow. Domyslna data to dzis (Europe/Warsaw).",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "Tresc wpisu, 1-500 znakow po trim.",
        },
        date: {
          type: "string",
          description: "Data wpisu w formacie YYYY-MM-DD. Domyslnie dzis.",
        },
        mood: {
          type: "integer",
          minimum: 1,
          maximum: 5,
          description: "Nastroj dnia w skali 1-5. Opcjonalny.",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "get_entry",
    description:
      "Zwraca wszystkie wpisy z wybranego dnia (do 5) oraz nastroj dnia. " +
      "Domyslnie zwraca dzisiaj (Europe/Warsaw).",
    inputSchema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description: "Data YYYY-MM-DD. Domyslnie dzis.",
        },
      },
    },
  },
  {
    name: "ask",
    description:
      "Pyta asystenta (Albert Einstein) o wpisy z dziennika. Asystent ma dostep do " +
      "narzedzi czytajacych zakresy dat i moze proponowac nowe notatki (proposals). " +
      "Zwraca tekst odpowiedzi + ewentualne propozycje.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "Pytanie po polsku.",
        },
        date: {
          type: "string",
          description:
            "Aktywny (kontekstowy) dzien YYYY-MM-DD. Wpisy z niego trafiaja do kontekstu. Domyslnie dzis.",
        },
      },
      required: ["question"],
    },
  },
];

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function rpcError(id: unknown, code: number, message: string, data?: unknown) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, data },
  };
}

function setCors(res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "authorization, content-type, mcp-protocol-version, mcp-session-id",
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

async function callEdgeFunction(
  fnName: string,
  method: "GET" | "POST",
  authHeader: string,
  body?: unknown,
  query?: Record<string, string>,
): Promise<{ status: number; data: unknown }> {
  const url = new URL(`${SUPABASE_FUNCTIONS_URL}/${fnName}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v) url.searchParams.set(k, v);
    }
  }
  const init: RequestInit = {
    method,
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
  };
  if (method === "POST") {
    init.body = JSON.stringify(body ?? {});
  }
  const res = await fetch(url.toString(), init);
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = { error: `Niepoprawny JSON z ${fnName}`, status: res.status };
  }
  return { status: res.status, data };
}

function toToolContent(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function toToolError(message: string) {
  return {
    content: [{ type: "text" as const, text: `Blad: ${message}` }],
    isError: true,
  };
}

async function handleRpc(
  rpc: JsonRpcRequest,
  authHeader: string | undefined,
): Promise<unknown> {
  switch (rpc.method) {
    case "initialize":
      return rpcResult(rpc.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });

    case "notifications/initialized":
    case "notifications/cancelled":
      // Notyfikacje nie maja odpowiedzi.
      return undefined;

    case "ping":
      return rpcResult(rpc.id, {});

    case "tools/list":
      return rpcResult(rpc.id, { tools: TOOLS });

    case "tools/call": {
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return rpcResult(rpc.id, toToolError(
          "Brak naglowka Authorization: Bearer dzn_<token>. Wygeneruj token w /docs.",
        ));
      }
      const params = rpc.params ?? {};
      const name = String(params.name ?? "");
      const args = (params.arguments ?? {}) as Record<string, unknown>;

      if (name === "add_entry") {
        const body: Record<string, unknown> = { content: args.content };
        if (args.date !== undefined) body.date = args.date;
        if (args.mood !== undefined) body.mood = args.mood;
        const { status, data } = await callEdgeFunction(
          "add-entry",
          "POST",
          authHeader,
          body,
        );
        if (status >= 400) {
          const msg = (data as { error?: string })?.error ?? `HTTP ${status}`;
          return rpcResult(rpc.id, toToolError(msg));
        }
        return rpcResult(rpc.id, toToolContent(data));
      }

      if (name === "get_entry") {
        const date = args.date ? String(args.date) : undefined;
        const { status, data } = await callEdgeFunction(
          "get-entry",
          "GET",
          authHeader,
          undefined,
          date ? { date } : undefined,
        );
        if (status >= 400) {
          const msg = (data as { error?: string })?.error ?? `HTTP ${status}`;
          return rpcResult(rpc.id, toToolError(msg));
        }
        return rpcResult(rpc.id, toToolContent(data));
      }

      if (name === "ask") {
        const body: Record<string, unknown> = { question: args.question };
        if (args.date !== undefined) body.date = args.date;
        const { status, data } = await callEdgeFunction(
          "notes-chat",
          "POST",
          authHeader,
          body,
        );
        if (status >= 400) {
          const msg = (data as { error?: string })?.error ?? `HTTP ${status}`;
          return rpcResult(rpc.id, toToolError(msg));
        }
        return rpcResult(rpc.id, toToolContent(data));
      }

      return rpcResult(rpc.id, toToolError(`Nieznany tool: ${name}`));
    }

    default:
      return rpcError(rpc.id, -32601, `Method not found: ${rpc.method}`);
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method === "GET") {
    res.status(200).json({
      server: SERVER_NAME,
      version: SERVER_VERSION,
      protocol: PROTOCOL_VERSION,
      transport: "http (json-rpc, stateless)",
      docs: "https://bartoszk1980.github.io/Dziennik/docs/",
      tools: TOOLS.map((t) => t.name),
      hint:
        "Wyslij POST z body JSON-RPC 2.0. Naglowek Authorization: Bearer dzn_<token> wymagany dla tools/call.",
    });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json(rpcError(null, -32600, "Method not allowed"));
    return;
  }

  const authHeader = req.headers.authorization;

  // Vercel parsuje body automatycznie dla application/json.
  const rawBody = req.body as unknown;
  if (!rawBody || typeof rawBody !== "object") {
    res.status(400).json(rpcError(null, -32700, "Parse error: oczekiwano JSON"));
    return;
  }

  // Batch lub pojedyncze zadanie.
  if (Array.isArray(rawBody)) {
    const responses: unknown[] = [];
    for (const item of rawBody) {
      const r = await handleRpc(item as JsonRpcRequest, authHeader);
      if (r !== undefined) responses.push(r);
    }
    res.status(200).json(responses);
    return;
  }

  const rpc = rawBody as JsonRpcRequest;
  if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
    res.status(400).json(
      rpcError(rpc.id ?? null, -32600, "Invalid Request: brak jsonrpc/method"),
    );
    return;
  }

  const response = await handleRpc(rpc, authHeader);
  if (response === undefined) {
    // Notyfikacja — bez body.
    res.status(204).end();
    return;
  }
  res.status(200).json(response);
}
