-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding column to notes table
ALTER TABLE public.notes ADD COLUMN embedding vector(1536);

-- Create index for similarity search (optional, but recommended for performance)
CREATE INDEX ON public.notes USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
