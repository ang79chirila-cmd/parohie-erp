// backupParohie.js
// Backup complet al datelor unei parohii, într-un singur fișier ZIP descărcat pe calculatorul
// utilizatorului. Datele se citesc direct din Supabase (nu din memoria aplicației), tabel cu
// tabel, integral (cu paginare și verificarea numărului de rânduri). Izolarea între parohii e
// garantată de server: regulile de acces (RLS) întorc doar rândurile parohiei utilizatorului logat.
//
// Conținutul arhivei:
//   manifest.json      — date de identificare + pentru fiecare tabel: rânduri, octeți, SHA-256
//   CITESTE-MA.txt     — explicații în limba română, pentru orice cititor (inclusiv organe de control)
//   tabele/<tabel>.json — rândurile complete ale fiecărui tabel, în format JSON
//
// Ce NU conține, intenționat: parolele și factorii 2FA (sunt gestionate de serviciul de
// autentificare, inaccesibile aplicației), amprentele codurilor de recuperare 2FA și evidența
// tehnică a sesiunilor deschise.

import { supabase } from "./supabaseClient";
import { construiesteZip, sha256Hex } from "./arhivaZip.mjs";

export const BACKUP_FORMAT_VERSIUNE = 1;

// Toate tabelele cu date ale parohiei, cu cheia primară (necesară pentru o paginare stabilă).
export const TABELE_BACKUP = [
  { nume: "parohii", pk: ["id"], descriere: "Datele de identificare ale parohiei" },
  { nume: "utilizatori", pk: ["id"], descriere: "Utilizatorii parohiei (fără parole)" },
  { nume: "exercitii_financiare", pk: ["id"], descriere: "Exerciții financiare" },
  { nume: "documente", pk: ["id"], descriere: "Documente (Registru Jurnal, facturi, bonuri etc.)" },
  { nume: "linii_document", pk: ["id"], descriere: "Liniile documentelor" },
  { nume: "comisioane_bancare_pending", pk: ["id"], descriere: "Comisioane bancare neconsolidate" },
  { nume: "contoare", pk: ["parohie_id", "an", "tip"], descriere: "Contoarele de numerotare" },
  { nume: "conturi_bvc", pk: ["id"], descriere: "Planul de conturi BVC (nomenclator comun)" },
  { nume: "conturi_bvc_parohie", pk: ["id"], descriere: "Conturile BVC proprii parohiei" },
  { nume: "prevederi_bugetare", pk: ["id"], descriere: "Prevederi bugetare" },
  { nume: "prevederi_bugetare_linii", pk: ["id"], descriere: "Liniile prevederilor bugetare" },
  { nume: "parteneri", pk: ["id"], descriere: "Parteneri (furnizori, clienți)" },
  { nume: "articole_pangar", pk: ["id"], descriere: "Nomenclatorul pangarului" },
  { nume: "miscari_stoc_pangar", pk: ["id"], descriere: "Mișcările de stoc ale pangarului" },
  { nume: "articole_consum_intern", pk: ["id"], descriere: "Articole de consum intern" },
  { nume: "miscari_consum_intern", pk: ["id"], descriere: "Mișcări de consum intern și filantropie" },
  { nume: "bunuri_patrimoniu", pk: ["id"], descriere: "Bunuri de patrimoniu (inventar)" },
  { nume: "inventarieri_patrimoniu", pk: ["id"], descriere: "Inventarieri de patrimoniu" },
  { nume: "inventarieri_bunuri", pk: ["id"], descriere: "Bunurile din inventarieri" },
  { nume: "locuri_inhumare", pk: ["id"], descriere: "Cimitir — locuri de înhumare" },
  { nume: "persoane_inhumate", pk: ["id"], descriere: "Cimitir — persoane înhumate" },
  { nume: "concesiuni", pk: ["id"], descriere: "Cimitir — concesiuni" },
  { nume: "concesiuni_istoric", pk: ["id"], descriere: "Cimitir — istoricul concesiunilor" },
  { nume: "tarife_cimitir", pk: ["parohie_id", "tip_durata"], descriere: "Cimitir — tarife" },
  { nume: "corespondenta", pk: ["id"], descriere: "Registrul de corespondență" },
  { nume: "arhiva", pk: ["id"], descriere: "Arhiva" },
  { nume: "mandate_organisme_parohiale", pk: ["id"], descriere: "Organisme parohiale — mandate" },
  { nume: "membri_organisme_parohiale", pk: ["id"], descriere: "Organisme parohiale — membri" },
  { nume: "procese_verbale_organisme_parohiale", pk: ["id"], descriere: "Organisme parohiale — procese-verbale" },
  { nume: "jurnal_audit", pk: ["id"], descriere: "Jurnalul de audit (cine, ce, când)" },
  { nume: "backupuri", pk: ["id"], descriere: "Evidența backup-urilor anterioare" },
];

const PAGINA = 1000;

// Citește integral un tabel, pagină cu pagină, ordonat după cheia primară. Verifică la final că
// numărul de rânduri citite coincide cu numărul raportat de server — altfel backup-ul e respins,
// ca să nu existe niciodată o copie incompletă prezentată drept completă.
async function citesteTabelComplet({ nume, pk }) {
  const randuri = [];
  let total = null;
  for (;;) {
    let interogare = supabase.from(nume).select("*", { count: "exact" });
    for (const coloana of pk) interogare = interogare.order(coloana, { ascending: true });
    const { data, error, count } = await interogare.range(randuri.length, randuri.length + PAGINA - 1);
    if (error) throw new Error(`Tabelul „${nume}” nu a putut fi citit: ${error.message}`);
    total = typeof count === "number" ? count : total;
    if (!data || data.length === 0) break;
    randuri.push(...data);
    if (total !== null && randuri.length >= total) break;
  }
  if (total !== null && randuri.length !== total) {
    throw new Error(
      `Tabelul „${nume}”: s-au citit ${randuri.length} rânduri din ${total}. Datele s-au modificat în timpul citirii — reîncercați.`
    );
  }
  return randuri;
}

function doiDigiti(n) {
  return String(n).padStart(2, "0");
}

function marimeLizibila(octeti) {
  if (octeti < 1024) return `${octeti} octeți`;
  if (octeti < 1024 * 1024) return `${(octeti / 1024).toFixed(1).replace(".", ",")} KB`;
  return `${(octeti / 1024 / 1024).toFixed(2).replace(".", ",")} MB`;
}

// Generează arhiva. `tip`: "manual" | "automat". `utilizator`, `rol`: cine o generează.
// `onProgres(mesaj)` raportează stadiul, pentru afișare. Denumirea și CIF-ul parohiei se iau
// chiar din datele citite (tabelul „parohii”), nu din memoria aplicației.
export async function genereazaBackup({ tip, utilizator, rol, onProgres }) {
  const progres = typeof onProgres === "function" ? onProgres : () => {};
  const acum = new Date();
  const enc = new TextEncoder();

  progres(`Se citesc ${TABELE_BACKUP.length} tabele din baza de date...`);
  const rezultate = await Promise.all(TABELE_BACKUP.map((t) => citesteTabelComplet(t)));

  progres("Se pregătește arhiva...");
  const fisiereTabele = [];
  const inventar = [];
  let totalRanduri = 0;
  for (let i = 0; i < TABELE_BACKUP.length; i++) {
    const t = TABELE_BACKUP[i];
    const randuri = rezultate[i];
    const octeti = enc.encode(JSON.stringify(randuri, null, 1));
    const fisier = `tabele/${t.nume}.json`;
    fisiereTabele.push({ nume: fisier, date: octeti });
    inventar.push({
      tabel: t.nume,
      descriere: t.descriere,
      fisier,
      randuri: randuri.length,
      octeti: octeti.length,
      sha256: await sha256Hex(octeti),
    });
    totalRanduri += randuri.length;
  }

  const manifest = {
    tipDocument: "ParohieERP-Backup-Complet",
    versiuneFormat: BACKUP_FORMAT_VERSIUNE,
    tipBackup: tip,
    generatLa: acum.toISOString(),
    fusOrar: "UTC în câmpul generatLa; ora României în CITESTE-MA.txt",
    parohie: {
      cif: rezultate[0]?.[0]?.cif || "",
      denumire: rezultate[0]?.[0]?.denumire || "",
    },
    generatDe: { utilizator: utilizator || "", rol: rol || "" },
    totalTabele: inventar.length,
    totalRanduri,
    tabele: inventar,
    excluse: [
      "parole și factori 2FA (gestionate de serviciul de autentificare, inaccesibile aplicației)",
      "amprentele codurilor de recuperare 2FA",
      "evidența tehnică a sesiunilor deschise",
    ],
  };

  const oraRo = new Intl.DateTimeFormat("ro-RO", {
    timeZone: "Europe/Bucharest",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(acum);

  const liniiTabele = inventar
    .map((t) => `  - ${t.tabel.padEnd(38)} ${String(t.randuri).padStart(7)} rânduri   ${t.descriere}`)
    .join("\n");
  const citesteMa = [
    "PAROHIA ERP — BACKUP COMPLET AL DATELOR PAROHIEI",
    "================================================",
    "",
    `Parohia:        ${manifest.parohie.denumire} (CIF ${manifest.parohie.cif})`,
    `Generat la:     ${oraRo} (ora României)`,
    `Generat de:     ${manifest.generatDe.utilizator} (${manifest.generatDe.rol})`,
    `Tip backup:     ${tip === "automat" ? "automat (lunar)" : "manual"}`,
    `Total:          ${inventar.length} tabele, ${totalRanduri} rânduri`,
    "",
    "Conținut:",
    "  - manifest.json: datele de mai sus, în format structurat, plus amprenta SHA-256 a fiecărui",
    "    fișier de tabel (verificarea integrității: amprenta recalculată trebuie să fie identică).",
    "  - tabele/*.json: rândurile complete ale fiecărui tabel, exact cum sunt în baza de date.",
    "",
    "Tabele incluse:",
    liniiTabele,
    "",
    "Nu sunt incluse, intenționat: " + manifest.excluse.join("; ") + ".",
    "",
    "Păstrați acest fișier într-un loc sigur, de preferat în cel puțin două locuri diferite",
    "(de ex. calculator + stick USB sau spațiu de stocare personal). Fișierul conține date",
    "personale (parteneri, persoane înhumate, membri ai organismelor parohiale) — nu îl",
    "transmiteți persoanelor neautorizate.",
    "",
  ].join("\n");

  const fisiere = [
    { nume: "manifest.json", date: enc.encode(JSON.stringify(manifest, null, 2)) },
    // Marcajul BOM ajută editoarele de text vechi (ex. Notepad pe Windows mai vechi) să afișeze corect diacriticele.
    { nume: "CITESTE-MA.txt", date: enc.encode("\uFEFF" + citesteMa) },
    ...fisiereTabele,
  ];

  const arhiva = await construiesteZip(fisiere, acum);
  const sha256 = await sha256Hex(arhiva);
  const numeFisier =
    `ParohieERP-backup-${manifest.parohie.cif || "parohie"}-` +
    `${acum.getFullYear()}-${doiDigiti(acum.getMonth() + 1)}-${doiDigiti(acum.getDate())}_` +
    `${doiDigiti(acum.getHours())}-${doiDigiti(acum.getMinutes())}.zip`;

  return {
    blob: new Blob([arhiva], { type: "application/zip" }),
    numeFisier,
    sha256,
    marime: arhiva.length,
    marimeLizibila: marimeLizibila(arhiva.length),
    nrTabele: inventar.length,
    nrRanduri: totalRanduri,
  };
}

// Declanșează descărcarea fișierului în browser (dosarul „Descărcări”, sau locul ales de utilizator).
export function descarcaFisier(blob, numeFisier) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = numeFisier;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// Înregistrează backup-ul pe server (evidență + baza pentru backup-ul lunar automat).
export async function inregistreazaBackup({ tip, nrTabele, nrRanduri, marime, sha256 }) {
  const { data, error } = await supabase.rpc("inregistreaza_backup", {
    p_tip: tip,
    p_nr_tabele: nrTabele,
    p_nr_randuri: nrRanduri,
    p_marime_octeti: marime,
    p_sha256: sha256,
  });
  if (error) throw error;
  return data;
}

// true dacă în luna curentă (ora României) nu există încă niciun backup al parohiei și
// utilizatorul curent este Administratorul parohiei (singurul care declanșează backup-ul lunar).
export async function backupLunarNecesar() {
  const { data, error } = await supabase.rpc("backup_lunar_necesar");
  if (error) throw error;
  return data === true;
}

// Ultimele backup-uri ale parohiei (pentru afișarea istoricului).
export async function ultimeleBackupuri(limita = 12) {
  const { data, error } = await supabase
    .from("backupuri")
    .select("id, luna, tip, creat_la, utilizator, nr_tabele, nr_randuri, marime_octeti, sha256")
    .order("creat_la", { ascending: false })
    .limit(limita);
  if (error) throw error;
  return data || [];
}

export { marimeLizibila };
