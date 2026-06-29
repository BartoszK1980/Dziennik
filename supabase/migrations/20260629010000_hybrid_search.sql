-- Wyszukiwanie hybrydowe: laczy search wektorowy (pgvector, cosine) z klasycznym
-- (full-text 'simple' + pg_trgm) i scala oba rankingi metoda RRF (Reciprocal Rank Fusion).
--
-- Funkcja search_notes_hybrid liczy oba podzapytania w jednym przebiegu i zwraca
-- jedna, posortowana liste. Embedding zapytania powstaje po stronie edge function
-- (klucz OpenAI) i jest tu przekazywany jako gotowy wektor.

-- pg_trgm: similarity() + operatory dla dopasowan czastkowych / literowek.
-- (full-text search / tsvector jest wbudowany w Postgresa.)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Indeksy pomocnicze. Przy ~200 wierszach seq scan i tak wystarcza, ale sa tanie
-- i przygotowuja baze na wzrost.
CREATE INDEX IF NOT EXISTS notes_content_fts_idx
  ON public.notes USING gin (to_tsvector('simple', content));

CREATE INDEX IF NOT EXISTS notes_content_trgm_idx
  ON public.notes USING gin (content gin_trgm_ops);

-- RRF stala wygladzajaca (standardowo 60): wieksza -> mniejsze roznice miedzy pozycjami.
-- SECURITY INVOKER (domyslnie): sciezka JWT pozostaje ograniczona przez RLS,
-- a kazdy CTE i tak jawnie filtruje po p_user_id (potrzebne dla service_role / API token).
CREATE OR REPLACE FUNCTION public.search_notes_hybrid(
  p_user_id uuid,
  query_embedding vector(1536),
  query_text text,
  match_count int DEFAULT 30
)
RETURNS TABLE (
  id uuid,
  date date,
  "position" smallint,
  content text,
  score double precision,
  in_vec boolean,
  in_kw boolean
)
LANGUAGE sql
STABLE
AS $$
  WITH vec AS (
    SELECT
      n.id,
      row_number() OVER (ORDER BY n.embedding <=> query_embedding) AS rank_vec
    FROM public.notes n
    WHERE n.user_id = p_user_id
      AND n.embedding IS NOT NULL
    ORDER BY n.embedding <=> query_embedding
    LIMIT match_count
  ),
  kw AS (
    SELECT
      n.id,
      row_number() OVER (
        ORDER BY
          ts_rank(to_tsvector('simple', n.content), websearch_to_tsquery('simple', query_text)) DESC,
          similarity(n.content, query_text) DESC
      ) AS rank_kw
    FROM public.notes n
    WHERE n.user_id = p_user_id
      AND (
        to_tsvector('simple', n.content) @@ websearch_to_tsquery('simple', query_text)
        OR similarity(n.content, query_text) > 0.1
      )
    ORDER BY
      ts_rank(to_tsvector('simple', n.content), websearch_to_tsquery('simple', query_text)) DESC,
      similarity(n.content, query_text) DESC
    LIMIT match_count
  ),
  fused AS (
    SELECT
      COALESCE(vec.id, kw.id) AS id,
      COALESCE(1.0 / (60 + vec.rank_vec), 0.0)
        + COALESCE(1.0 / (60 + kw.rank_kw), 0.0) AS score,
      vec.id IS NOT NULL AS in_vec,
      kw.id IS NOT NULL AS in_kw
    FROM vec
    FULL OUTER JOIN kw ON vec.id = kw.id
  )
  SELECT
    n.id,
    n.date,
    n."position",
    n.content,
    f.score,
    f.in_vec,
    f.in_kw
  FROM fused f
  JOIN public.notes n ON n.id = f.id
  ORDER BY f.score DESC
  LIMIT match_count;
$$;
