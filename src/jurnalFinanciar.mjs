// Funcții pure, fără nicio dependință de Supabase/React — extrase din ParohieERP.jsx exact ca
// pangarFinanciar.mjs, ca să poată fi testate automat (node --test). Grupează funcțiile de sold
// (Registru Jurnal/Tablou de bord) și de formatare a sumelor pentru export XLSX, plus un mic
// utilitar pentru grilele de valori din graficele de Analiză Financiară.

// Extrage anul calendaristic dintr-un șir de dată "AAAA-LL-ZZ".
export function yearOf(dateStr) {
  return Number(dateStr.slice(0, 4));
}

// Soldurile Casă/Bancă/Depozit la o dată exactă — folosite la Reconcilierea bancară, care
// compară soldul aplicației cu soldul unui extras de bancă, la o dată calendaristică precisă.
//
// CRITIC: restrânsă strict la ANUL datei cerute (nu cumulează și operațiunile din anii anteriori)
// — pentru că fiecare an își începe propriul registru cu o linie de „Excedent reportat"/„Sold la
// 31.12.{an anterior}" (vezi seteazaExcedentReportat), care deja reprezintă corect tot ce s-a
// acumulat până atunci. Dacă s-ar mai aduna și tranzacțiile brute din anii anteriori peste acea
// linie de reportare, aceiași bani ar fi numărați de două ori — o dată prin tranzacțiile reale
// care i-au construit, a doua oară prin linia care doar îi reportează. Caz real, găsit în
// producție: 5.400.000 RON depozit, construiți organic în 2025, apoi reportați printr-o linie
// nouă la 01.01.2026 — cumularea peste granița de an arăta 10.800.000 RON, dublu față de real.
export function soldCasaBancaLaData(operatiuni, dataLimitaInclusiv) {
  const anLimita = yearOf(dataLimitaInclusiv);
  let soldCasa = 0;
  let soldBanca = 0;
  let soldDepozit = 0;
  for (const op of operatiuni) {
    if (op.an !== anLimita || op.data > dataLimitaInclusiv) continue;
    const semn = op.tip === "incasare" ? 1 : -1;
    if (op.modPlata === "numerar") soldCasa += semn * op.suma;
    else if (op.modPlata === "depozit") soldDepozit += semn * op.suma;
    else soldBanca += semn * op.suma;
  }
  return { soldCasa, soldBanca, soldDepozit };
}

// Soldul Casă/Bancă/Depozit al anului `anLimita` — STRICT pe acel an (nu cumulativ prin anii
// anteriori). Criteriul de apartenență la an e `op.an` (anul din numerotarea documentului, ex.
// "27/2025"), NU `op.data` (data calendaristică efectivă a operațiunii) — deliberat același
// criteriu ca la Registrul Jurnal, care filtrează tot după `op.an === anSelectat`.
//
// CRITIC — de ce NU e cumulativă prin toți anii (cum a fost înainte, greșit): fiecare an își
// începe registrul cu o linie de „Excedent reportat"/„Sold la 31.12.{an anterior}", care deja
// reprezintă corect tot ce s-a acumulat în anii anteriori. O sumă cumulativă suplimentară, peste
// acea linie, ar număra aceiași bani de două ori — vezi explicația completă la
// soldCasaBancaLaData, mai sus, unde a fost găsit exact acest bug în producție (depozit dublat,
// 5.400.000 → 10.800.000, la trecerea dintre 2025 și 2026). Mai grav, funcția asta e folosită și
// la ÎNCHIDEREA unui exercițiu, pentru a calcula excedentul reportat în anul următor — o versiune
// cumulativă ar fi COMPUS eroarea an de an (dublu în 2026, apoi triplu în 2027, etc.).
export function soldCasaBancaLaAn(operatiuni, anLimita) {
  let soldCasa = 0;
  let soldBanca = 0;
  let soldDepozit = 0;
  for (const op of operatiuni) {
    if (op.an !== anLimita) continue;
    const semn = op.tip === "incasare" ? 1 : -1;
    if (op.modPlata === "numerar") soldCasa += semn * op.suma;
    else if (op.modPlata === "depozit") soldDepozit += semn * op.suma;
    else soldBanca += semn * op.suma;
  }
  return { soldCasa, soldBanca, soldDepozit };
}

// O sumă e "formatată" (text, stil românesc) dacă respectă exact acest tipar — acceptă și forma
// cu paranteze, "(1.234,00)", folosită pentru viramentele interne (581/5081).
export function esteSumaFormatata(v) {
  return typeof v === "string" && /^\(?-?\d{1,3}(\.\d{3})*,\d{2}\)?$/.test(v);
}

// Convertește o sumă formatată înapoi în număr real, pentru export XLSX (unde Excel trebuie să
// primească un număr editabil, nu text).
//
// CRITIC pentru viramentele interne (581/5081): valoarea vine formatată cu paranteze —
// "(1.234,00)" — convenția contabilă pentru sumă negativă. `Number("(1234.00)")` (fără eliminarea
// parantezelor mai întâi) dă NaN, nu -1234 — bug real, găsit în producție: toate sumele de
// viramente ieșeau NaN în XLSX. Eliminăm parantezele explicit și aplicăm semnul negativ manual.
export function parseSumaFormatata(v) {
  if (!esteSumaFormatata(v)) return v;
  const eNegativa = v.startsWith("(");
  const numar = Number(v.replace(/[()]/g, "").replace(/\./g, "").replace(",", "."));
  return eNegativa ? -numar : numar;
}

// Pas "rotund" (1/2/5 × 10^n) pentru liniile de grilă ale unui grafic — evită valori ciudate pe
// axa Y (ex. 3.847,33), alege întotdeauna un pas natural, ușor de citit.
export function pasGrilaNatural(maxim, nrLinii = 4) {
  const brut = maxim / nrLinii;
  const exponent = Math.floor(Math.log10(brut || 1));
  const factor = Math.pow(10, exponent);
  const normalizat = brut / factor;
  const pasNormalizat = normalizat <= 1 ? 1 : normalizat <= 2 ? 2 : normalizat <= 5 ? 5 : 10;
  return pasNormalizat * factor;
}
