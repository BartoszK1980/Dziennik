-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding column to notes table (OpenAI text-embedding-3-small = 1536 dims).
-- One vector per note, no chunking. Populated by the embed-notes edge function.
ALTER TABLE public.notes ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- Uwaga: brak indeksu ANN (IVFFLAT/HNSW) — przy obecnym rozmiarze tabeli (~200 wierszy)
-- sekwencyjny skan z operatorem <=> jest wystarczajacy i dokladniejszy. Indeks warto
-- dodac dopiero przy znaczaco wiekszej liczbie wpisow.
