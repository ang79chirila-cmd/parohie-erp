// authSupabase.js
// Autentificare reală, pe server: CIF (parohie) → nume utilizator + parolă (persoană) → rol fix.
// Înlocuiește modelul local (un singur CIF+parolă, cu rol auto-ales) cu conturi individuale,
// per rol, verificate de server — exact modelul confirmat în discuția de proiectare.

import { supabase, emailSintetic } from "./supabaseClient";

// Pasul 1 — găsește parohia după CIF (informație publică, doar id + denumire, nimic sensibil).
// Necesar înainte de logare, ca să confirmăm că CIF-ul există și să pregătim emailul sintetic.
export async function gasesteParohieDupaCif(cif) {
  const { data, error } = await supabase
    .from("parohii")
    .select("id, denumire")
    .eq("cif", cif)
    .maybeSingle();
  if (error) throw error;
  return data; // null dacă nu există nicio parohie cu acest CIF
}

// Pasul 2 — logare efectivă: CIF + username + parolă -> sesiune Supabase Auth reală.
// Emailul sintetic e determinist (nu necesită niciun tabel de căutare) — exact ce a generat
// și Edge Function-ul "creeaza-utilizator" la creare.
export async function logare(cif, username, parola) {
  const email = emailSintetic(cif, username);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password: parola });
  if (error) {
    return { ok: false, error: "Cod fiscal (CIF), nume de utilizator sau parolă incorectă." };
  }

  // Aducem profilul (parohie_id, rol) — necesar pentru a ști ce vede utilizatorul (fără alegere manuală a rolului).
  const { data: profil, error: errProfil } = await supabase
    .from("utilizatori")
    .select("parohie_id, rol, username")
    .eq("id", data.user.id)
    .maybeSingle();
  if (errProfil || !profil) {
    await supabase.auth.signOut();
    return { ok: false, error: "Profilul contului nu a putut fi găsit." };
  }

  return { ok: true, session: data.session, parohieId: profil.parohie_id, rol: profil.rol, username: profil.username };
}

export async function delogare() {
  await supabase.auth.signOut();
}

// Creare cont — apelează Edge Function-ul deja publicat și testat ("creeaza-utilizator").
// Pentru prima parohie (CIF nou): nu trimite tokenAdmin, contul devine automat "preot".
// Pentru adăugarea unui rol nou la o parohie existentă: tokenAdmin = sesiunea curentă a
// Administratorului (obligatoriu, verificat de funcție pe server).
export async function creeazaCont({ cif, denumireParohie, username, parola, rol, emailRecuperare, tokenAdmin }) {
  const { data, error } = await supabase.functions.invoke("creeaza-utilizator", {
    body: { cif, denumireParohie, username, parola, rol, emailRecuperare, tokenAdmin },
  });
  if (error) {
    // Edge Function-ul întoarce mesajul de eroare exact (CIF/parolă lipsă, rol deja existent, etc.)
    const mesaj = data?.error || error.message || "Eroare necunoscută la crearea contului.";
    return { ok: false, error: mesaj };
  }
  return { ok: true, parohieId: data.parohieId, rol: data.rol };
}

// Token-ul sesiunii curente — necesar când Administratorul creează un cont nou pentru altcineva
// din propria parohie (Edge Function-ul verifică acest token, nu doar promisiunea aplicației).
export async function tokenSesiuneCurenta() {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token || null;
}
