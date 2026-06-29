#!/usr/bin/env node

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

const supabaseUrl = process.env.SUPABASE_URL || 'https://kkegymepatwufnemtldr.supabase.co';
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const openaiApiKey = process.env.OPENAI_API_KEY;

if (!openaiApiKey) {
  console.error('Error: OPENAI_API_KEY not found in .env');
  process.exit(1);
}

if (!supabaseKey) {
  console.error('Error: SUPABASE_ANON_KEY not found in .env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
const openai = new OpenAI({ apiKey: openaiApiKey });

async function generateEmbeddings() {
  try {
    console.log('Starting embedding generation...');

    // Fetch all notes without embeddings
    const { data: notes, error: fetchError } = await supabase
      .from('notes')
      .select('id, content')
      .is('embedding', null);

    if (fetchError) {
      console.error('Error fetching notes:', fetchError);
      process.exit(1);
    }

    console.log(`Found ${notes.length} notes without embeddings`);

    if (notes.length === 0) {
      console.log('All notes already have embeddings!');
      process.exit(0);
    }

    // Process notes in batches to avoid rate limiting
    const batchSize = 10;
    for (let i = 0; i < notes.length; i += batchSize) {
      const batch = notes.slice(i, i + batchSize);
      console.log(`Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(notes.length / batchSize)}`);

      // Generate embeddings for batch
      const embeddingsPromises = batch.map(note =>
        openai.embeddings.create({
          model: 'text-embedding-3-small',
          input: note.content,
          encoding_format: 'float',
        })
      );

      const embeddingsResults = await Promise.all(embeddingsPromises);

      // Update database with embeddings
      const updatePromises = batch.map((note, idx) => {
        const embedding = embeddingsResults[idx].data[0].embedding;
        return supabase
          .from('notes')
          .update({ embedding })
          .eq('id', note.id);
      });

      const updateResults = await Promise.all(updatePromises);

      // Check for errors
      const hasError = updateResults.some(r => r.error);
      if (hasError) {
        console.error('Error updating embeddings:', updateResults.find(r => r.error)?.error);
        process.exit(1);
      }

      console.log(`✓ Processed ${Math.min(i + batchSize, notes.length)}/${notes.length} notes`);

      // Rate limiting: wait between batches
      if (i + batchSize < notes.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    console.log('✓ All embeddings generated successfully!');
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

generateEmbeddings();
