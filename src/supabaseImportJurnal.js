// Import Jurnal din Excel — strat de acces la date, separat de supabaseData.js pentru claritate.
//
// Diferă fundamental de salveazaDocument() (folosit la emiterea normală, din UI): acolo numărul
// e alocat automat, aici numărul e IMPUS de rândul din Excel (documentul istoric a fost deja
// numerotat de contabil, în hârtie/Excel — nu se renumerotează la import). De aceea nu se
// folosește deloc RPC-ul creeaza_document_tranzactional; inserarea e directă, în documente +
// linii_document, iar contorul se resincronizează manual la final, pe MAX(nr) real.

import { supabase } from "./supabaseClient";

const TIP_DOCUMENT_SUPABASE = {
  incasare: "chitanta",
  plata: "ordin_plata",
};

// Aduce, pentru o listă de (tip, nr) dintr-un an dat, documentele deja existente în Supabase —
// folosit pentru detectarea conflictelor înainte de import. Întoarce o hartă cheie -> document
// complet (cu liniile lui), ca ecranul de comparație să poată arăta varianta existentă.
export async function getDocumenteExistentePentruAn(parohieId, an, tipLocal) {
  const tipDoc = TIP_DOCUMENT_SUPABASE[tipLocal];
  const { data: documente, error } = await supabase
    .from("documente")
    .select("*")
    .eq("parohie_id", parohieId)
    .eq("an", an)
    .eq("tip", tipDoc);
  if (error) throw error;
  if (!documente || documente.length === 0) return {};

  const docIds = documente.map((d) => d.id);
  const { data: linii, error: errLinii } = await supabase
    .from("linii_document")
    .select("*")
    .in("document_id", docIds);
  if (errLinii) throw errLinii;

  // Verificăm, per document, dacă e "atins" de alt modul (Pangar sau Patrimoniu) — un document
  // legat de o mișcare de stoc sau de un bun de patrimoniu nu poate fi înlocuit prin import,
  // doar păstrat sau sărit, ca să nu desincronizăm acel modul.
  const { data: miscariPangar, error: errPangar } = await supabase
    .from("miscari_stoc_pangar")
    .select("document_id")
    .in("document_id", docIds);
  if (errPangar) throw errPangar;
  const { data: bunuriPatrimoniu, error: errPatrimoniu } = await supabase
    .from("bunuri_patrimoniu")
    .select("document_id")
    .in("document_id", docIds);
  if (errPatrimoniu) throw errPatrimoniu;
  const idsAtinseAlteModule = new Set([
    ...(miscariPangar || []).map((m) => m.document_id),
    ...(bunuriPatrimoniu || []).map((b) => b.document_id),
  ]);

  const rezultat = {};
  for (const doc of documente) {
    const liniiDoc = (linii || []).filter((l) => l.document_id === doc.id);
    const esteExcedentReportat = liniiDoc.some((l) => l.este_excedent_reportat);
    rezultat[`${tipLocal}-${doc.nr}`] = {
      documentId: doc.id,
      nr: doc.nr,
      an: doc.an,
      data: doc.data,
      tert: doc.tert,
      serie: doc.serie,
      numarIdentificare: doc.numar_identificare,
      linii: liniiDoc.map((l) => ({
        id: l.id,
        contId: l.cont_id,
        suma: Number(l.suma),
        explicatie: l.explicatie || "",
        modPlata: l.mod_plata,
        ajustare106: !!l.ajustare106,
        esteExcedentReportat: !!l.este_excedent_reportat,
      })),
      legatDeAltModul: idsAtinseAlteModule.has(doc.id),
      esteExcedentReportat,
    };
  }
  return rezultat;
}

// Inserare directă, cu numărul IMPUS din Excel (nu alocat automat) — folosită pentru documente
// noi (fără conflict) sau pentru înlocuirea explicită a unui document existent (linii vechi
// șterse, linii noi inserate, antetul actualizat). Nu atinge contorul — asta se face separat,
// o singură dată la finalul întregului import, prin sincronizeazaContor().
export async function insereazaDocumentCuNumarFix(parohieId, { tip, nr, an, data, tert, serie, numarIdentificare, linii }) {
  const tipDoc = TIP_DOCUMENT_SUPABASE[tip];
  const { data: doc, error: errDoc } = await supabase
    .from("documente")
    .insert({
      parohie_id: parohieId, tip: tipDoc, nr, an, data, tert: tert || null,
      serie: serie || null, numar_identificare: numarIdentificare || null,
    })
    .select()
    .single();
  if (errDoc) throw errDoc;

  if (linii && linii.length > 0) {
    const { error: errLinii } = await supabase.from("linii_document").insert(
      linii.map((l) => ({
        document_id: doc.id,
        cont_id: String(l.contId),
        suma: l.suma,
        explicatie: l.explicatie || null,
        mod_plata: l.modPlata || null,
        ajustare106: !!l.ajustare106,
      }))
    );
    if (errLinii) throw errLinii;
  }

  return { documentId: doc.id };
}

// Înlocuiește complet un document existent: șterge liniile vechi, actualizează antetul,
// inserează liniile noi din Excel. Numărul (nr) rămâne neschimbat — doar conținutul se înlocuiește.
export async function inlocuiesteDocument(documentId, { data, tert, serie, numarIdentificare, linii }) {
  const { error: errUpd } = await supabase
    .from("documente")
    .update({ data, tert: tert || null, serie: serie || null, numar_identificare: numarIdentificare || null })
    .eq("id", documentId);
  if (errUpd) throw errUpd;

  const { error: errDel } = await supabase.from("linii_document").delete().eq("document_id", documentId);
  if (errDel) throw errDel;

  if (linii && linii.length > 0) {
    const { error: errIns } = await supabase.from("linii_document").insert(
      linii.map((l) => ({
        document_id: documentId,
        cont_id: String(l.contId),
        suma: l.suma,
        explicatie: l.explicatie || null,
        mod_plata: l.modPlata || null,
        ajustare106: !!l.ajustare106,
      }))
    );
    if (errIns) throw errIns;
  }
}

// Resincronizează contorul (contoare.ultimul_numar) pe MAX(nr) real din documente, pentru un
// tip/an dat — apelată o singură dată, la finalul importului, ca următoarea chitanță/OP emisă
// manual din aplicație să continue corect de la ultimul număr importat, fără coliziuni.
export async function sincronizeazaContor(parohieId, an, tipLocal) {
  const tipDoc = TIP_DOCUMENT_SUPABASE[tipLocal];
  const { data: maxRow, error: errMax } = await supabase
    .from("documente")
    .select("nr")
    .eq("parohie_id", parohieId)
    .eq("an", an)
    .eq("tip", tipDoc)
    .order("nr", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (errMax) throw errMax;
  const maxNr = maxRow?.nr || 0;

  const { error: errUpsert } = await supabase
    .from("contoare")
    .upsert(
      { parohie_id: parohieId, an, tip: tipLocal, ultimul_numar: maxNr },
      { onConflict: "parohie_id,an,tip" }
    );
  if (errUpsert) throw errUpsert;

  return maxNr;
}
