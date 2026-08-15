// mfaHelpers.js
// Modul nou, de sine stătător. Se importă în ParohieERP.jsx alături de
// supabaseClient — nu necesită nicio modificare a fișierelor existente
// pentru a exista, doar pentru a fi CONECTAT în UI (vezi
// 06_INTEGRARE_ParohieERP.md pentru punctele exacte de conectare).
//
// Folosește Supabase Auth MFA nativ (gratuit, TOTP standard — compatibil
// Google Authenticator / Microsoft Authenticator / Authy / orice app TOTP).

import { supabase } from "./supabaseClient";

// ---------- ÎNROLARE TOTP ----------

// Pasul 1: pornește înrolarea, primești un QR code (ca imagine SVG) de
// afișat utilizatorului pentru scanare cu aplicația de autentificare.
export async function inceapeInrolareTOTP() {
  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: "Autentificator principal",
  });
  if (error) throw error;
  return {
    factorId: data.id,
    qrCodeSvg: data.totp.qr_code, // string SVG, de afișat cu dangerouslySetInnerHTML sau <img src={`data:image/svg+xml;utf8,${...}`}/>
    secret: data.totp.secret, // cod text, pentru introducere manuală dacă QR nu poate fi scanat
  };
}

// Pasul 2: utilizatorul introduce codul de 6 cifre generat de aplicație
// pentru a confirma că înrolarea a funcționat.
export async function confirmaInrolareTOTP(factorId, cod6cifre) {
  const { data: challenge, error: errChallenge } =
    await supabase.auth.mfa.challenge({ factorId });
  if (errChallenge) throw errChallenge;

  const { data, error } = await supabase.auth.mfa.verify({
    factorId,
    challengeId: challenge.id,
    code: cod6cifre,
  });
  if (error) throw error;
  return data; // sesiune actualizată, factor activ (aal2)
}

// ---------- LOGIN CU TOTP (după parolă) ----------

// După login cu parolă, dacă utilizatorul are un factor MFA activ,
// Supabase cere pasul al doilea. Se listează factorii disponibili:
export async function listeazaFactoriMFA() {
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) throw error;
  return data.totp; // array de factori TOTP activi pentru userul curent
}

export async function verificaLoginTOTP(factorId, cod6cifre) {
  const { data: challenge, error: errChallenge } =
    await supabase.auth.mfa.challenge({ factorId });
  if (errChallenge) throw errChallenge;

  const { data, error } = await supabase.auth.mfa.verify({
    factorId,
    challengeId: challenge.id,
    code: cod6cifre,
  });
  if (error) throw error;
  return data;
}

// Dezactivează factorul TOTP propriu (din ecranul de securitate al
// utilizatorului, decizie proprie — diferit de deblocarea de Administrator
// de mai jos, care e pentru factori PIERDUȚI de alt utilizator).
export async function dezactiveazaTOTP(factorId) {
  const { error } = await supabase.auth.mfa.unenroll({ factorId });
  if (error) throw error;
  return true;
}

// ---------- COD DE RECUPERARE (pierdere telefon) ----------

// Generarea codului se face printr-un Edge Function (vezi
// 04_edge_function_genereaza-cod-recuperare/index.ts), pentru că trebuie
// scris hash-ul în tabel cu service_role — clientul nu are voie să scrie
// direct în coduri_recuperare_mfa.
export async function genereazaCodRecuperare() {
  const { data, error } = await supabase.functions.invoke(
    "genereaza-cod-recuperare",
    { method: "POST" }
  );
  if (error) throw error;
  return data.cod; // codul în CLAR, afișat O SINGURĂ DATĂ pentru tipărire —
  // aplicația nu îl mai poate afișa niciodată din nou după acest apel
}

// Folosirea codului de recuperare (telefon pierdut, nu se poate genera
// cod TOTP): dezactivează factorul TOTP pierdut prin Edge Function,
// utilizatorul se re-înrolează imediat după cu un telefon nou.
export async function foloseesteCodRecuperare(cod6cifreSauCodRecuperare) {
  const { data, error } = await supabase.functions.invoke(
    "foloseste-cod-recuperare",
    { body: { cod: cod6cifreSauCodRecuperare } }
  );
  if (error) throw error;
  return data; // { succes: true, factorDezactivat: true }
}

// ---------- DEBLOCARE DE CĂTRE ADMINISTRATOR (alt utilizator, telefon pierdut) ----------

export async function reseteazaMfaUtilizator(utilizatorTintaId) {
  const { data, error } = await supabase.functions.invoke(
    "reseteaza-mfa-utilizator",
    { body: { utilizatorTintaId } }
  );
  if (error) throw error;
  return data; // { succes: true, factoriStersi: n, mesaj }
}
