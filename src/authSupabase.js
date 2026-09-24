// authSupabase.js
// Autentificare reală, pe server: CIF (parohie) → nume utilizator + parolă (persoană) → rol fix.
// Înlocuiește modelul local (un singur CIF+parolă, cu rol auto-ales) cu conturi individuale,
// per rol, verificate de server — exact modelul confirmat în discuția de proiectare.

import { supabase, emailSintetic } from "./supabaseClient";

// Pasul 1 — găsește parohia după CIF (informație publică, doar id + denumire, nimic sensibil).
// Necesar înainte de logare, ca să confirmăm că CIF-ul există și să pregătim emailul sintetic.
// Verificarea se face înainte de autentificare (rol anon). Tabelul "parohii" are RLS (fiecare
// utilizator vede doar propria parohie), deci o interogare directă întoarce mereu „nimic" pentru
// un vizitator nelogat. Folosim funcția SQL "exista_parohie_cif" (SECURITY DEFINER), care răspunde
// doar true/false, fără să expună alte date. Întoarce true dacă CIF-ul există, altfel false.
export async function gasesteParohieDupaCif(cif) {
  const { data, error } = await supabase.rpc("exista_parohie_cif", { p_cif: cif });
  if (error) throw error;
  return data === true;
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
  // Prin funcția SQL "profil_propriu" (SECURITY DEFINER, întoarce doar rândul celui logat): profilul
  // trebuie citit înainte de pasul 2FA și de înregistrarea sesiunii, deci nu poate depinde de
  // regulile de acces la datele parohiei (care vor cere o sesiune înregistrată).
  const { data: randuriProfil, error: errProfil } = await supabase.rpc("profil_propriu");
  const profil = Array.isArray(randuriProfil) ? randuriProfil[0] : randuriProfil;
  if (errProfil || !profil) {
    await supabase.auth.signOut();
    return { ok: false, error: "Profilul contului nu a putut fi găsit." };
  }

  return { ok: true, session: data.session, parohieId: profil.parohie_id, rol: profil.rol, username: profil.username };
}

// Delogare: întâi eliberăm locul sesiunii (limita de sesiuni simultane), apoi închidem sesiunea.
// Eșecul eliberării (ex. fără internet) nu blochează delogarea: locul expiră oricum pe server
// după 3 minute fără semnal de viață.
export async function delogare() {
  try {
    await supabase.rpc("elibereaza_sesiune");
  } catch (e) {
    // ignorat intenționat — vezi comentariul de mai sus
  }
  await supabase.auth.signOut();
}

// Limita de sesiuni simultane (verificată pe server, funcția SQL "inregistreaza_sesiune"):
// o singură sesiune pe cont și maximum 3 sesiuni pe parohie. Aceeași funcție servește și ca
// semnal de viață (apelată periodic cât aplicația e deschisă). Întoarce codul serverului:
// "ok" | "cont_ocupat" | "parohie_plina" | "necesita_2fa" | "neautentificat" | "fara_parohie".
// Aruncă excepție doar la eroare tehnică (ex. rețea), ca apelantul să poată reîncerca.
export async function inregistreazaSesiune() {
  const { data, error } = await supabase.rpc("inregistreaza_sesiune");
  if (error) throw error;
  return data;
}

// Mesajele afișate utilizatorului când serverul refuză o sesiune.
export function mesajRefuzSesiune(cod) {
  switch (cod) {
    case "cont_ocupat":
      return "Acest cont este deja conectat pe alt dispozitiv sau în altă fereastră. Delogați-vă acolo și încercați din nou. Dacă fereastra a fost închisă fără delogare, locul se eliberează automat în cel mult 3 minute.";
    case "parohie_plina":
      return "La această parohie sunt deja conectate 3 persoane (limita maximă de sesiuni simultane). Încercați din nou după ce una dintre ele se deloghează.";
    default:
      return "Sesiunea nu a putut fi validată de server. Autentificați-vă din nou.";
  }
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
