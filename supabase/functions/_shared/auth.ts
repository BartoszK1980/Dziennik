// Wspolny helper auth dla edge functions Dziennika.
// Akceptuje albo Supabase JWT (Authorization: Bearer <jwt>), albo dlugoterminowy API token
// w formacie `dzn_<base64url>`. Token jest przechowywany w tabeli public.api_tokens jako sha256(hex).

import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

export class AuthError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
  }
}

export type AuthMode = "jwt" | "api_token";

export interface ResolvedAuth {
  userId: string;
  supabase: SupabaseClient;
  mode: AuthMode;
}

async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Zwraca user_id i klienta Supabase odpowiedniego dla tej autoryzacji.
 *
 * - api_token: klient z service_role; **kazde** zapytanie musi jawnie filtrowac po user_id.
 * - jwt: klient z anon key + JWT; RLS jest aktywny i sam ogranicza wiersze do user_id.
 *
 * Rzuca AuthError gdy brak/zly token.
 */
export async function resolveUser(req: Request): Promise<ResolvedAuth> {
  const header = req.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) {
    throw new AuthError("Brak naglowka Authorization");
  }
  const token = header.slice("Bearer ".length).trim();
  if (!token) {
    throw new AuthError("Pusty token");
  }

  if (token.startsWith("dzn_")) {
    if (!SUPABASE_SERVICE_ROLE_KEY) {
      throw new AuthError("Brak SUPABASE_SERVICE_ROLE_KEY w edge function", 500);
    }
    const hash = await sha256Hex(token);
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await admin
      .from("api_tokens")
      .select("id, user_id, revoked_at")
      .eq("token_hash", hash)
      .maybeSingle();
    if (error) throw new AuthError(`api_tokens lookup: ${error.message}`, 500);
    if (!data || data.revoked_at) {
      throw new AuthError("Nieprawidlowy lub odwolany token");
    }
    // fire-and-forget: zaktualizuj last_used_at, ale nie blokuj odpowiedzi
    admin
      .from("api_tokens")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", data.id)
      .then(() => {}, () => {});

    return { userId: data.user_id as string, supabase: admin, mode: "api_token" };
  }

  // JWT path
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: header } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await client.auth.getUser();
  if (userErr || !userData.user) {
    throw new AuthError("Sesja wygasla lub niepoprawna");
  }
  return { userId: userData.user.id, supabase: client, mode: "jwt" };
}

/**
 * Dzisiejsza data YYYY-MM-DD w strefie Europe/Warsaw.
 * Uzywamy Intl, zeby uniknac zaleznosci od tz hosta edge function.
 */
export function todayInWarsaw(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // en-CA daje "YYYY-MM-DD"
  return fmt.format(new Date());
}

export function isYmd(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}
