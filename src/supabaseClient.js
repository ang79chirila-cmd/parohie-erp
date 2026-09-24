// supabaseClient.js
// Conexiunea de bază către Supabase — un singur loc, folosit peste tot în aplicație.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://jcdsamfsqfcjryrxftsb.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpjZHNhbWZzcWZjanJ5cnhmdHNiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM5NjY3MDAsImV4cCI6MjA5OTU0MjcwMH0.mJOYPwiAb1lq2uI-t5t3m-B5aS3KGV9vxggbal6l64E";

// Sesiunea NU supraviețuiește închiderii ferestrei/tab-ului: o păstrăm în sessionStorage
// (șters de browser/Electron la închidere), nu în localStorage (permanent). Astfel, la
// fiecare deschidere a aplicației se cer din nou parola și, dacă e activ, codul 2FA.
// Reîncărcarea paginii (F5) în aceeași fereastră păstrează sesiunea.
function stocareSesiune() {
  try {
    if (typeof window !== "undefined" && window.sessionStorage) return window.sessionStorage;
  } catch (e) {
    // Stocare indisponibilă — lăsăm clientul să folosească varianta implicită în memorie.
  }
  return undefined;
}

// Curățare unică a sesiunilor salvate de versiunile anterioare în localStorage
// (cheia "sb-<proiect>-auth-token"), ca un token vechi să nu rămână pe disc.
try {
  if (typeof window !== "undefined" && window.localStorage) {
    Object.keys(window.localStorage)
      .filter((cheie) => cheie.startsWith("sb-") && cheie.endsWith("-auth-token"))
      .forEach((cheie) => window.localStorage.removeItem(cheie));
  }
} catch (e) {
  // Fără acces la localStorage — nimic de curățat.
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: stocareSesiune(),
    persistSession: true,
    autoRefreshToken: true,
  },
});

// Construiește exact același email sintetic pe care-l generează și Edge Function-ul
// "creeaza-utilizator" — determinist, ca aplicația să-l poată reconstitui la fiecare logare,
// fără să fie nevoie de niciun tabel de căutare suplimentar.
export function emailSintetic(cif, username) {
  return `${username}@${cif}.parohie.local`;
}
