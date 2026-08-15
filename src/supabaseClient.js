// supabaseClient.js
// Conexiunea de bază către Supabase — un singur loc, folosit peste tot în aplicație.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://jcdsamfsqfcjryrxftsb.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpjZHNhbWZzcWZjanJ5cnhmdHNiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM5NjY3MDAsImV4cCI6MjA5OTU0MjcwMH0.mJOYPwiAb1lq2uI-t5t3m-B5aS3KGV9vxggbal6l64E";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Construiește exact același email sintetic pe care-l generează și Edge Function-ul
// "creeaza-utilizator" — determinist, ca aplicația să-l poată reconstitui la fiecare logare,
// fără să fie nevoie de niciun tabel de căutare suplimentar.
export function emailSintetic(cif, username) {
  return `${username}@${cif}.parohie.local`;
}
