// Acces la datele operaționale din Supabase.
//
// Module migrate până acum:
//  1. Exerciții financiare + Prevederi bugetare
//  2. Registru Jurnal (documente + linii_document) — Chitanță și Ordin de plată
//
// Rămân pe window.storage, deocamdată (migrare ulterioară, pas cu pas):
//  NRCD, Bon de consum, Pangar, Consum intern, Patrimoniu, Cimitir, Corespondență.
//
// Notă despre tranzacții: clientul supabase-js nu oferă tranzacții multi-statement
// din partea clientului. Operațiile compuse (antet + linii) se fac secvențial, nu atomic.
// Riscul practic e mic (un singur utilizator emite un document la un moment dat), dar e o
// limitare reală, de reținut dacă apare vreodată nevoia de concurență ridicată.

import { supabase } from "./supabaseClient";
import { ultimaZiCalendaristica, formateazaCantitate } from "./pangarFinanciar.mjs";

// PostgREST/Supabase are o limită practică pe lungimea URL-ului unei cereri GET. Un singur
// `.in(coloana, [...])` cu sute de UUID-uri (36+ caractere fiecare) poate depăși acea limită și
// eșua cu 400 "Bad Request" — invizibil cu volum mic de date, dar sigur să apară pe măsură ce
// parohia acumulează sute de documente. Împărțim orice astfel de interogare în loturi mai mici,
// cerute succesiv, și unim rezultatele — echivalent funcțional cu un singur `.in()` mare, dar
// niciodată peste limita de lungime a URL-ului.
async function inLoturi(queryFactory, ids, marimeLot = 150) {
  if (!ids || ids.length === 0) return [];
  const rezultate = [];
  for (let i = 0; i < ids.length; i += marimeLot) {
    const lot = ids.slice(i, i + marimeLot);
    const { data, error } = await queryFactory(lot);
    if (error) throw error;
    rezultate.push(...(data || []));
  }
  return rezultate;
}

// Formatează o cantitate pentru textul de explicație al unei operațiuni — mereu convertită
// explicit prin Number() (apără împotriva unei valori care ar ajunge aici ca text brut, de
// exemplu dintr-o coloană numerică din Postgres serializată cu scală fixă, gen "35.000"), și
// afișată FĂRĂ NICIO ZECIMALĂ — unitățile de măsură (buc., kg) nu se afișează niciodată cu
// zecimale, ca să nu poată fi confundate cu o sumă de bani sau cu o valoare de mii. Zecimalele
// rămân doar pentru sumele în lei, formatate separat prin fmt() în ParohieERP.jsx.
// (aceeași funcție, testată automat — vezi tests/pangarFinanciar.test.mjs)
const fmtCantitate = formateazaCantitate;

/* ------------------------- Exerciții financiare ------------------------- */

// Aduce exercițiul financiar al unui an anume, pentru parohia curentă.
// Întoarce null dacă exercițiul nu a fost încă "atins" (nicio închidere, nicio redeschidere).
export async function getExercitiuFinanciar(parohieId, an) {
  const { data, error } = await supabase
    .from("exercitii_financiare")
    .select("*")
    .eq("parohie_id", parohieId)
    .eq("an", an)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Aduce toate exercițiile financiare ale parohiei (util pentru rapoarte / listă ani disponibili).
export async function getToateExercitiile(parohieId) {
  const { data, error } = await supabase
    .from("exercitii_financiare")
    .select("*")
    .eq("parohie_id", parohieId)
    .order("an", { ascending: true });
  if (error) throw error;
  return data || [];
}

// Închide (moale) exercițiul unui an — reversibil, nu presupune validare GDPR/anonimizare.
export async function inchideExercitiu(parohieId, an, tipInchidere = "manuala") {
  const { data, error } = await supabase
    .from("exercitii_financiare")
    .upsert(
      {
        parohie_id: parohieId,
        an,
        inchis: true,
        data_inchidere: todayISO(),
        tip_inchidere: tipInchidere,
      },
      { onConflict: "parohie_id,an" }
    )
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Redeschide (moale) un exercițiu închis anterior.
export async function redeschideExercitiu(parohieId, an) {
  const { data, error } = await supabase
    .from("exercitii_financiare")
    .update({ inchis: false, data_redeschidere: todayISO() })
    .eq("parohie_id", parohieId)
    .eq("an", an)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Închidere DEFINITIVĂ (ireversibilă) — folosită la 31.12.N+1, gatingul de editare directă.
export async function inchideDefinitivExercitiul(parohieId, an) {
  const { data, error } = await supabase
    .from("exercitii_financiare")
    .update({ inchis_definitiv: true, data_inchidere_definitiva: todayISO() })
    .eq("parohie_id", parohieId)
    .eq("an", an)
    .select()
    .single();
  if (error) throw error;
  return data;
}

/* ---------------------------- Prevederi bugetare ---------------------------- */

// Aduce prevederile bugetare validate (sau nu) ale unui an, cu toate liniile lor.
// Întoarce null dacă anul respectiv nu are încă niciun rând (nu s-a atins deloc).
export async function getPrevederiBugetare(parohieId, an) {
  const { data: prevedere, error } = await supabase
    .from("prevederi_bugetare")
    .select("id, an, validat, data_validare")
    .eq("parohie_id", parohieId)
    .eq("an", an)
    .maybeSingle();
  if (error) throw error;
  if (!prevedere) return null;

  const { data: linii, error: errLinii } = await supabase
    .from("prevederi_bugetare_linii")
    .select("id, cont_id, suma")
    .eq("prevedere_id", prevedere.id);
  if (errLinii) throw errLinii;

  return { ...prevedere, linii: linii || [] };
}

// Aduce prevederile bugetare (validate) ale TUTUROR anilor parohiei — folosit de rapoarte
// precum Execuția bugetară, care compară bugetat vs. realizat pe mai mulți ani deodată.
export async function getToatePrevederile(parohieId) {
  const { data: prevederi, error } = await supabase
    .from("prevederi_bugetare")
    .select("id, an, validat, data_validare")
    .eq("parohie_id", parohieId)
    .order("an", { ascending: true });
  if (error) throw error;
  if (!prevederi || prevederi.length === 0) return {};

  const { data: linii, error: errLinii } = await supabase
    .from("prevederi_bugetare_linii")
    .select("id, prevedere_id, cont_id, suma")
    .in(
      "prevedere_id",
      prevederi.map((p) => p.id)
    );
  if (errLinii) throw errLinii;

  // Regrupăm pe an, în forma { [an]: { validat, dataValidare, linii } } — aceeași
  // formă pe care o folosea state.prevederiBugetare local, ca migrarea din UI să fie minimă.
  const rezultat = {};
  for (const p of prevederi) {
    rezultat[p.an] = {
      validat: p.validat,
      dataValidare: p.data_validare,
      linii: (linii || [])
        .filter((l) => l.prevedere_id === p.id)
        .map((l) => ({ contId: l.cont_id, suma: Number(l.suma) })),
    };
  }
  return rezultat;
}

// Validează (creează sau suprascrie) prevederile bugetare ale unui an, cu toate liniile.
// `linii` = [{ contId, suma }, ...], exact forma folosită deja în PrevederiBugetareForm.
export async function salveazaPrevederiBugetare(parohieId, an, linii) {
  const { data: prevedere, error } = await supabase
    .from("prevederi_bugetare")
    .upsert(
      { parohie_id: parohieId, an, validat: true, data_validare: todayISO() },
      { onConflict: "parohie_id,an" }
    )
    .select()
    .single();
  if (error) throw error;

  // Ștergem liniile vechi (dacă e o corecție ulterioară) și inserăm setul nou complet.
  const { error: errDelete } = await supabase
    .from("prevederi_bugetare_linii")
    .delete()
    .eq("prevedere_id", prevedere.id);
  if (errDelete) throw errDelete;

  if (linii && linii.length > 0) {
    const { error: errInsert } = await supabase.from("prevederi_bugetare_linii").insert(
      linii.map((l) => ({
        prevedere_id: prevedere.id,
        cont_id: String(l.contId),
        suma: l.suma,
      }))
    );
    if (errInsert) throw errInsert;
  }

  return prevedere;
}

/* ------------------------------ Registru Jurnal ------------------------------ */

// Corespondența dintre "tip"-ul local, plat (folosit peste tot în UI/rapoarte: "incasare",
// "plata", "nrcd", "bonConsum", "procesVerbal") și tipul de rând din tabelul `documente`.
// Aceleași chei "incasare"/"plata"/etc. sunt folosite și ca p_tip la numerotarea atomică
// (funcția get_next_number), conform comentariului din schema tabelului `contoare`.
const TIP_DOCUMENT_SUPABASE = {
  incasare: "chitanta",
  plata: "ordin_plata",
  nrcd: "nrcd",
  bonConsum: "bon_consum",
  procesVerbal: "proces_verbal_inventariere",
  facturaFurnizor: "factura_furnizor",
};
const TIP_OPERATIUNE_LOCAL = {
  ...Object.fromEntries(Object.entries(TIP_DOCUMENT_SUPABASE).map(([k, v]) => [v, k])),
  // Viramentele interne (581/5081) au propriul bazin de numerotare, izolat complet de chitanțe/OP
  // (vezi p_categorie_numerotare din creeaza_document_tranzactional) — la citire, se mapează
  // înapoi la același "tip" semantic (incasare/plata), pentru calculul soldurilor.
  virament_incasare: "incasare",
  virament_plata: "plata",
};

// Alocă atomic (pe server, sigur sub concurență) următorul număr pentru un tip de document,
// într-un an dat, apelând funcția SQL get_next_number deja creată în schema Supabase.
async function urmatorulNumar(parohieId, an, tipLocal) {
  const { data, error } = await supabase.rpc("get_next_number", {
    p_parohie_id: parohieId,
    p_an: an,
    p_tip: tipLocal,
  });
  if (error) throw error;
  return data;
}

// Versiune publică a aceleiași alocări — folosită acolo unde stocul (Pangar/Cimitir) trebuie
// actualizat separat de crearea documentului, deci nu poate trece prin RPC-ul tranzacțional de
// mai jos. Rămâne parte dintr-o secvență cu mai mulți pași, nu una singură, atomică.
export async function rezervaUrmatorulNumar(parohieId, an, tip) {
  return urmatorulNumar(parohieId, an, tip);
}

// Creează un document nou (Chitanță, Ordin de plată, NRCD, Bon de consum) cu toate liniile lui,
// într-o SINGURĂ tranzacție SQL atomică (funcția creeaza_document_tranzactional din Supabase) —
// numărul, antetul și liniile fie se scriu toate deodată, fie nu se schimbă nimic. Elimină
// definitiv riscul de documente pe jumătate sau numere sărite dacă rețeaua cade la mijloc.
//
// `modPlata` (parametru de nivel document) e folosit doar ca valoare implicită pentru liniile
// care nu specifică propriul `modPlata` — sursa/destinația (Casă/Bancă) e stocată efectiv PER
// LINIE, ca un document (ex. o chitanță) să poată combina o linie în Casă cu o linie în Bancă.
// `linii` = [{ contId, suma, explicatie, modPlata?, ajustare106? }, ...]
export async function salveazaDocument(
  parohieId,
  { tip, data, tert, modPlata, furnizor, nrFactura, dataScadenta, status, motiv, beneficiar, documentSursaId, linii, serie, numarIdentificare, categorieNumerotare }
) {
  // O linie e validă în cele două cazuri: sumă reală (>0, cu articol bugetar obligatoriu — cazul
  // normal) SAU sumă exact 0 și fără cont bugetar (cazul unic acceptat: chitanță ANULATĂ — vezi
  // ChitantaForm, care e singurul loc din UI ce construiește o astfel de linie). Nicio altă
  // combinație (ex. sumă 0 CU cont, sau sumă negativă) nu trece mai departe.
  const liniiValide = (linii || [])
    .filter((l) => Number(l.suma) > 0 || (Number(l.suma) === 0 && !l.contId))
    .map((l) => ({
      contId: l.contId ? String(l.contId) : null,
      suma: l.suma,
      explicatie: l.explicatie || null,
      modPlata: l.modPlata || modPlata || null,
      ajustare106: !!l.ajustare106,
      esteExcedentReportat: !!l.esteExcedentReportat,
    }));

  const { data: rezultat, error } = await supabase.rpc("creeaza_document_tranzactional", {
    p_parohie_id: parohieId,
    p_tip: tip,
    p_data: data,
    p_tert: tert || null,
    p_mod_plata: modPlata || null,
    p_furnizor: furnizor || null,
    p_nr_factura: nrFactura || null,
    p_data_scadenta: dataScadenta || null,
    p_status: status || null,
    p_document_sursa_id: documentSursaId || null,
    p_linii: liniiValide,
    p_serie: serie || null,
    p_numar_identificare: numarIdentificare || null,
    p_categorie_numerotare: categorieNumerotare || null,
  });
  if (error) {
    // Eroarea de duplicat Serie+Număr vine direct din constrângerea unică de la nivel de bază
    // de date — o traducem într-un mesaj clar, în loc să afișăm eroarea tehnică brută.
    if (error.message?.includes("uq_chitanta_serie_numar")) {
      throw new Error(`Seria ${serie} nr. ${numarIdentificare} a fost deja folosită la o altă chitanță — verifică numărul introdus.`);
    }
    throw error;
  }

  const { documentId, nr, an, renumerotari } = rezultat;

  // Reconstruim exact forma "operatiuniNoi" locală (un rând per linie bugetară), ca apelantul
  // s-o poată pune direct în state.operatiuni, la fel ca înainte de migrare. Funcția SQL nu
  // întoarce id-urile liniilor inserate, așa că le citim printr-un singur select suplimentar.
  let operatiuniNoi = [];
  if (liniiValide.length > 0) {
    const { data: liniiInserate, error: errLinii } = await supabase
      .from("linii_document")
      .select("*")
      .eq("document_id", documentId);
    if (errLinii) throw errLinii;
    operatiuniNoi = liniiInserate.map((l) => ({
      id: l.id,
      tip,
      contId: l.cont_id,
      data,
      suma: Number(l.suma),
      modPlata: l.mod_plata,
      tert,
      explicatie: l.explicatie || "",
      nr,
      an,
      ajustare106: !!l.ajustare106,
      esteExcedentReportat: !!l.este_excedent_reportat,
      documentId,
      serie: serie || null,
      numarIdentificare: numarIdentificare || null,
    }));
  }

  // Documentul nou poate fi datat mai vechi decât altele deja emise — în acest caz, TOT setul
  // de documente ale acestui tip/an a fost renumerotat cronologic în aceeași tranzacție.
  // `renumerotari` = [{ documentId, nrNou }, ...] pentru orice document existent al cărui număr
  // s-a schimbat — apelantul trebuie să aplice aceste corecții pe operatiunile deja încărcate local.
  return { operatiuniNoi, nr, an, documentId, renumerotari: renumerotari || [] };
}

// Aduce toate documentele + liniile lor pentru o parohie, reconstruite direct în forma
// "operatiuni" plată (un rând per linie bugetară) pe care o folosește restul aplicației —
// aceeași formă produsă local de construiesteChitanta()/construiesteOrdinPlata().
export async function getOperatiuni(parohieId) {
  const { data: documente, error } = await supabase
    .from("documente")
    .select("*")
    .eq("parohie_id", parohieId)
    .order("an", { ascending: true })
    .order("nr", { ascending: true });
  if (error) throw error;
  if (!documente || documente.length === 0) return [];

  const linii = await inLoturi(
    (lot) => supabase.from("linii_document").select("*").in("document_id", lot),
    documente.map((d) => d.id)
  );

  const operatiuni = [];
  for (const doc of documente) {
    const liniiDoc = (linii || []).filter((l) => l.document_id === doc.id);
    for (const l of liniiDoc) {
      operatiuni.push({
        id: l.id,
        tip: TIP_OPERATIUNE_LOCAL[doc.tip] || doc.tip,
        contId: l.cont_id,
        data: doc.data,
        suma: Number(l.suma),
        modPlata: l.mod_plata || doc.mod_plata,
        tert: doc.tert,
        explicatie: l.explicatie || "",
        nr: doc.nr,
        an: doc.an,
        ajustare106: !!l.ajustare106,
        esteExcedentReportat: !!l.este_excedent_reportat,
        furnizor: doc.furnizor,
        nrFactura: doc.nr_factura,
        dataScadenta: doc.data_scadenta,
        status: doc.status,
        motiv: doc.motiv,
        serie: doc.serie || null,
        numarIdentificare: doc.numar_identificare || null,
        beneficiar: doc.beneficiar,
        documentSursaId: doc.document_sursa_id,
        documentId: doc.id,
      });
    }
  }
  return operatiuni;
}

// Editare directă a unui document existent (butonul "Modifică" din Navigatorul de documente) —
// actualizează antetul (data, tert) și liniile: cele cu `id` sunt UPDATE, cele fără `id` sunt
// linii noi (INSERT), iar `idsDeSters` sunt linii existente eliminate de utilizator (DELETE).
// Fiecare linie își poartă propriul `modPlata` (Casă/Bancă) — un document poate combina linii
// cu surse diferite (ex. o chitanță cu o linie în Casă și o linie în Bancă).
//
// `nr` (opțional) — dacă utilizatorul a editat manual numărul documentului, e scris tentativ
// aici; nu contează neapărat ca valoare finală, pentru că mai jos ÎNTOTDEAUNA (pentru chitanță
// și ordin de plată) se declanșează resincronizarea cronologică a întregii secvențe (tip+an) —
// data decide ordinea finală, iar `nr`-ul introdus manual servește doar ca tiebreaker între
// documente cu aceeași dată. Constrângerea unică documente_parohie_id_tip_nr_an_key e
// DEFERRABLE INITIALLY DEFERRED, deci scrierea tentativă de mai jos nu poate intra în conflict
// tranzitoriu cu alt document — verificarea reală se face abia la commit.
//
// Întoarce liniile nou-inserate cu id-ul lor real din Supabase (ca apelantul să poată actualiza
// corect state.operatiuni local) și `renumerotari` — lista completă a documentelor a căror
// numerotare s-a schimbat în urma resincronizării (inclusiv, eventual, documentul curent).
export async function actualizeazaDocument(documentId, { data, tert, nr }, linii, idsDeSters = []) {
  const { data: docActual, error: errGet } = await supabase
    .from("documente")
    .select("parohie_id, tip, an")
    .eq("id", documentId)
    .single();
  if (errGet) throw errGet;

  const { error: errTert } = await supabase.from("documente").update({ tert: tert || null }).eq("id", documentId);
  if (errTert) throw errTert;

  if (idsDeSters.length > 0) {
    const { error: errDel } = await supabase.from("linii_document").delete().in("id", idsDeSters);
    if (errDel) throw errDel;
  }

  const liniiNoiInserate = [];
  for (const l of linii) {
    const patch = {
      cont_id: String(l.contId),
      suma: Number(l.suma),
      explicatie: l.explicatie || null,
      mod_plata: l.modPlata || null,
    };
    if (l.ajustare106 !== undefined) patch.ajustare106 = !!l.ajustare106;

    if (l.id) {
      const { error } = await supabase.from("linii_document").update(patch).eq("id", l.id);
      if (error) throw error;
    } else {
      const { data: inserata, error } = await supabase
        .from("linii_document")
        .insert({ document_id: documentId, ...patch })
        .select()
        .single();
      if (error) throw error;
      liniiNoiInserate.push({ idTemporar: l.idTemporar, id: inserata.id });
    }
  }

  // Data + nr + resincronizare cronologică — TOATE într-un singur apel RPC, atomic. Scrierea
  // tentativă a nr-ului separat de resincronizare (cum era înainte) putea intra direct în
  // conflict cu constrângerea unică (parohie_id, tip, nr, an) dacă userul introducea manual un
  // nr deja ocupat de alt document — funcția SQL `actualizeaza_data_nr_document` rezolvă asta,
  // scriind și cascadând în ACEEAȘI tranzacție (constrângerea, DEFERRABLE, se verifică abia la
  // commit, când secvența e deja unică).
  let renumerotari = [];
  if (docActual.tip === "chitanta" || docActual.tip === "ordin_plata" || docActual.tip === "virament_plata" || docActual.tip === "virament_incasare") {
    const { data: rezultatResort, error: errResort } = await supabase.rpc("actualizeaza_data_nr_document", {
      p_document_id: documentId,
      p_data_noua: data,
      p_nr_nou: nr !== undefined && nr !== null && nr !== "" ? Number(nr) : null,
    });
    if (errResort) throw errResort;
    renumerotari = (rezultatResort || []).map((r) => ({ documentId: r.document_id, nrNou: r.nr_nou }));
  } else {
    // Alte tipuri de document (NRCD etc.) nu trec prin resincronizare — doar data se actualizează.
    const { error: errData } = await supabase.from("documente").update({ data }).eq("id", documentId);
    if (errData) throw errData;
  }

  return { liniiNoiInserate, renumerotari };
}

/* ---------------------- Excedent reportat (Chitanța nr. 1/an) ---------------------- */

// Găsește (dacă există) Chitanța nr. 1 a anului `an`, cu liniile ei marcate drept excedent
// reportat (`este_excedent_reportat = true`), separat pe Casă (numerar) și Bancă (transfer).
export async function getExcedentReportat(parohieId, an) {
  const { data: doc, error } = await supabase
    .from("documente")
    .select("id, nr, an, data, tert")
    .eq("parohie_id", parohieId)
    .eq("tip", "chitanta")
    .eq("an", an)
    .eq("nr", 1)
    .maybeSingle();
  if (error) throw error;
  if (!doc) return { document: null, linieCasa: null, linieBanca: null, linieDepozit: null };

  const { data: linii, error: errLinii } = await supabase
    .from("linii_document")
    .select("*")
    .eq("document_id", doc.id)
    .eq("este_excedent_reportat", true);
  if (errLinii) throw errLinii;

  return {
    document: doc,
    linieCasa: (linii || []).find((l) => l.mod_plata === "numerar") || null,
    linieBanca: (linii || []).find((l) => l.mod_plata === "transfer") || null,
    linieDepozit: (linii || []).find((l) => l.mod_plata === "depozit") || null,
  };
}

// Creează SAU actualizează liniile de excedent reportat (Casă + Bancă + Depozit bancar, dacă
// există) ale Chitanței nr. 1/an, cu soldurile calculate la 31.12.(an-1). Dacă documentul nu
// există încă, îl creează (cu numerotare atomică, prin salveazaDocument); dacă există deja,
// actualizează liniile deja marcate (sau le adaugă, dacă vreuna lipsește) — fără să atingă restul
// liniilor documentului, dacă mai are și altele introduse manual. Linia de Depozit bancar se
// creează doar dacă parohia are efectiv un sold de depozit diferit de zero (altfel ar adăuga o
// linie inutilă, la zero, pentru parohiile fără depozite).
export async function seteazaExcedentReportat(parohieId, an, { soldCasa, soldBanca, soldDepozit = 0 }, contId = "106") {
  const existent = await getExcedentReportat(parohieId, an);

  if (!existent.document) {
    const linii = [
      { contId, suma: soldCasa, explicatie: "Excedent din anul precedent — Casă", modPlata: "numerar", esteExcedentReportat: true },
      { contId, suma: soldBanca, explicatie: "Excedent din anul precedent — Bancă", modPlata: "transfer", esteExcedentReportat: true },
    ];
    if (soldDepozit !== 0) {
      linii.push({ contId, suma: soldDepozit, explicatie: "Excedent din anul precedent — Depozit bancar", modPlata: "depozit", esteExcedentReportat: true });
    }
    const { operatiuniNoi, nr, documentId } = await salveazaDocument(parohieId, {
      tip: "incasare",
      data: `${an}-01-01`,
      tert: "Excedent reportat din anul precedent",
      linii,
    });
    return { operatiuniActualizate: operatiuniNoi, nr, an, documentId, creatNou: true };
  }

  const { document } = existent;
  const operatiuniActualizate = [];
  const perechi = [
    [existent.linieCasa, soldCasa, "Excedent din anul precedent — Casă", "numerar"],
    [existent.linieBanca, soldBanca, "Excedent din anul precedent — Bancă", "transfer"],
  ];
  // Linia de Depozit se procesează doar dacă deja există (poate fi actualizată, inclusiv la zero,
  // dacă depozitul s-a lichidat) sau dacă noul sold e diferit de zero (se creează abia acum).
  if (existent.linieDepozit || soldDepozit !== 0) {
    perechi.push([existent.linieDepozit, soldDepozit, "Excedent din anul precedent — Depozit bancar", "depozit"]);
  }
  for (const [linieExistenta, suma, eticheta, sursa] of perechi) {
    let rand;
    if (linieExistenta) {
      const { data, error } = await supabase.from("linii_document").update({ suma }).eq("id", linieExistenta.id).select().single();
      if (error) throw error;
      rand = data;
    } else {
      const { data, error } = await supabase
        .from("linii_document")
        .insert({ document_id: document.id, cont_id: contId, suma, explicatie: eticheta, mod_plata: sursa, este_excedent_reportat: true })
        .select()
        .single();
      if (error) throw error;
      rand = data;
    }
    operatiuniActualizate.push({
      id: rand.id, tip: "incasare", contId: rand.cont_id, data: document.data, suma: Number(rand.suma),
      modPlata: sursa, tert: document.tert, explicatie: eticheta, nr: document.nr, an: document.an,
      esteExcedentReportat: true, documentId: document.id,
    });
  }
  return { operatiuniActualizate, documentId: document.id, creatNou: false, nr: document.nr, an: document.an };
}

/* --------------------------------- Pangar --------------------------------- */

// Aduce nomenclatorul de coduri FIFO al parohiei, în forma locală (camelCase) folosită deja
// de PangarTab — cod imutabil Nume.Cost.Preț, stoc curent, stoc de referință pentru pragul de alertă.
export async function getArticolePangar(parohieId) {
  const { data, error } = await supabase.from("articole_pangar").select("*").eq("parohie_id", parohieId).order("seq");
  if (error) throw error;
  return (data || []).map((a) => ({
    id: a.id,
    seq: a.seq,
    bazaCod: a.baza_cod,
    denumire: a.denumire,
    um: a.um,
    pretAchizitie: Number(a.pret_achizitie),
    pretVanzare: Number(a.pret_vanzare),
    cod: a.cod,
    categorieBVC: a.categorie_bvc,
    stoc: Number(a.stoc),
    stocReferinta: Number(a.stoc_referinta),
    locked: a.locked,
    imagineUrl: a.imagine_url || null,
  }));
}

// Aduce mișcările de stoc (intrări = recepții NRCD, ieșiri = vânzări FIFO), completate cu
// metadatele documentului legat (nr NRCD/furnizor/factură la intrări, nr chitanță/an la ieșiri) —
// citite direct din `documente`, ca datele să nu fie duplicate în două locuri.
export async function getMiscariStocPangar(parohieId) {
  const { data: miscari, error } = await supabase.from("miscari_stoc_pangar").select("*").eq("parohie_id", parohieId);
  if (error) throw error;
  if (!miscari || miscari.length === 0) return [];

  const docIds = [...new Set(miscari.map((m) => m.document_id).filter(Boolean))];
  let documenteById = {};
  if (docIds.length > 0) {
    const docs = await inLoturi((lot) => supabase.from("documente").select("*").in("id", lot), docIds);
    documenteById = Object.fromEntries((docs || []).map((d) => [d.id, d]));
  }

  // Necesar pentru "valoareAchizitie" (cost de achiziție) — nu e stocată direct pe mișcare,
  // se calculează din cantitate × prețul de achiziție al articolului la momentul citirii.
  const articolIds = [...new Set(miscari.map((m) => m.articol_id).filter(Boolean))];
  let articoleById = {};
  if (articolIds.length > 0) {
    const { data: articole, error: errArt } = await supabase.from("articole_pangar").select("id, pret_achizitie").in("id", articolIds);
    if (errArt) throw errArt;
    articoleById = Object.fromEntries((articole || []).map((a) => [a.id, a]));
  }

  return miscari.map((m) => {
    const doc = m.document_id ? documenteById[m.document_id] : null;
    const articol = articoleById[m.articol_id];
    const base = {
      id: m.id,
      data: m.data,
      tip: m.tip,
      articolId: m.articol_id,
      cantitate: Number(m.cantitate),
      valoareUnitara: Number(m.valoare_unitara),
      valoareTotala: Number(m.valoare_totala),
      documentId: m.document_id,
    };
    const valoareAchizitieCalculata = articol ? Number(m.cantitate) * Number(articol.pret_achizitie) : null;
    if (m.tip === "intrare") {
      return {
        ...base,
        nrNRCD: doc?.nr ?? null,
        furnizor: doc?.furnizor ?? "Stoc inițial",
        nrFactura: doc?.nr_factura ?? null,
        valoareAchizitie: valoareAchizitieCalculata,
      };
    }
    if (m.tip === "iesire" && doc) {
      return { ...base, nrChitanta: doc.nr, anChitanta: doc.an };
    }
    return base;
  });
}

// Creează un cod nou de produs (produs nou, sau variantă de preț a unuia existent — codul e
// imutabil odată creat, exact ca modelul local). Stocul pornește mereu de la 0.
// Universal valabil: după crearea produsului pentru parohia curentă, e propagat automat (via
// funcția SQL `propaga_produs_toate_parohiile`, SECURITY DEFINER — ocolește RLS doar pt acest
// scop) către toate CELELALTE parohii care nu-l au deja, cu stoc 0 pentru ele.
export async function creeazaArticolPangar(parohieId, { seq, bazaCod, denumire, um, pretAchizitie, pretVanzare, cod, categorieBVC }) {
  const { data, error } = await supabase
    .from("articole_pangar")
    .insert({
      parohie_id: parohieId, seq, baza_cod: bazaCod, denumire, um,
      pret_achizitie: pretAchizitie, pret_vanzare: pretVanzare, cod, categorie_bvc: categorieBVC,
      stoc: 0, stoc_referinta: 0, locked: true,
    })
    .select()
    .single();
  if (error) throw error;

  const { error: errPropagare } = await supabase.rpc("propaga_produs_toate_parohiile", {
    p_cod: cod, p_baza_cod: bazaCod, p_denumire: denumire, p_um: um,
    p_pret_achizitie: pretAchizitie, p_pret_vanzare: pretVanzare, p_categorie_bvc: categorieBVC, p_seq: seq,
  });
  if (errPropagare) {
    // Produsul curent tot s-a creat cu succes — doar propagarea la celelalte parohii a eșuat.
    // Nu blocăm operațiunea utilizatorului pentru asta, dar semnalăm clar în consolă.
    console.error("Eroare la propagarea produsului către celelalte parohii:", errPropagare);
  }

  return {
    id: data.id, seq: data.seq, bazaCod: data.baza_cod, denumire: data.denumire, um: data.um,
    pretAchizitie: Number(data.pret_achizitie), pretVanzare: Number(data.pret_vanzare), cod: data.cod,
    categorieBVC: data.categorie_bvc, stoc: 0, stocReferinta: 0, locked: true, imagineUrl: null,
  };
}

// Nomenclator standard Pangar — creat automat, într-un singur insert, pentru orice parohie
// constatată (la încărcare) cu ZERO produse în articole_pangar. Nicio parohie nu trebuie să
// rămână vreodată fără nomenclator: dacă Supabase întoarce 0 produse, se populează imediat cu
// lista standard (candele, lumânări, colportaj, vin — prețuri conform circularelor bisericești
// curente la data scrierii). Stocul pornește mereu de la 0; produsele rezultate sunt reale,
// persistate în Supabase (nu date locale/false).
export async function creeazaNomenclatorStandardPangar(parohieId, produseStandard) {
  const randuri = produseStandard.map((p) => ({
    parohie_id: parohieId, seq: p.seq, baza_cod: p.bazaCod, denumire: p.denumire, um: p.um,
    pret_achizitie: p.pretAchizitie, pret_vanzare: p.pretVanzare, cod: p.cod,
    categorie_bvc: p.categorieBVC, stoc: 0, stoc_referinta: 0, locked: true,
  }));
  const { data, error } = await supabase.from("articole_pangar").insert(randuri).select();
  if (error) throw error;
  return (data || []).map((a) => ({
    id: a.id, seq: a.seq, bazaCod: a.baza_cod, denumire: a.denumire, um: a.um,
    pretAchizitie: Number(a.pret_achizitie), pretVanzare: Number(a.pret_vanzare), cod: a.cod,
    categorieBVC: a.categorie_bvc, stoc: 0, stocReferinta: 0, locked: true, imagineUrl: null,
  }));
}

// Nomenclatorul canonic curent — câte un rând per cod distinct, din TOATE parohiile la un loc
// (via funcția SQL `obtine_nomenclator_canonic`, SECURITY DEFINER — ocolește RLS doar pt acest
// scop de citire). Folosit la popularea unei parohii noi cu tot ce există la acel moment (nu
// doar lista fixă inițială de 56 — orice produs adăugat între timp, de orice parohie).
export async function getNomenclatorCanonicPangar() {
  const { data, error } = await supabase.rpc("obtine_nomenclator_canonic");
  if (error) throw error;
  return (data || []).map((p) => ({
    seq: p.seq, bazaCod: p.baza_cod, denumire: p.denumire, um: p.um,
    pretAchizitie: Number(p.pret_achizitie), pretVanzare: Number(p.pret_vanzare),
    cod: p.cod, categorieBVC: p.categorie_bvc,
  }));
}

// Încarcă o fotografie pentru un produs (folosită doar în ecranul de nomenclator, pentru
// răsfoire vizuală — niciodată în listele derulante de selecție ale formularelor de
// recepție/vânzare). Un produs nou primește fotografia opțional, imediat după creare.
export async function incarcaImagineProdusPangar(parohieId, articolId, file) {
  const extensie = file.name.split(".").pop();
  const cale = `${parohieId}/${articolId}.${extensie}`;
  const { error: errUpload } = await supabase.storage
    .from("produse-pangar")
    .upload(cale, file, { upsert: true });
  if (errUpload) throw errUpload;

  const { data: urlData } = supabase.storage.from("produse-pangar").getPublicUrl(cale);
  // Adăugăm un parametru aleator, ca browserul să nu arate o poză veche din cache dacă se
  // înlocuiește fotografia unui produs existent (același nume de fișier, conținut nou).
  const imagineUrl = `${urlData.publicUrl}?v=${Date.now()}`;

  const { error: errUpdate } = await supabase.from("articole_pangar").update({ imagine_url: imagineUrl }).eq("id", articolId);
  if (errUpdate) throw errUpdate;

  return imagineUrl;
}

// Recepție NRCD completă: creează documentul NRCD (fără linii bugetare proprii), actualizează
// stocul articolului, înregistrează mișcarea de intrare, și — dacă se achită acum — generează
// și Ordinul de plată legat (document_sursa_id = NRCD-ul), toate persistate în Supabase.
// Recepție NRCD completă, cu LINII MULTIPLE (mai multe produse diferite, pe aceeași factură,
// exact ca la o factură reală) — creează documentul NRCD (fără linii bugetare proprii),
// actualizează stocul fiecărui produs, înregistrează câte o mișcare de intrare per produs, și —
// dacă se achită acum — generează Ordinul de plată legat (document_sursa_id = NRCD-ul), cu câte
// o linie per cont de achiziție distinct (produse din categorii diferite au conturi diferite).
// `linii` = [{ articolId, cantitate }, ...]. `categoriiPangar` = constanta CATEGORII_PANGAR.
export async function receptioneazaPangar(parohieId, { linii, data, furnizor, nrFactura, plataAcum, modPlata, dataScadenta, categoriiPangar }) {
  // Validăm ÎNTÂI toate articolele — dacă vreunul lipsește, nu s-a consumat încă niciun număr
  // real de NRCD și nu rămâne niciun document orfan în urma erorii.
  const articolIds = linii.map((l) => l.articolId);
  const { data: articoleCurente, error: errArt } = await supabase.from("articole_pangar").select("*").in("id", articolIds);
  if (errArt) throw errArt;
  if (!articoleCurente || articoleCurente.length !== articolIds.length) {
    throw new Error("Unul dintre produsele selectate nu a fost găsit în nomenclator.");
  }
  const articolById = Object.fromEntries(articoleCurente.map((a) => [a.id, a]));

  const rezultatNrcd = await salveazaDocument(parohieId, {
    tip: "nrcd",
    data,
    furnizor,
    nrFactura,
    dataScadenta: plataAcum ? null : dataScadenta,
    status: plataAcum ? "achitata" : "neachitata",
    linii: [],
  });
  const nrcdDocId = rezultatNrcd.documentId;

  const miscariNoi = [];
  let valoareAchizitieTotala = 0;
  const sumePeContAchizitie = {}; // contId achiziție -> suma (pentru Ordinul de plată, dacă e cazul)

  for (const l of linii) {
    const art = articolById[l.articolId];
    const stocNou = Number(art.stoc) + l.cantitate;
    const { error: errUpdate } = await supabase
      .from("articole_pangar")
      .update({ stoc: stocNou, stoc_referinta: stocNou })
      .eq("id", art.id);
    if (errUpdate) throw errUpdate;

    const valoareTotala = l.cantitate * Number(art.pret_vanzare);
    const { data: miscareInserata, error: errMiscare } = await supabase
      .from("miscari_stoc_pangar")
      .insert({
        parohie_id: parohieId, articol_id: art.id, tip: "intrare", data, cantitate: l.cantitate,
        valoare_unitara: art.pret_vanzare, valoare_totala: valoareTotala, document_id: nrcdDocId,
      })
      .select()
      .single();
    if (errMiscare) throw errMiscare;

    const valoareAchizitie = l.cantitate * Number(art.pret_achizitie);
    valoareAchizitieTotala += valoareAchizitie;
    const contIdAchizitie = categoriiPangar[art.categorie_bvc].achizitie;
    sumePeContAchizitie[contIdAchizitie] = (sumePeContAchizitie[contIdAchizitie] || 0) + valoareAchizitie;

    miscariNoi.push({
      id: miscareInserata.id, data, tip: "intrare", articolId: art.id, cantitate: l.cantitate,
      valoareUnitara: Number(art.pret_vanzare), valoareTotala,
      nrNRCD: rezultatNrcd.nr, furnizor, nrFactura, valoareAchizitie, documentId: nrcdDocId,
    });
  }

  let operatiuniPlata = [];
  let nrOP = null;
  let renumerotariPlata = [];
  if (plataAcum) {
    const liniiPlata = Object.entries(sumePeContAchizitie).map(([contId, suma]) => ({
      contId, suma, modPlata,
      explicatie: `Plată factură ${nrFactura} (NRCD nr. ${rezultatNrcd.nr}/${rezultatNrcd.an})`,
    }));
    const rezultatPlata = await salveazaDocument(parohieId, {
      tip: "plata", data, tert: furnizor, documentSursaId: nrcdDocId, linii: liniiPlata,
    });
    operatiuniPlata = rezultatPlata.operatiuniNoi;
    nrOP = rezultatPlata.nr;
    renumerotariPlata = rezultatPlata.renumerotari || [];
  }

  return {
    nrNRCD: rezultatNrcd.nr,
    anNRCD: rezultatNrcd.an,
    articolePatch: articoleCurente.map((a) => {
      const linie = linii.find((l) => l.articolId === a.id);
      const stocNou = Number(a.stoc) + linie.cantitate;
      return { id: a.id, stoc: stocNou, stocReferinta: stocNou };
    }),
    miscariNoi,
    operatiuniPlata,
    nrOP,
    renumerotari: [...(rezultatNrcd.renumerotari || []), ...renumerotariPlata],
    datorieNoua: !plataAcum
      ? { furnizor, suma: valoareAchizitieTotala, nrFactura, nrNRCD: rezultatNrcd.nr, dataFactura: data, dataScadenta, status: "neachitata", documentId: nrcdDocId }
      : null,
  };
}

// Vânzare FIFO cu linii multiple — mai multe produse diferite, vândute simultan, pe o singură
// chitanță (exact ca la o vânzare reală, cu mai multe articole în același coș). `linii` =
// [{ bazaCod, cantitateTotala }, ...]. `categoriiPangar` = constanta CATEGORII_PANGAR.
export async function vanzareFIFOPangar(parohieId, { linii, data, tert, modPlata, categoriiPangar, serie, numarIdentificare }) {
  const consumuriTotale = [];

  for (const linie of linii) {
    const { data: coduri, error } = await supabase
      .from("articole_pangar")
      .select("*")
      .eq("parohie_id", parohieId)
      .eq("baza_cod", linie.bazaCod)
      .gt("stoc", 0)
      .order("seq");
    if (error) throw error;

    let ramas = linie.cantitateTotala;
    for (const cod of coduri || []) {
      if (ramas <= 0) break;
      const cantDinCod = Math.min(Number(cod.stoc), ramas);
      ramas -= cantDinCod;
      consumuriTotale.push({ articol: cod, cantitate: cantDinCod });
    }
    if (ramas > 0) {
      throw new Error(`Stoc insuficient pentru ${linie.bazaCod} (verificat direct în Supabase).`);
    }
  }

  const liniiBugetare = [];
  for (const c of consumuriTotale) {
    const cat = categoriiPangar[c.articol.categorie_bvc];
    const cost = c.cantitate * Number(c.articol.pret_achizitie);
    const propriu = c.cantitate * Number(c.articol.pret_vanzare) - cost;
    liniiBugetare.push({ contId: cat.venitTranzitoriu, suma: cost, explicatie: `Vânzare pangar — ${c.articol.cod} — ${fmtCantitate(c.cantitate)} ${c.articol.um}`, modPlata });
    liniiBugetare.push({ contId: cat.venitPropriu, suma: propriu, explicatie: `Vânzare pangar — ${c.articol.cod} — ${fmtCantitate(c.cantitate)} ${c.articol.um} (marjă)`, modPlata });
  }

  // Creăm ÎNTÂI chitanța (stocul a fost deja verificat mai sus, doar citire) — dacă scrierea
  // documentului eșuează, stocul rămâne neschimbat, în loc să fie scăzut fără niciun document.
  const rezultatDoc = await salveazaDocument(parohieId, { tip: "incasare", data, tert, modPlata, linii: liniiBugetare, serie, numarIdentificare });

  for (const c of consumuriTotale) {
    const stocNou = Number(c.articol.stoc) - c.cantitate;
    const { error: errUpd } = await supabase.from("articole_pangar").update({ stoc: stocNou }).eq("id", c.articol.id);
    if (errUpd) throw errUpd;
  }

  const miscariNoi = [];
  for (const c of consumuriTotale) {
    const valoareTotala = c.cantitate * Number(c.articol.pret_vanzare);
    const { data: miscareInserata, error: errMiscare } = await supabase
      .from("miscari_stoc_pangar")
      .insert({
        parohie_id: parohieId, articol_id: c.articol.id, tip: "iesire", data, cantitate: c.cantitate,
        valoare_unitara: c.articol.pret_vanzare, valoare_totala: valoareTotala, document_id: rezultatDoc.documentId,
      })
      .select()
      .single();
    if (errMiscare) throw errMiscare;
    miscariNoi.push({
      id: miscareInserata.id, data, tip: "iesire", articolId: c.articol.id, cantitate: c.cantitate,
      valoareUnitara: Number(c.articol.pret_vanzare), valoareTotala,
      nrChitanta: rezultatDoc.nr, anChitanta: rezultatDoc.an, documentId: rezultatDoc.documentId,
    });
  }

  return {
    nr: rezultatDoc.nr,
    an: rezultatDoc.an,
    operatiuniNoi: rezultatDoc.operatiuniNoi,
    articolePatch: consumuriTotale.map((c) => ({ id: c.articol.id, stocNou: Number(c.articol.stoc) - c.cantitate })),
    miscariNoi,
    renumerotari: rezultatDoc.renumerotari || [],
    totalVanzare: liniiBugetare.reduce((sum, l) => sum + l.suma, 0),
  };
}

// Editează o recepție NRCD existentă (o singură mișcare de intrare) — actualizează stocul prin
// diferență, actualizează mișcarea, actualizează documentul NRCD (dată/furnizor/factură/scadență),
// și — dacă factura era deja plătită — actualizează și suma pe Ordinul de plată legat.
// `articolIdNou` (opțional) — corectează codul de produs greșit înregistrat la recepție: dacă
// diferă de codul curent al mișcării, cantitatea se mută integral de pe codul vechi pe cel nou
// (validat separat: reducerea pe codul vechi nu poate duce stocul lui sub 0 — adică nu s-a vândut
// deja din el). Dacă e omis sau identic cu cel curent, comportamentul e cel de dinainte (un singur
// cod, ajustat prin diferență).
export async function editeazaReceptiePangar(miscareId, { data, cantitate, furnizor, nrFactura, dataScadenta, nrOP, articolIdNou, categoriiPangar }) {
  const { data: miscare, error: errM } = await supabase.from("miscari_stoc_pangar").select("*").eq("id", miscareId).single();
  if (errM) throw errM;
  if (miscare.tip !== "intrare") throw new Error("Doar mișcările de recepție pot fi editate astfel.");

  // Dacă recepția are deja o plată (parțială sau integrală) legată, editarea e blocată complet —
  // verificat ÎNAINTE de orice scriere, ca să nu rămână modificări pe jumătate aplicate. O
  // recepție plătită nu se mai corectează retroactiv prin editare directă a stocului/facturii;
  // orice corecție ulterioară trebuie tratată separat (nu prin acest flux).
  const { data: platiLegateVerificare, error: errPlatiVerificare } = await supabase
    .from("documente")
    .select("id, nr, an")
    .eq("document_sursa_id", miscare.document_id)
    .eq("tip", "ordin_plata");
  if (errPlatiVerificare) throw errPlatiVerificare;
  if (platiLegateVerificare && platiLegateVerificare.length > 0) {
    const listaOP = platiLegateVerificare.map((op) => `nr. ${op.nr}/${op.an}`).join(", ");
    throw new Error(`Această recepție are deja plăți înregistrate (Ordin de plată ${listaOP}) — nu poate fi editată. Șterge întâi ordinele de plată legate, dacă vrei să corectezi recepția.`);
  }

  const idNou = articolIdNou && articolIdNou !== miscare.articol_id ? articolIdNou : null;

  const { data: articolVechi, error: errA } = await supabase.from("articole_pangar").select("*").eq("id", miscare.articol_id).single();
  if (errA) throw errA;

  let articolePatch = [];
  let articolFinal; // codul pe care rămâne mișcarea, pentru calculul valorilor de mai jos

  if (!idNou) {
    // Același cod — ajustare prin diferența de cantitate, ca înainte.
    const delta = cantitate - Number(miscare.cantitate);
    const stocNou = Number(articolVechi.stoc) + delta;
    if (stocNou < 0) {
      throw new Error(`Nu poți reduce cantitatea sub ce s-a vândut deja din acest cod (stoc curent: ${articolVechi.stoc}, reducere cerută: ${-delta}).`);
    }
    const { error: errUpdArt } = await supabase.from("articole_pangar").update({ stoc: stocNou, stoc_referinta: stocNou }).eq("id", articolVechi.id);
    if (errUpdArt) throw errUpdArt;
    articolFinal = { ...articolVechi, stoc: stocNou };
    articolePatch = [{ id: articolVechi.id, stoc: stocNou, stocReferinta: stocNou }];
  } else {
    // Cod diferit — se scoate integral cantitatea de pe codul vechi și se adaugă pe cel nou.
    const { data: articolNou, error: errAN } = await supabase.from("articole_pangar").select("*").eq("id", idNou).single();
    if (errAN) throw errAN;

    const stocVechiNou = Number(articolVechi.stoc) - Number(miscare.cantitate);
    if (stocVechiNou < 0) {
      throw new Error(`Nu poți muta recepția pe alt cod — codul greșit (${articolVechi.cod}) are deja stoc vândut din cantitatea recepționată aici (stoc curent: ${Number(articolVechi.stoc)}, de scos: ${Number(miscare.cantitate)}).`);
    }
    const stocNouNou = Number(articolNou.stoc) + cantitate;

    const { error: errUpdVechi } = await supabase.from("articole_pangar").update({ stoc: stocVechiNou, stoc_referinta: stocVechiNou }).eq("id", articolVechi.id);
    if (errUpdVechi) throw errUpdVechi;
    const { error: errUpdNou } = await supabase.from("articole_pangar").update({ stoc: stocNouNou, stoc_referinta: stocNouNou }).eq("id", articolNou.id);
    if (errUpdNou) throw errUpdNou;

    articolFinal = { ...articolNou, stoc: stocNouNou };
    articolePatch = [
      { id: articolVechi.id, stoc: stocVechiNou, stocReferinta: stocVechiNou },
      { id: articolNou.id, stoc: stocNouNou, stocReferinta: stocNouNou },
    ];
  }

  const valoareTotala = cantitate * Number(articolFinal.pret_vanzare);
  const { error: errUpdM } = await supabase
    .from("miscari_stoc_pangar")
    .update({ data, cantitate, valoare_unitara: articolFinal.pret_vanzare, valoare_totala: valoareTotala, ...(idNou ? { articol_id: idNou } : {}) })
    .eq("id", miscareId);
  if (errUpdM) throw errUpdM;

  const { data: nrcdDoc, error: errNrcd } = await supabase
    .from("documente")
    .update({ data, furnizor, nr_factura: nrFactura, data_scadenta: dataScadenta })
    .eq("id", miscare.document_id)
    .select()
    .single();
  if (errNrcd) throw errNrcd;

  const valoareAchizitieNoua = cantitate * Number(articolFinal.pret_achizitie);

  // O recepție poate avea mai multe produse din categorii BVC diferite — recalculăm totalul din
  // TOATE mișcările NRCD-ului (nu doar cea editată), pentru rezumatul datoriei. Nu mai există
  // niciun Ordin de plată de sincronizat aici: recepțiile cu vreo plată legată (parțială sau
  // integrală) au fost deja blocate mai sus, înainte de orice scriere — funcția nu ajunge în
  // acest punct decât pentru recepții încă complet neachitate. `categoriiPangar`/`nrOP` rămân
  // acceptați ca parametri (compatibilitate cu apelantul), dar nu mai sunt folosiți aici.
  const { data: toateMiscarileNrcd, error: errToate } = await supabase
    .from("miscari_stoc_pangar")
    .select("*")
    .eq("document_id", miscare.document_id)
    .eq("tip", "intrare");
  if (errToate) throw errToate;

  const idsArticoleNrcd = [...new Set(toateMiscarileNrcd.map((m) => m.articol_id))];
  const { data: articoleNrcd, error: errArtNrcd } = await supabase.from("articole_pangar").select("id, categorie_bvc, pret_achizitie").in("id", idsArticoleNrcd);
  if (errArtNrcd) throw errArtNrcd;
  const articolNrcdById = Object.fromEntries(articoleNrcd.map((a) => [a.id, a]));

  // Pentru linia tocmai editată folosim direct valorile noi (cantitate, articolFinal) — în DB
  // e deja scrisă mai sus, dar codul ei ar putea să nu fie încă în `articoleNrcd` dacă tocmai
  // s-a mutat pe un cod care nu avea altă mișcare pe acest NRCD.
  const sumePeCategorie = {};
  let valoareAchizitieTotalaNrcd = 0;
  for (const m of toateMiscarileNrcd) {
    const esteLiniaEditata = m.id === miscareId;
    const cant = esteLiniaEditata ? cantitate : Number(m.cantitate);
    const art = esteLiniaEditata ? articolFinal : articolNrcdById[m.articol_id];
    if (!art) continue;
    const valoare = cant * Number(art.pret_achizitie);
    valoareAchizitieTotalaNrcd += valoare;
    sumePeCategorie[art.categorie_bvc] = (sumePeCategorie[art.categorie_bvc] || 0) + valoare;
  }

  const datorieActualizata = {
    suma: valoareAchizitieTotalaNrcd,
    liniiAchizitie: Object.entries(sumePeCategorie).map(([categorieBVC, suma]) => ({ categorieBVC, suma })),
  };

  return {
    articolePatch,
    miscareActualizata: { data, cantitate, valoareTotala, valoareAchizitie: valoareAchizitieNoua, articolId: idNou || miscare.articol_id },
    documentIdOP: null,
    operatiuniNoiOP: [],
    datorieActualizata,
    renumerotari: [],
  };
}

// Adaugă un produs NOU pe un NRCD deja emis (aceeași factură, un cod suplimentar), cu ocazia
// editării recepției. Aceeași blocare ca la editarea unei linii existente: dacă NRCD-ul are deja
// o plată legată (parțială sau integrală), operația e refuzată — factura nu se mai poate modifica
// retroactiv o dată achitată.
export async function adaugaLinieReceptiePangar(documentId, { articolId, cantitate, categoriiPangar }) {
  const { data: platiLegate, error: errPlati } = await supabase
    .from("documente")
    .select("id, nr, an")
    .eq("document_sursa_id", documentId)
    .eq("tip", "ordin_plata");
  if (errPlati) throw errPlati;
  if (platiLegate && platiLegate.length > 0) {
    const listaOP = platiLegate.map((op) => `nr. ${op.nr}/${op.an}`).join(", ");
    throw new Error(`Această recepție are deja plăți înregistrate (Ordin de plată ${listaOP}) — nu poate primi linii noi.`);
  }

  const { data: nrcdDoc, error: errNrcd } = await supabase.from("documente").select("*").eq("id", documentId).single();
  if (errNrcd) throw errNrcd;
  if (nrcdDoc.tip !== "nrcd") throw new Error("Documentul indicat nu este un NRCD.");

  const { data: art, error: errArt } = await supabase.from("articole_pangar").select("*").eq("id", articolId).single();
  if (errArt) throw errArt;

  const stocNou = Number(art.stoc) + cantitate;
  const { error: errUpdArt } = await supabase.from("articole_pangar").update({ stoc: stocNou, stoc_referinta: stocNou }).eq("id", art.id);
  if (errUpdArt) throw errUpdArt;

  const valoareTotala = cantitate * Number(art.pret_vanzare);
  const { data: miscareInserata, error: errMiscare } = await supabase
    .from("miscari_stoc_pangar")
    .insert({
      parohie_id: nrcdDoc.parohie_id, articol_id: art.id, tip: "intrare", data: nrcdDoc.data, cantitate,
      valoare_unitara: art.pret_vanzare, valoare_totala: valoareTotala, document_id: documentId,
    })
    .select()
    .single();
  if (errMiscare) throw errMiscare;

  // Recalculăm datoria totală din TOATE mișcările NRCD-ului (linia nou-adăugată inclusă),
  // exact ca la editarea unei linii existente — un NRCD poate avea produse din mai multe
  // categorii BVC, fiecare cu propriul cont de achiziție.
  const { data: toateMiscarileNrcd, error: errToate } = await supabase
    .from("miscari_stoc_pangar")
    .select("*")
    .eq("document_id", documentId)
    .eq("tip", "intrare");
  if (errToate) throw errToate;

  const idsArticoleNrcd = [...new Set(toateMiscarileNrcd.map((m) => m.articol_id))];
  const { data: articoleNrcd, error: errArtNrcd } = await supabase.from("articole_pangar").select("id, categorie_bvc, pret_achizitie").in("id", idsArticoleNrcd);
  if (errArtNrcd) throw errArtNrcd;
  const articolNrcdById = Object.fromEntries(articoleNrcd.map((a) => [a.id, a]));

  const sumePeCategorie = {};
  let valoareAchizitieTotalaNrcd = 0;
  for (const m of toateMiscarileNrcd) {
    const artM = articolNrcdById[m.articol_id];
    if (!artM) continue;
    const valoare = Number(m.cantitate) * Number(artM.pret_achizitie);
    valoareAchizitieTotalaNrcd += valoare;
    sumePeCategorie[artM.categorie_bvc] = (sumePeCategorie[artM.categorie_bvc] || 0) + valoare;
  }

  const datorieActualizata = {
    suma: valoareAchizitieTotalaNrcd,
    liniiAchizitie: Object.entries(sumePeCategorie).map(([categorieBVC, suma]) => ({ categorieBVC, suma })),
  };

  return {
    articolPatch: { id: art.id, stoc: stocNou, stocReferinta: stocNou },
    miscareNoua: {
      id: miscareInserata.id, data: nrcdDoc.data, tip: "intrare", articolId: art.id, cantitate,
      valoareUnitara: Number(art.pret_vanzare), valoareTotala, nrNRCD: nrcdDoc.nr,
      furnizor: nrcdDoc.furnizor, nrFactura: nrcdDoc.nr_factura, valoareAchizitie: cantitate * Number(art.pret_achizitie),
      documentId,
    },
    datorieActualizata,
  };
}

// Șterge o recepție NRCD întreagă (documentul + toate liniile lui de stoc — un NRCD poate avea
// mai multe produse pe aceeași factură). Restituie stocul consumat pe fiecare cod atins, ca la
// stergeVanzarePangar, dar cu validare ÎNAINTE de orice scriere: dacă pe vreun cod s-a vândut deja
// din cantitatea recepționată aici, ștergerea e blocată în întregime (nicio linie nu se atinge).
// Dacă recepția era deja achitată (are un Ordin de plată legat prin document_sursa_id), ștergerea
// e blocată — utilizatorul trebuie să șteargă întâi Ordinul de plată legat, ca să nu rămână o
// plată înregistrată către o factură care nu mai există.
export async function stergeReceptiePangar(documentId) {
  const { data: platiLegate, error: errPlati } = await supabase
    .from("documente")
    .select("id, nr, an")
    .eq("document_sursa_id", documentId)
    .eq("tip", "ordin_plata");
  if (errPlati) throw errPlati;
  if (platiLegate && platiLegate.length > 0) {
    const listaOP = platiLegate.map((op) => `nr. ${op.nr}/${op.an}`).join(", ");
    throw new Error(`Această recepție este deja achitată (Ordin de plată ${listaOP}) — șterge întâi ordinul/ordinele de plată legate.`);
  }

  const { data: miscariVechi, error: errMV } = await supabase
    .from("miscari_stoc_pangar")
    .select("*")
    .eq("document_id", documentId)
    .eq("tip", "intrare");
  if (errMV) throw errMV;
  if (!miscariVechi || miscariVechi.length === 0) throw new Error("Nu s-au găsit mișcări de stoc pentru această recepție.");

  // Agregăm cantitatea de scos per cod (o recepție poate avea mai multe linii pe același cod,
  // deși neobișnuit) — ca să citim/scriem stocul fiecărui cod o singură dată.
  const cantitatePeArticol = new Map();
  for (const m of miscariVechi) {
    cantitatePeArticol.set(m.articol_id, (cantitatePeArticol.get(m.articol_id) || 0) + Number(m.cantitate));
  }

  const idsAtinse = [...cantitatePeArticol.keys()];
  const { data: articoleAtinse, error: errArt } = await supabase.from("articole_pangar").select("id, cod, stoc").in("id", idsAtinse);
  if (errArt) throw errArt;

  // Validăm ÎNTÂI toate codurile — dacă vreunul ar duce stocul sub 0, nu se scrie nimic.
  for (const art of articoleAtinse) {
    const deScos = cantitatePeArticol.get(art.id);
    if (Number(art.stoc) - deScos < 0) {
      throw new Error(`Nu poți șterge recepția — s-a vândut deja din ce s-a recepționat pe codul ${art.cod} (stoc curent: ${art.stoc}, de scos: ${deScos}).`);
    }
  }

  for (const art of articoleAtinse) {
    const stocNou = Number(art.stoc) - cantitatePeArticol.get(art.id);
    const { error: errRest } = await supabase.from("articole_pangar").update({ stoc: stocNou, stoc_referinta: stocNou }).eq("id", art.id);
    if (errRest) throw errRest;
  }

  const { error: errDelM } = await supabase.from("miscari_stoc_pangar").delete().eq("document_id", documentId).eq("tip", "intrare");
  if (errDelM) throw errDelM;

  const { renumerotari } = await stergeDocument(documentId);

  const { data: articoleFinale, error: errFinale } = await supabase.from("articole_pangar").select("id, stoc").in("id", idsAtinse);
  if (errFinale) throw errFinale;

  return { articolePatch: articoleFinale.map((a) => ({ id: a.id, stoc: Number(a.stoc), stocReferinta: Number(a.stoc) })), renumerotari };
}

// Stoc inițial — intrare de stoc FĂRĂ document asociat (nu generează NRCD, nu generează
// datorie către furnizor). Folosit o singură dată, la pornirea evidenței unui produs, pentru
// cantitatea deja existentă fizic în pangar la acel moment.
export async function creeazaStocInitialPangar(parohieId, { articolId, cantitate, data }) {
  const { data: articol, error: errA } = await supabase.from("articole_pangar").select("*").eq("id", articolId).single();
  if (errA) throw errA;

  const stocNou = Number(articol.stoc) + Number(cantitate);
  const { error: errUpdArt } = await supabase
    .from("articole_pangar")
    .update({ stoc: stocNou, stoc_referinta: stocNou })
    .eq("id", articolId);
  if (errUpdArt) throw errUpdArt;

  const valoareTotala = Number(cantitate) * Number(articol.pret_vanzare);
  const { data: miscareInserata, error: errMiscare } = await supabase
    .from("miscari_stoc_pangar")
    .insert({
      parohie_id: parohieId, articol_id: articolId, tip: "intrare", data, cantitate,
      valoare_unitara: articol.pret_vanzare, valoare_totala: valoareTotala, document_id: null,
    })
    .select()
    .single();
  if (errMiscare) throw errMiscare;

  return {
    articolPatch: { id: articolId, stoc: stocNou, stocReferinta: stocNou },
    miscareNoua: {
      id: miscareInserata.id, data, tip: "intrare", articolId, cantitate: Number(cantitate),
      valoareUnitara: Number(articol.pret_vanzare), valoareTotala, furnizor: "Stoc inițial",
      valoareAchizitie: Number(cantitate) * Number(articol.pret_achizitie), documentId: null,
    },
  };
}

// Editează o mișcare de stoc inițial existentă (fără document asociat) — cantitate și/sau dată.
// Nu atinge NRCD/Ordin de plată, pentru că acestea nu există la stocul inițial.
export async function editeazaStocInitialPangar(miscareId, { cantitate, data }) {
  const { data: miscare, error: errM } = await supabase.from("miscari_stoc_pangar").select("*").eq("id", miscareId).single();
  if (errM) throw errM;
  if (miscare.tip !== "intrare" || miscare.document_id) {
    throw new Error("Această mișcare nu este un stoc inițial editabil pe acest formular.");
  }

  const { data: articol, error: errA } = await supabase.from("articole_pangar").select("*").eq("id", miscare.articol_id).single();
  if (errA) throw errA;

  const delta = Number(cantitate) - Number(miscare.cantitate);
  const stocNou = Number(articol.stoc) + delta;
  if (stocNou < 0) {
    throw new Error(`Nu poți reduce cantitatea sub ce s-a vândut deja din acest cod (stoc curent: ${articol.stoc}, reducere cerută: ${-delta}).`);
  }

  const { error: errUpdArt } = await supabase.from("articole_pangar").update({ stoc: stocNou, stoc_referinta: stocNou }).eq("id", articol.id);
  if (errUpdArt) throw errUpdArt;

  const valoareTotala = Number(cantitate) * Number(articol.pret_vanzare);
  const { error: errUpdM } = await supabase
    .from("miscari_stoc_pangar")
    .update({ data, cantitate, valoare_totala: valoareTotala })
    .eq("id", miscareId);
  if (errUpdM) throw errUpdM;

  return {
    articolActualizat: { stoc: stocNou, stocReferinta: stocNou },
    miscareActualizata: {
      data, cantitate: Number(cantitate), valoareTotala,
      valoareAchizitie: Number(cantitate) * Number(articol.pret_achizitie),
    },
  };
}

// Șterge o mișcare de stoc inițial (fără document asociat) și scade stocul corespunzător.
// Blocată dacă stocul curent al codului e mai mic decât cantitatea de șters (înseamnă că s-a
// vândut deja din acest stoc inițial — ștergerea ar duce stocul sub zero).
export async function stergeStocInitialPangar(miscareId) {
  const { data: miscare, error: errM } = await supabase.from("miscari_stoc_pangar").select("*").eq("id", miscareId).single();
  if (errM) throw errM;
  if (miscare.tip !== "intrare" || miscare.document_id) {
    throw new Error("Această mișcare nu este un stoc inițial ce poate fi șters pe acest formular.");
  }

  const { data: articol, error: errA } = await supabase.from("articole_pangar").select("*").eq("id", miscare.articol_id).single();
  if (errA) throw errA;

  const stocNou = Number(articol.stoc) - Number(miscare.cantitate);
  if (stocNou < 0) {
    throw new Error(`Nu poți șterge acest stoc inițial — s-a vândut deja mai mult decât ar rămâne (stoc curent: ${Number(articol.stoc)}, cantitate stoc inițial: ${Number(miscare.cantitate)}).`);
  }

  const { error: errUpdArt } = await supabase.from("articole_pangar").update({ stoc: stocNou, stoc_referinta: stocNou }).eq("id", articol.id);
  if (errUpdArt) throw errUpdArt;

  const { error: errDel } = await supabase.from("miscari_stoc_pangar").delete().eq("id", miscareId);
  if (errDel) throw errDel;

  return { articolActualizat: { id: articol.id, stoc: stocNou, stocReferinta: stocNou } };
}

// Editează o vânzare FIFO existentă — restituie stocul din consumul vechi, verifică stocul
// disponibil pentru noua cantitate, apoi reface consumul FIFO de la zero, PĂSTRÂND același
// document (deci același nr de chitanță) — doar liniile și mișcările se rescriu.
export async function editeazaVanzarePangar(documentId, { cantitate, data, tert, modPlata, categoriiPangar }) {
  const { data: miscariVechi, error: errMV } = await supabase
    .from("miscari_stoc_pangar")
    .select("*")
    .eq("document_id", documentId)
    .eq("tip", "iesire");
  if (errMV) throw errMV;
  if (!miscariVechi || miscariVechi.length === 0) throw new Error("Nu s-au găsit mișcări de stoc pentru această vânzare.");

  const { data: primulArticol, error: errPA } = await supabase
    .from("articole_pangar")
    .select("baza_cod")
    .eq("id", miscariVechi[0].articol_id)
    .single();
  if (errPA) throw errPA;
  const bazaCod = primulArticol.baza_cod;

  // Restituim stocul din consumul vechi.
  for (const m of miscariVechi) {
    const { data: art, error: errArt } = await supabase.from("articole_pangar").select("stoc").eq("id", m.articol_id).single();
    if (errArt) throw errArt;
    const { error: errRest } = await supabase
      .from("articole_pangar")
      .update({ stoc: Number(art.stoc) + Number(m.cantitate) })
      .eq("id", m.articol_id);
    if (errRest) throw errRest;
  }

  const { data: coduriDisponibile, error: errCoduri } = await supabase
    .from("articole_pangar")
    .select("*")
    .eq("baza_cod", bazaCod)
    .order("seq");
  if (errCoduri) throw errCoduri;

  const stocTotal = (coduriDisponibile || []).reduce((s, a) => s + Number(a.stoc), 0);
  if (cantitate > stocTotal) {
    throw new Error(`Stoc insuficient pentru noua cantitate — disponibil: ${stocTotal}.`);
  }

  const { error: errDelM } = await supabase.from("miscari_stoc_pangar").delete().eq("document_id", documentId).eq("tip", "iesire");
  if (errDelM) throw errDelM;
  const { error: errDelL } = await supabase.from("linii_document").delete().eq("document_id", documentId);
  if (errDelL) throw errDelL;

  let ramas = cantitate;
  const consumuri = [];
  for (const cod of (coduriDisponibile || []).filter((c) => Number(c.stoc) > 0)) {
    if (ramas <= 0) break;
    const cantDinCod = Math.min(Number(cod.stoc), ramas);
    ramas -= cantDinCod;
    consumuri.push({ articol: cod, cantitate: cantDinCod });
  }

  const miscariNoi = [];
  const liniiNoi = [];
  for (const c of consumuri) {
    const { error: errUpdStoc } = await supabase
      .from("articole_pangar")
      .update({ stoc: Number(c.articol.stoc) - c.cantitate })
      .eq("id", c.articol.id);
    if (errUpdStoc) throw errUpdStoc;

    const valoareTotala = c.cantitate * Number(c.articol.pret_vanzare);
    const { data: miscareInserata, error: errIns } = await supabase
      .from("miscari_stoc_pangar")
      .insert({
        parohie_id: c.articol.parohie_id, articol_id: c.articol.id, tip: "iesire", data, cantitate: c.cantitate,
        valoare_unitara: c.articol.pret_vanzare, valoare_totala: valoareTotala, document_id: documentId,
      })
      .select()
      .single();
    if (errIns) throw errIns;

    const cat = categoriiPangar[c.articol.categorie_bvc];
    const cost = c.cantitate * Number(c.articol.pret_achizitie);
    const propriu = valoareTotala - cost;
    liniiNoi.push({ document_id: documentId, cont_id: cat.venitTranzitoriu, suma: cost, explicatie: `Vânzare pangar — ${c.articol.cod} — ${fmtCantitate(c.cantitate)} ${c.articol.um}`, mod_plata: modPlata });
    liniiNoi.push({ document_id: documentId, cont_id: cat.venitPropriu, suma: propriu, explicatie: `Vânzare pangar — ${c.articol.cod} — ${fmtCantitate(c.cantitate)} ${c.articol.um} (marjă)`, mod_plata: modPlata });

    miscariNoi.push({
      id: miscareInserata.id, data, tip: "iesire", articolId: c.articol.id, cantitate: c.cantitate,
      valoareUnitara: Number(c.articol.pret_vanzare), valoareTotala, documentId,
    });
  }

  const { data: liniiInserate, error: errInsL } = await supabase.from("linii_document").insert(liniiNoi).select();
  if (errInsL) throw errInsL;

  const { data: docActualizat, error: errUpdDoc } = await supabase
    .from("documente")
    .update({ data, tert, mod_plata: modPlata })
    .eq("id", documentId)
    .select()
    .single();
  if (errUpdDoc) throw errUpdDoc;

  const operatiuniNoi = liniiInserate.map((l) => ({
    id: l.id, tip: "incasare", contId: l.cont_id, data, suma: Number(l.suma), modPlata: l.mod_plata,
    tert, explicatie: l.explicatie || "", nr: docActualizat.nr, an: docActualizat.an, documentId,
  }));

  // Stocul final real, pentru toate codurile atinse (fie prin restituire, fie prin noul consum) —
  // citit proaspăt, ca apelantul să poată actualiza corect starea locală, fără presupuneri.
  const idsAtinse = [...new Set([...miscariVechi.map((m) => m.articol_id), ...consumuri.map((c) => c.articol.id)])];
  const { data: articoleFinale, error: errFinale } = await supabase.from("articole_pangar").select("id, stoc").in("id", idsAtinse);
  if (errFinale) throw errFinale;

  return {
    articolePatch: articoleFinale.map((a) => ({ id: a.id, stocNou: Number(a.stoc) })),
    miscariNoi,
    operatiuniNoi,
    nrChitanta: docActualizat.nr,
    anChitanta: docActualizat.an,
  };
}

// Editează o vânzare pangar CU MAI MULTE PRODUSE — spre deosebire de editeazaVanzarePangar (un
// singur produs, doar cantitatea), aici `linii` e setul COMPLET și final de produse dorite pe
// chitanța respectivă ({ bazaCod, cantitateTotala }[]) — poate include produse complet noi, care
// nu erau pe chitanța inițială, sau poate elimina produse existente. Se restituie mai întâi TOT
// stocul consumat anterior de acest document (indiferent de produs), apoi se reconsumă FIFO din
// nou, conform noului set de linii.
export async function editeazaVanzareMultiplaPangar(documentId, { linii, data, tert, modPlata, serie, numarIdentificare, nr, categoriiPangar }) {
  const { data: miscariVechi, error: errMV } = await supabase
    .from("miscari_stoc_pangar")
    .select("*")
    .eq("document_id", documentId)
    .eq("tip", "iesire");
  if (errMV) throw errMV;
  if (!miscariVechi || miscariVechi.length === 0) throw new Error("Nu s-au găsit mișcări de stoc pentru această vânzare.");

  const parohieId = miscariVechi[0].parohie_id;

  // Restituim TOT stocul consumat anterior (indiferent de produs) — verificarea de stoc suficient
  // pentru noul set de linii se face DUPĂ restituire, ca disponibilitatea reală să fie corectă.
  for (const m of miscariVechi) {
    const { data: art, error: errArt } = await supabase.from("articole_pangar").select("stoc").eq("id", m.articol_id).single();
    if (errArt) throw errArt;
    const { error: errRest } = await supabase
      .from("articole_pangar")
      .update({ stoc: Number(art.stoc) + Number(m.cantitate) })
      .eq("id", m.articol_id);
    if (errRest) throw errRest;
  }

  const consumuriTotale = [];
  for (const linie of linii) {
    const { data: coduri, error } = await supabase
      .from("articole_pangar")
      .select("*")
      .eq("parohie_id", parohieId)
      .eq("baza_cod", linie.bazaCod)
      .gt("stoc", 0)
      .order("seq");
    if (error) throw error;

    let ramas = linie.cantitateTotala;
    for (const cod of coduri || []) {
      if (ramas <= 0) break;
      const cantDinCod = Math.min(Number(cod.stoc), ramas);
      ramas -= cantDinCod;
      consumuriTotale.push({ articol: cod, cantitate: cantDinCod });
    }
    if (ramas > 0) {
      throw new Error(`Stoc insuficient pentru ${linie.bazaCod} (verificat direct în Supabase, după restituirea stocului vechi).`);
    }
  }

  const { error: errDelM } = await supabase.from("miscari_stoc_pangar").delete().eq("document_id", documentId).eq("tip", "iesire");
  if (errDelM) throw errDelM;
  const { error: errDelL } = await supabase.from("linii_document").delete().eq("document_id", documentId);
  if (errDelL) throw errDelL;

  const miscariNoi = [];
  const liniiNoi = [];
  for (const c of consumuriTotale) {
    const { error: errUpdStoc } = await supabase
      .from("articole_pangar")
      .update({ stoc: Number(c.articol.stoc) - c.cantitate })
      .eq("id", c.articol.id);
    if (errUpdStoc) throw errUpdStoc;

    const valoareTotala = c.cantitate * Number(c.articol.pret_vanzare);
    const { data: miscareInserata, error: errIns } = await supabase
      .from("miscari_stoc_pangar")
      .insert({
        parohie_id: c.articol.parohie_id, articol_id: c.articol.id, tip: "iesire", data, cantitate: c.cantitate,
        valoare_unitara: c.articol.pret_vanzare, valoare_totala: valoareTotala, document_id: documentId,
      })
      .select()
      .single();
    if (errIns) throw errIns;

    const cat = categoriiPangar[c.articol.categorie_bvc];
    const cost = c.cantitate * Number(c.articol.pret_achizitie);
    const propriu = valoareTotala - cost;
    liniiNoi.push({ document_id: documentId, cont_id: cat.venitTranzitoriu, suma: cost, explicatie: `Vânzare pangar — ${c.articol.cod} — ${fmtCantitate(c.cantitate)} ${c.articol.um}`, mod_plata: modPlata });
    liniiNoi.push({ document_id: documentId, cont_id: cat.venitPropriu, suma: propriu, explicatie: `Vânzare pangar — ${c.articol.cod} — ${fmtCantitate(c.cantitate)} ${c.articol.um} (marjă)`, mod_plata: modPlata });

    miscariNoi.push({
      id: miscareInserata.id, data, tip: "iesire", articolId: c.articol.id, cantitate: c.cantitate,
      valoareUnitara: Number(c.articol.pret_vanzare), valoareTotala, documentId,
    });
  }

  const { data: liniiInserate, error: errInsL } = await supabase.from("linii_document").insert(liniiNoi).select();
  if (errInsL) throw errInsL;

  const { error: errUpdMeta } = await supabase
    .from("documente")
    .update({ tert, mod_plata: modPlata, serie: serie || null, numar_identificare: numarIdentificare || null })
    .eq("id", documentId);
  if (errUpdMeta) throw errUpdMeta;

  // Data + nr + resincronizare cronologică — TOATE într-un singur apel RPC, atomic, pentru
  // aceleași motive ca la actualizeazaDocument (evită conflictul cu constrângerea unică atunci
  // când nr-ul introdus manual e deja ocupat de alt document).
  const { data: rezultatResort, error: errResort } = await supabase.rpc("actualizeaza_data_nr_document", {
    p_document_id: documentId,
    p_data_noua: data,
    p_nr_nou: nr !== undefined && nr !== null && nr !== "" ? Number(nr) : null,
  });
  if (errResort) throw errResort;
  const renumerotari = (rezultatResort || []).map((r) => ({ documentId: r.document_id, nrNou: r.nr_nou }));

  const { data: docFinal, error: errFinalDoc } = await supabase.from("documente").select("nr, an").eq("id", documentId).single();
  if (errFinalDoc) throw errFinalDoc;

  const operatiuniNoi = liniiInserate.map((l) => ({
    id: l.id, tip: "incasare", contId: l.cont_id, data, suma: Number(l.suma), modPlata: l.mod_plata,
    tert, explicatie: l.explicatie || "", nr: docFinal.nr, an: docFinal.an, documentId,
  }));

  // Stocul final real, pentru toate codurile atinse (fie prin restituire, fie prin noul consum).
  const idsAtinse = [...new Set([...miscariVechi.map((m) => m.articol_id), ...consumuriTotale.map((c) => c.articol.id)])];
  const { data: articoleFinale, error: errFinale } = await supabase.from("articole_pangar").select("id, stoc").in("id", idsAtinse);
  if (errFinale) throw errFinale;

  return {
    articolePatch: articoleFinale.map((a) => ({ id: a.id, stocNou: Number(a.stoc) })),
    miscariNoi,
    operatiuniNoi,
    nrChitanta: docFinal.nr,
    anChitanta: docFinal.an,
    renumerotari,
  };
}

// Șterge definitiv o vânzare pangar (chitanța + toate liniile ei bugetare + mișcările de stoc
// asociate) — restituie mai întâi cantitatea consumată la FIFO înapoi în stoc, pentru fiecare
// cod atins (o vânzare poate fi acoperit de mai multe coduri, dacă FIFO a trecut prin ele).
export async function stergeVanzarePangar(documentId) {
  const { data: miscariVechi, error: errMV } = await supabase
    .from("miscari_stoc_pangar")
    .select("*")
    .eq("document_id", documentId)
    .eq("tip", "iesire");
  if (errMV) throw errMV;
  if (!miscariVechi || miscariVechi.length === 0) throw new Error("Nu s-au găsit mișcări de stoc pentru această vânzare.");

  for (const m of miscariVechi) {
    const { data: art, error: errArt } = await supabase.from("articole_pangar").select("stoc").eq("id", m.articol_id).single();
    if (errArt) throw errArt;
    const { error: errRest } = await supabase
      .from("articole_pangar")
      .update({ stoc: Number(art.stoc) + Number(m.cantitate) })
      .eq("id", m.articol_id);
    if (errRest) throw errRest;
  }

  const idsAtinse = miscariVechi.map((m) => m.articol_id);

  const { error: errDelM } = await supabase.from("miscari_stoc_pangar").delete().eq("document_id", documentId).eq("tip", "iesire");
  if (errDelM) throw errDelM;

  await stergeDocument(documentId);

  const { data: articoleFinale, error: errFinale } = await supabase.from("articole_pangar").select("id, stoc").in("id", idsAtinse);
  if (errFinale) throw errFinale;

  return { articolePatch: articoleFinale.map((a) => ({ id: a.id, stocNou: Number(a.stoc) })) };
}

// Datoriile către furnizori NU au un tabel propriu — un NRCD cu status='neachitata' ESTE
// datoria. Suma datorată (la preț de achiziție) nu e stocată direct pe document; se recalculează
// din mișcarea de stoc legată (cantitate) și articolul respectiv (preț de achiziție).
// Datoriile către furnizori NU au un tabel propriu — un NRCD cu status='neachitata' ESTE
// datoria. Suma datorată nu e stocată direct pe document; se recalculează din TOATE mișcările
// de stoc legate (o recepție poate avea mai multe produse, deci mai multe mișcări per NRCD).
export async function getDatoriiFurnizori(parohieId) {
  const { data: docs, error } = await supabase
    .from("documente")
    .select("*")
    .eq("parohie_id", parohieId)
    .eq("tip", "nrcd")
    .eq("status", "neachitata");
  if (error) throw error;
  if (!docs || docs.length === 0) return [];

  const docIds = docs.map((d) => d.id);
  const miscari = await inLoturi((lot) => supabase.from("miscari_stoc_pangar").select("*").in("document_id", lot), docIds);

  const articolIds = [...new Set((miscari || []).map((m) => m.articol_id))];
  let articoleById = {};
  if (articolIds.length > 0) {
    const articole = await inLoturi((lot) => supabase.from("articole_pangar").select("id, pret_achizitie, categorie_bvc").in("id", lot), articolIds);
    articoleById = Object.fromEntries((articole || []).map((a) => [a.id, a]));
  }

  // Plăți parțiale existente — Ordine de plată deja emise, legate de aceste NRCD-uri prin
  // document_sursa_id. Un NRCD poate avea acum 0, 1 sau mai multe OP-uri legate (câte unul per
  // tranșă achitată); suma încă neachitată = valoarea totală a facturii minus totalul lor.
  const platiDocs = await inLoturi(
    (lot) => supabase.from("documente").select("id, nr, an, data, document_sursa_id").eq("tip", "ordin_plata").in("document_sursa_id", lot),
    docIds
  );

  let liniiPlatiById = {};
  if (platiDocs && platiDocs.length > 0) {
    const platiIds = platiDocs.map((p) => p.id);
    const liniiPlati = await inLoturi(
      (lot) => supabase.from("linii_document").select("document_id, cont_id, suma, mod_plata").in("document_id", lot),
      platiIds
    );
    for (const l of liniiPlati || []) {
      (liniiPlatiById[l.document_id] ||= []).push(l);
    }
  }

  const platiPeNrcd = {};
  for (const p of platiDocs || []) {
    const linii = liniiPlatiById[p.id] || [];
    const sumaOP = linii.reduce((s, l) => s + Number(l.suma), 0);
    // Grupat pe mod de plată — o achitare poate fi mixtă (parte din casă, parte din bancă),
    // caz în care liniile de sub același Ordin de plată au mod_plata diferit.
    const sumePeMod = {};
    for (const l of linii) sumePeMod[l.mod_plata] = (sumePeMod[l.mod_plata] || 0) + Number(l.suma);
    const plata = {
      documentId: p.id,
      nr: p.nr,
      an: p.an,
      data: p.data,
      moduri: Object.entries(sumePeMod).map(([modPlata, suma]) => ({ modPlata, suma })),
      suma: sumaOP,
      liniiPeCont: linii.map((l) => ({ contId: l.cont_id, suma: Number(l.suma) })),
    };
    (platiPeNrcd[p.document_sursa_id] ||= []).push(plata);
  }

  return docs.map((d) => {
    const miscariDoc = (miscari || []).filter((m) => m.document_id === d.id);
    let suma = 0;
    const sumePeCategorie = {};
    for (const m of miscariDoc) {
      const articol = articoleById[m.articol_id];
      if (!articol) continue;
      const valoare = Number(m.cantitate) * Number(articol.pret_achizitie);
      suma += valoare;
      sumePeCategorie[articol.categorie_bvc] = (sumePeCategorie[articol.categorie_bvc] || 0) + valoare;
    }
    const platiExistente = platiPeNrcd[d.id] || [];
    const sumaAchitata = platiExistente.reduce((s, p) => s + p.suma, 0);
    const sumaRamasa = Math.round((suma - sumaAchitata) * 100) / 100;
    return {
      id: d.id,
      documentId: d.id,
      furnizor: d.furnizor,
      suma,
      sumaAchitata,
      sumaRamasa,
      platiExistente,
      liniiAchizitie: Object.entries(sumePeCategorie).map(([categorieBVC, suma]) => ({ categorieBVC, suma })),
      nrFactura: d.nr_factura,
      nrNRCD: d.nr,
      anNRCD: d.an,
      dataFactura: d.data,
      dataScadenta: d.data_scadenta,
      status: d.status,
    };
  });
}

// Marchează un NRCD ca achitat — o dată ce e plătit, iese automat din lista de datorii
// (getDatoriiFurnizori filtrează după status='neachitata').
export async function marcheazaNRCDAchitat(documentId) {
  const { error } = await supabase.from("documente").update({ status: "achitata" }).eq("id", documentId);
  if (error) throw error;
}

// Factură furnizor GENERALĂ (fără legătură cu Pangar) — analog cu receptioneazaPangar, dar fără
// nicio mișcare de stoc/articole: utilizatorul alege direct articolul bugetar pe fiecare linie
// (ca la un Ordin de plată obișnuit), nu o categorie Pangar care se rezolvă mai târziu la un cont
// de achiziție. Devine o datorie neachitată dacă nu se plătește pe loc — vizibilă separat, prin
// getDatoriiFurnizoriGenerale (mai jos), NU prin getDatoriiFurnizori (care rămâne strict Pangar/NRCD).
// `linii` = [{ contId, suma, explicatie? }, ...].
export async function creeazaFacturaFurnizor(parohieId, { linii, data, furnizor, nrFactura, plataAcum, modPlata, dataScadenta }) {
  const sumaTotala = linii.reduce((s, l) => s + Number(l.suma), 0);

  const rezultatFactura = await salveazaDocument(parohieId, {
    tip: "facturaFurnizor",
    data,
    furnizor,
    nrFactura,
    dataScadenta: plataAcum ? null : dataScadenta,
    status: plataAcum ? "achitata" : "neachitata",
    linii: linii.map((l) => ({ contId: l.contId, suma: l.suma, explicatie: l.explicatie || null })),
  });
  const facturaDocId = rezultatFactura.documentId;

  let operatiuniPlata = [];
  let nrOP = null;
  let renumerotariPlata = [];
  if (plataAcum) {
    const liniiPlata = linii.map((l) => ({
      contId: l.contId,
      suma: l.suma,
      modPlata,
      explicatie: `Plată factură ${nrFactura} (Factură furnizor nr. ${rezultatFactura.nr}/${rezultatFactura.an})`,
    }));
    const rezultatPlata = await salveazaDocument(parohieId, {
      tip: "plata", data, tert: furnizor, documentSursaId: facturaDocId, linii: liniiPlata,
    });
    operatiuniPlata = rezultatPlata.operatiuniNoi;
    nrOP = rezultatPlata.nr;
    renumerotariPlata = rezultatPlata.renumerotari || [];
  }

  return {
    nrFacturaFurnizor: rezultatFactura.nr,
    anFacturaFurnizor: rezultatFactura.an,
    operatiuniPlata,
    nrOP,
    renumerotari: [...(rezultatFactura.renumerotari || []), ...renumerotariPlata],
    datorieNoua: !plataAcum
      ? {
          tipDatorie: "generala",
          furnizor,
          suma: sumaTotala,
          nrFactura,
          nrFacturaFurnizor: rezultatFactura.nr,
          anFacturaFurnizor: rezultatFactura.an,
          documentId: facturaDocId,
          dataFactura: data,
          dataScadenta,
          status: "neachitata",
          sumaAchitata: 0,
          sumaRamasa: sumaTotala,
          platiExistente: [],
          liniiAchizitie: linii.map((l) => ({ contId: l.contId, suma: Number(l.suma) })),
        }
      : null,
  };
}

// Toate facturile generale de furnizor încă neachitate — analog cu getDatoriiFurnizori, dar citind
// direct din linii_document (contId + sumă), fără niciun join către stoc/articole_pangar, fiindcă
// o factură generală n-are nicio mișcare de stoc asociată.
export async function getDatoriiFurnizoriGenerale(parohieId) {
  const { data: docs, error } = await supabase
    .from("documente")
    .select("*")
    .eq("parohie_id", parohieId)
    .eq("tip", "factura_furnizor")
    .eq("status", "neachitata");
  if (error) throw error;
  if (!docs || docs.length === 0) return [];

  const docIds = docs.map((d) => d.id);
  const linii = await inLoturi((lot) => supabase.from("linii_document").select("*").in("document_id", lot), docIds);

  // Plăți parțiale existente — Ordine de plată deja emise, legate de aceste facturi prin
  // document_sursa_id. Identic ca mecanism cu getDatoriiFurnizori (vezi comentariul de-acolo).
  const platiDocs = await inLoturi(
    (lot) => supabase.from("documente").select("id, nr, an, data, document_sursa_id").eq("tip", "ordin_plata").in("document_sursa_id", lot),
    docIds
  );

  let liniiPlatiById = {};
  if (platiDocs && platiDocs.length > 0) {
    const platiIds = platiDocs.map((p) => p.id);
    const liniiPlati = await inLoturi(
      (lot) => supabase.from("linii_document").select("document_id, cont_id, suma, mod_plata").in("document_id", lot),
      platiIds
    );
    for (const l of liniiPlati || []) {
      (liniiPlatiById[l.document_id] ||= []).push(l);
    }
  }

  const platiPeFactura = {};
  for (const p of platiDocs || []) {
    const liniiP = liniiPlatiById[p.id] || [];
    const sumaOP = liniiP.reduce((s, l) => s + Number(l.suma), 0);
    const sumePeMod = {};
    for (const l of liniiP) sumePeMod[l.mod_plata] = (sumePeMod[l.mod_plata] || 0) + Number(l.suma);
    const plata = {
      documentId: p.id,
      nr: p.nr,
      an: p.an,
      data: p.data,
      moduri: Object.entries(sumePeMod).map(([modPlata, suma]) => ({ modPlata, suma })),
      suma: sumaOP,
      liniiPeCont: liniiP.map((l) => ({ contId: l.cont_id, suma: Number(l.suma) })),
    };
    (platiPeFactura[p.document_sursa_id] ||= []).push(plata);
  }

  return docs.map((d) => {
    const liniiDoc = (linii || []).filter((l) => l.document_id === d.id);
    const suma = liniiDoc.reduce((s, l) => s + Number(l.suma), 0);
    const platiExistente = platiPeFactura[d.id] || [];
    const sumaAchitata = platiExistente.reduce((s, p) => s + p.suma, 0);
    const sumaRamasa = Math.round((suma - sumaAchitata) * 100) / 100;
    return {
      tipDatorie: "generala",
      id: d.id,
      documentId: d.id,
      furnizor: d.furnizor,
      suma,
      sumaAchitata,
      sumaRamasa,
      platiExistente,
      liniiAchizitie: liniiDoc.map((l) => ({ contId: l.cont_id, suma: Number(l.suma) })),
      nrFactura: d.nr_factura,
      nrFacturaFurnizor: d.nr,
      anFacturaFurnizor: d.an,
      dataFactura: d.data,
      dataScadenta: d.data_scadenta,
      status: d.status,
    };
  });
}

// Comisioane bancare — vezi comisioane_bancare_pending. Un comision se înregistrează individual,
// în momentul plății care l-a generat, dar NU intră în acel Ordin de plată — rămâne separat,
// "neconsolidat", până la finalul lunii, când toate comisioanele lunii sunt adunate într-un singur
// document nou (vezi consolideazaComisioaneLuna), cu câte o linie proprie pentru fiecare.
export async function adaugaComisionBancarPending(parohieId, { data, suma, tert, documentIdOrigine }) {
  const an = Number(data.slice(0, 4));
  const luna = Number(data.slice(5, 7));
  const { data: rand, error } = await supabase
    .from("comisioane_bancare_pending")
    .insert({
      parohie_id: parohieId,
      data,
      suma,
      tert: tert || null,
      document_id_origine: documentIdOrigine || null,
      an,
      luna,
    })
    .select()
    .single();
  if (error) throw error;
  return { id: rand.id, data: rand.data, suma: Number(rand.suma), tert: rand.tert, documentIdOrigine: rand.document_id_origine, an: rand.an, luna: rand.luna };
}

// Toate comisioanele încă neconsolidate ale parohiei — indiferent din ce lună/an — citite o
// singură dată, la încărcarea aplicației, ca să se poată decide ce luni sunt gata de consolidat
// (vezi consolideazaComisioaneLuna, apelată din ParohieERP.jsx pentru fiecare lună deja încheiată).
export async function getComisioaneBancareNeconsolidate(parohieId) {
  const { data, error } = await supabase
    .from("comisioane_bancare_pending")
    .select("*")
    .eq("parohie_id", parohieId)
    .eq("consolidat", false)
    .order("data", { ascending: true });
  if (error) throw error;
  return (data || []).map((c) => ({
    id: c.id,
    data: c.data,
    suma: Number(c.suma),
    tert: c.tert,
    documentIdOrigine: c.document_id_origine,
    an: c.an,
    luna: c.luna,
  }));
}

// Consolidează TOATE comisioanele neconsolidate ale unei singure luni (an, luna) într-un singur
// Ordin de plată nou, datat în ultima zi calendaristică a acelei luni, cu câte o linie separată
// pentru fiecare comision — exact numărul de linii cât comisioane au fost înregistrate în luna
// respectivă, ca să corespundă 1-la-1 cu extrasul de cont bancar. Marchează apoi comisioanele
// incluse drept consolidate, legate de noul document. Nu creează nimic dacă nu există comisioane
// neconsolidate pentru luna cerută (apelantul verifică asta înainte, dar funcția e sigură oricum).
export async function consolideazaComisioaneLuna(parohieId, an, luna, tertBanca) {
  const { data: comisioane, error: errC } = await supabase
    .from("comisioane_bancare_pending")
    .select("*")
    .eq("parohie_id", parohieId)
    .eq("consolidat", false)
    .eq("an", an)
    .eq("luna", luna)
    .order("data", { ascending: true });
  if (errC) throw errC;
  if (!comisioane || comisioane.length === 0) return null;

  const linii = comisioane.map((c) => ({
    contId: "627",
    suma: Number(c.suma),
    modPlata: "transfer",
    explicatie: `Comision bancar — plată din ${c.data}${c.tert ? ` către ${c.tert}` : ""}`,
  }));

  // Luna asta poate fi fost DEJA consolidată o dată — un comision poate ajunge în coadă ulterior
  // (ex. debitat de bancă cu câteva zile întârziere față de tranzacția care l-a generat, deja
  // după ce restul lunii a fost consolidat la o pornire anterioară a aplicației). Dacă există deja
  // un document pentru (an, lună), adăugăm linia nouă ACOLO, nu creăm un al doilea Ordin de plată
  // separat pentru aceeași lună — exact bug-ul găsit direct în date (iunie și septembrie 2025
  // aveau, fiecare, două OP-uri distincte pentru comisioanele aceleiași luni).
  const { data: existent, error: errExistent } = await supabase
    .from("comisioane_bancare_pending")
    .select("document_id_consolidare")
    .eq("parohie_id", parohieId)
    .eq("an", an)
    .eq("luna", luna)
    .eq("consolidat", true)
    .not("document_id_consolidare", "is", null)
    .limit(1)
    .maybeSingle();
  if (errExistent) throw errExistent;

  let rezultat;
  if (existent?.document_id_consolidare) {
    const { data: docExistent, error: errDoc } = await supabase
      .from("documente")
      .select("id, nr, an, data, tert")
      .eq("id", existent.document_id_consolidare)
      .single();
    if (errDoc) throw errDoc;

    const { liniiNoiInserate } = await actualizeazaDocument(
      docExistent.id,
      { data: docExistent.data, tert: docExistent.tert, nr: docExistent.nr },
      linii
    );
    const operatiuniNoi = linii.map((l, i) => ({
      id: liniiNoiInserate[i]?.id,
      tip: "plata",
      contId: l.contId,
      data: docExistent.data,
      suma: l.suma,
      modPlata: l.modPlata,
      tert: docExistent.tert,
      explicatie: l.explicatie,
      nr: docExistent.nr,
      an: docExistent.an,
      ajustare106: false,
      esteExcedentReportat: false,
      documentId: docExistent.id,
      serie: null,
      numarIdentificare: null,
    }));
    rezultat = { operatiuniNoi, nr: docExistent.nr, an: docExistent.an, documentId: docExistent.id, renumerotari: [] };
  } else {
    const ultimaZi = ultimaZiCalendaristica(an, luna);
    rezultat = await salveazaDocument(parohieId, {
      tip: "plata",
      data: ultimaZi,
      tert: tertBanca || "Bancă",
      modPlata: "transfer",
      linii,
    });
  }

  const { error: errUpd } = await supabase
    .from("comisioane_bancare_pending")
    .update({ consolidat: true, document_id_consolidare: rezultat.documentId })
    .in("id", comisioane.map((c) => c.id));
  if (errUpd) throw errUpd;

  return rezultat;
}

// Șterge un document (Chitanță/Ordin de plată) și liniile lui — apelantul e responsabil să
// verifice ÎNAINTE că documentul e eligibil pentru ștergere (nu e excedent reportat, nu e legat
// de stocuri Pangar, nu e virament intern 581); funcția aceasta doar execută ștergerea propriu-zisă.
export async function stergeDocument(documentId) {
  const { data: doc, error: errGet } = await supabase
    .from("documente")
    .select("id, parohie_id, tip, an, nr")
    .eq("id", documentId)
    .single();
  if (errGet) throw errGet;

  const { error: errLinii } = await supabase.from("linii_document").delete().eq("document_id", documentId);
  if (errLinii) throw errLinii;
  const { error: errDoc } = await supabase.from("documente").delete().eq("id", documentId);
  if (errDoc) throw errDoc;

  // Renumerotare: toate documentele de același tip/an, cu numărul mai mare decât cel șters,
  // coboară cu 1 — ca să nu rămână goluri în secvență după ștergere.
  const { data: afectate, error: errSel } = await supabase
    .from("documente")
    .select("id, nr")
    .eq("parohie_id", doc.parohie_id)
    .eq("tip", doc.tip)
    .eq("an", doc.an)
    .gt("nr", doc.nr)
    .order("nr", { ascending: true });
  if (errSel) throw errSel;

  const renumerotari = [];
  for (const d of afectate || []) {
    const nrNou = d.nr - 1;
    const { error: errUpd } = await supabase.from("documente").update({ nr: nrNou }).eq("id", d.id);
    if (errUpd) throw errUpd;
    renumerotari.push({ documentId: d.id, nrNou });
  }

  // Resincronizare contor pe MAX(nr) rămas — ca următorul document emis manual să continue corect.
  const { data: maxRow } = await supabase
    .from("documente")
    .select("nr")
    .eq("parohie_id", doc.parohie_id)
    .eq("tip", doc.tip)
    .eq("an", doc.an)
    .order("nr", { ascending: false })
    .limit(1)
    .maybeSingle();
  const maxNr = maxRow?.nr || 0;
  const tipLocal = doc.tip === "chitanta" ? "incasare" : doc.tip === "ordin_plata" ? "plata" : doc.tip;
  await supabase
    .from("contoare")
    .update({ ultimul_numar: maxNr })
    .eq("parohie_id", doc.parohie_id)
    .eq("an", doc.an)
    .eq("tip", tipLocal);

  return { renumerotari };
}

/* --------------------------------- Parteneri --------------------------------- */

// Aduce lista de parteneri (donatori, beneficiari, furnizori — o singură bază comună) a parohiei.
export async function getParteneri(parohieId) {
  const { data, error } = await supabase.from("parteneri").select("*").eq("parohie_id", parohieId).order("denumire");
  if (error) throw error;
  return (data || []).map((p) => ({
    id: p.id, denumire: p.denumire, cuiCif: p.cui_cif, adresa: p.adresa, iban: p.iban,
    email: p.email, telefon: p.telefon, reprezentantLegal: p.reprezentant_legal, functie: p.functie,
  }));
}

// Creează un partener nou — doar denumirea e obligatorie; restul câmpurilor pot rămâne goale
// (null) și se completează ulterior, din nomenclatorul de Parteneri (editeazaPartener, mai jos).
export async function creeazaPartener(parohieId, { denumire, cuiCif, adresa, iban, email, telefon, reprezentantLegal, functie }) {
  const { data, error } = await supabase
    .from("parteneri")
    .insert({
      parohie_id: parohieId, denumire, cui_cif: cuiCif, adresa, iban, email, telefon,
      reprezentant_legal: reprezentantLegal, functie,
    })
    .select()
    .single();
  if (error) throw error;
  return {
    id: data.id, denumire: data.denumire, cuiCif: data.cui_cif, adresa: data.adresa, iban: data.iban,
    email: data.email, telefon: data.telefon, reprezentantLegal: data.reprezentant_legal, functie: data.functie,
  };
}

// Editează un partener existent — parteneriId identifică rândul; câmpurile nefurnizate rămân
// neschimbate (nu se pierde nimic dacă formularul trimite doar un subset). Documentele deja emise
// (chitanțe, OP-uri) rețin denumirea partenerului ca text simplu, la momentul emiterii — NU o
// referință vie către acest rând — deci editarea unui partener nu modifică retroactiv nimic din
// istoricul deja emis, doar sugestiile viitoare de completare automată.
export async function editeazaPartener(parteneriId, { denumire, cuiCif, adresa, iban, email, telefon, reprezentantLegal, functie }) {
  const { data, error } = await supabase
    .from("parteneri")
    .update({
      denumire, cui_cif: cuiCif, adresa, iban, email, telefon,
      reprezentant_legal: reprezentantLegal, functie,
    })
    .eq("id", parteneriId)
    .select()
    .single();
  if (error) throw error;
  return {
    id: data.id, denumire: data.denumire, cuiCif: data.cui_cif, adresa: data.adresa, iban: data.iban,
    email: data.email, telefon: data.telefon, reprezentantLegal: data.reprezentant_legal, functie: data.functie,
  };
}

// Șterge un partener din nomenclator — sigur de făcut oricând, fiindcă documentele deja emise nu
// au o legătură (foreign key) către acest rând, ci păstrează denumirea ca text simplu (vezi
// comentariul de la editeazaPartener). Ștergerea afectează doar sugestiile viitoare de
// completare automată, nu istoricul.
export async function stergePartener(parteneriId) {
  const { error } = await supabase.from("parteneri").delete().eq("id", parteneriId);
  if (error) throw error;
}

// Migrare unică: dacă parohia nu are încă niciun produs în Supabase, transferă nomenclatorul
// local existent (cel din demo/seed, cu id-uri locale de tipul "a2") — fiecare produs primește
// un UUID real, ca operațiunile ulterioare (recepție, vânzare) să poată scrie corect în Supabase.
// Dacă parohia are deja produse acolo, nu face nimic (nu suprascrie, nu duplică).
// Reconciliere nomenclator: orice produs local (identificat după `cod`, unic și imutabil) care
// nu există încă în Supabase se adaugă acolo — la FIECARE încărcare, nu doar o singură dată.
// Înlocuiește vechea variantă "doar dacă Supabase are zero produse", care avea o gaură reală:
// dacă un singur produs ajungea în Supabase (ex. creat manual prin aplicație) înainte ca restul
// nomenclatorului local să fi fost migrat, acel rest rămânea definitiv nemigrat și dispărea la
// următoarea încărcare (state.articole fiind înlocuit integral cu ce găsea în Supabase).
export async function reconciliazaNomenclatorPangar(parohieId, articoleLocale) {
  if (!articoleLocale || articoleLocale.length === 0) return [];

  const { data: existente, error } = await supabase.from("articole_pangar").select("cod").eq("parohie_id", parohieId);
  if (error) throw error;
  const coduriExistente = new Set((existente || []).map((a) => a.cod));

  const lipsa = articoleLocale.filter((a) => !coduriExistente.has(a.cod));
  if (lipsa.length === 0) return [];

  const { data, error: errInsert } = await supabase
    .from("articole_pangar")
    .insert(
      lipsa.map((a) => ({
        parohie_id: parohieId, seq: a.seq, baza_cod: a.bazaCod, denumire: a.denumire, um: a.um,
        pret_achizitie: a.pretAchizitie, pret_vanzare: a.pretVanzare, cod: a.cod, categorie_bvc: a.categorieBVC,
        stoc: a.stoc, stoc_referinta: a.stocReferinta, locked: a.locked,
      }))
    )
    .select();
  if (errInsert) throw errInsert;

  return data.map((a) => ({
    id: a.id, seq: a.seq, bazaCod: a.baza_cod, denumire: a.denumire, um: a.um,
    pretAchizitie: Number(a.pret_achizitie), pretVanzare: Number(a.pret_vanzare), cod: a.cod,
    categorieBVC: a.categorie_bvc, stoc: Number(a.stoc), stocReferinta: Number(a.stoc_referinta), locked: a.locked,
    imagineUrl: a.imagine_url || null,
  }));
}

/* --------------------------------- Cimitir --------------------------------- */

export async function getLocuriInhumare(parohieId) {
  const { data, error } = await supabase.from("locuri_inhumare").select("*").eq("parohie_id", parohieId).order("cod_parcela");
  if (error) throw error;
  return (data || []).map((l) => ({ id: l.id, codParcela: l.cod_parcela, stare: l.stare }));
}

export async function creeazaLocInhumare(parohieId, { codParcela }) {
  const { data, error } = await supabase
    .from("locuri_inhumare")
    .insert({ parohie_id: parohieId, cod_parcela: codParcela, stare: "disponibil" })
    .select()
    .single();
  if (error) throw error;
  return { id: data.id, codParcela: data.cod_parcela, stare: data.stare };
}

// Aduce toate concesiunile, cu istoricul evenimentelor (inițial/reînnoire/transfer) legat.
export async function getConcesiuni(parohieId) {
  const { data: concesiuni, error } = await supabase.from("concesiuni").select("*").eq("parohie_id", parohieId);
  if (error) throw error;
  if (!concesiuni || concesiuni.length === 0) return [];

  const ids = concesiuni.map((c) => c.id);
  const { data: istoric, error: errIst } = await supabase
    .from("concesiuni_istoric")
    .select("*")
    .in("concesiune_id", ids)
    .order("data");
  if (errIst) throw errIst;

  return concesiuni.map((c) => ({
    id: c.id,
    locId: c.loc_id,
    concesionar: c.concesionar,
    tipDurata: c.tip_durata,
    tarif: Number(c.tarif),
    dataInceput: c.data_inceput,
    dataExpirare: c.data_expirare,
    expirataDefinitiv: !!c.expirata_definitiv,
    istoric: (istoric || [])
      .filter((i) => i.concesiune_id === c.id)
      .map((i) => ({ data: i.data, tip: i.tip, concesionar: i.concesionar, documentId: i.document_id })),
  }));
}

// Creează o concesiune nouă: emite chitanța (atomic, printr-o singură tranzacție SQL), marchează
// locul ca "concesionat", și înregistrează evenimentul inițial în istoric.
export async function creeazaConcesiune(parohieId, { locId, concesionar, tipDurata, tarif, dataInceput, dataExpirare, modPlata, codLoc }) {
  const rezultatDoc = await salveazaDocument(parohieId, {
    tip: "incasare", data: dataInceput, tert: concesionar, modPlata,
    linii: [{ contId: "731.01.06", suma: tarif, explicatie: `Concesiune nouă — loc ${codLoc}`, modPlata }],
  });

  const { data: concesiune, error: errC } = await supabase
    .from("concesiuni")
    .insert({
      parohie_id: parohieId, loc_id: locId, concesionar, tip_durata: tipDurata, tarif,
      data_inceput: dataInceput, data_expirare: dataExpirare, expirata_definitiv: false,
    })
    .select()
    .single();
  if (errC) throw errC;

  const { error: errIst } = await supabase
    .from("concesiuni_istoric")
    .insert({ concesiune_id: concesiune.id, tip: "initiala", data: dataInceput, concesionar, document_id: rezultatDoc.documentId });
  if (errIst) throw errIst;

  const { error: errLoc } = await supabase.from("locuri_inhumare").update({ stare: "concesionat" }).eq("id", locId);
  if (errLoc) throw errLoc;

  return {
    concesiune: {
      id: concesiune.id, locId, concesionar, tipDurata, tarif, dataInceput, dataExpirare, expirataDefinitiv: false,
      istoric: [{ data: dataInceput, tip: "initiala", concesionar, documentId: rezultatDoc.documentId }],
    },
    operatiuniNoi: rezultatDoc.operatiuniNoi,
    nr: rezultatDoc.nr,
    an: rezultatDoc.an,
    renumerotari: rezultatDoc.renumerotari || [],
  };
}

export async function getPersoaneInhumate(parohieId) {
  const { data, error } = await supabase.from("persoane_inhumate").select("*").eq("parohie_id", parohieId);
  if (error) throw error;
  return (data || []).map((p) => ({
    id: p.id, locId: p.loc_id, nume: p.nume,
    dataNasterii: p.data_nasterii, dataDeces: p.data_decesului, dataInhumare: p.data_inhumarii,
  }));
}

export async function creeazaPersoanaInhumata(parohieId, { locId, nume, dataNasterii, dataDeces, dataInhumare }) {
  const { data, error } = await supabase
    .from("persoane_inhumate")
    .insert({ parohie_id: parohieId, loc_id: locId, nume, data_nasterii: dataNasterii, data_decesului: dataDeces, data_inhumarii: dataInhumare })
    .select()
    .single();
  if (error) throw error;
  return {
    id: data.id, locId: data.loc_id, nume: data.nume,
    dataNasterii: data.data_nasterii, dataDeces: data.data_decesului, dataInhumare: data.data_inhumarii,
  };
}

// Reînnoire concesiune: emite chitanța (atomic), actualizează data de expirare + scoate flagul
// "expirată definitiv", și adaugă evenimentul de reînnoire în istoric.
export async function reinnoiesteConcesiune(parohieId, concesiuneId, { concesionar, tarif, dataInceputNoua, dataExpirareNoua, modPlata, codLoc }) {
  const rezultatDoc = await salveazaDocument(parohieId, {
    tip: "incasare", data: dataInceputNoua, tert: concesionar, modPlata,
    linii: [{ contId: "731.01.06", suma: tarif, explicatie: `Reînnoire concesiune — loc ${codLoc}`, modPlata }],
  });

  const { error: errUpd } = await supabase
    .from("concesiuni")
    .update({ data_expirare: dataExpirareNoua, expirata_definitiv: false })
    .eq("id", concesiuneId);
  if (errUpd) throw errUpd;

  const { error: errIst } = await supabase
    .from("concesiuni_istoric")
    .insert({ concesiune_id: concesiuneId, tip: "reinnoire", data: dataInceputNoua, concesionar, document_id: rezultatDoc.documentId });
  if (errIst) throw errIst;

  return {
    dataExpirare: dataExpirareNoua,
    evenimentNou: { data: dataInceputNoua, tip: "reinnoire", concesionar, documentId: rezultatDoc.documentId },
    operatiuniNoi: rezultatDoc.operatiuniNoi,
    renumerotari: rezultatDoc.renumerotari || [],
  };
}

// Editează ULTIMUL eveniment din istoricul unei concesiuni (inițial sau reînnoire) — corectează
// concesionar/tipDurată/tarif/dată, recalculează expirarea, și sincronizează chitanța legată
// (dacă evenimentul are un document_id), pe TOATE liniile ei (poate fi mai multe, deși pentru
// concesiune e de obicei una singură).
export async function editeazaConcesiuneApi(concesiuneId, { concesionar, tipDurata, tarif, dataInceput, dataExpirare, documentId, tipEveniment, codLoc, esteEvenimentInitial }) {
  const { error: errC } = await supabase
    .from("concesiuni")
    .update({
      concesionar, tip_durata: tipDurata, tarif, data_expirare: dataExpirare,
      ...(esteEvenimentInitial ? { data_inceput: dataInceput } : {}),
    })
    .eq("id", concesiuneId);
  if (errC) throw errC;

  const { error: errIst } = await supabase
    .from("concesiuni_istoric")
    .update({ data: dataInceput, concesionar })
    .eq("concesiune_id", concesiuneId)
    .eq("document_id", documentId);
  if (errIst) throw errIst;

  if (documentId) {
    const { error: errDoc } = await supabase.from("documente").update({ data: dataInceput, tert: concesionar }).eq("id", documentId);
    if (errDoc) throw errDoc;
    const { error: errLinii } = await supabase
      .from("linii_document")
      .update({ suma: tarif, explicatie: tipEveniment === "reinnoire" ? `Reînnoire concesiune — loc ${codLoc}` : `Concesiune nouă — loc ${codLoc}` })
      .eq("document_id", documentId);
    if (errLinii) throw errLinii;
  }

  return { dataExpirare };
}

// Transfer concesiune către un nou concesionar (succesor) — doar înregistrare de istoric, fără
// document financiar legat (nu generează încasare).
export async function transferaConcesiuneApi(concesiuneId, { concesionarNou, data }) {
  const { error: errC } = await supabase.from("concesiuni").update({ concesionar: concesionarNou }).eq("id", concesiuneId);
  if (errC) throw errC;
  const { error: errIst } = await supabase
    .from("concesiuni_istoric")
    .insert({ concesiune_id: concesiuneId, tip: "transfer", data, concesionar: concesionarNou, document_id: null });
  if (errIst) throw errIst;
  return { evenimentNou: { data, tip: "transfer", concesionar: concesionarNou, documentId: null } };
}

/* --------------------------------- Patrimoniu --------------------------------- */

export async function getBunuriPatrimoniu(parohieId) {
  const { data, error } = await supabase.from("bunuri_patrimoniu").select("*").eq("parohie_id", parohieId);
  if (error) throw error;
  return (data || []).map((b) => ({
    id: b.id, denumire: b.denumire, categorie: b.categorie, dataAchizitie: b.data_achizitie, sursa: b.sursa,
    valoare: Number(b.valoare), stare: b.stare, locatie: b.locatie, note: b.note, referintaFoto: b.referinta_foto,
    documentId: b.document_id, motivCasare: b.motiv_casare, aprobatDe: b.aprobat_de, dataCasare: b.data_casare,
  }));
}

// Creează un bun de patrimoniu nou — dacă sursa e "achizitie" cu valoare > 0, generează atomic
// și Ordinul de plată legat (contul 651), pe contul "document_id" al bunului.
export async function creeazaBunPatrimoniu(parohieId, { denumire, categorie, dataAchizitie, sursa, valoare, locatie, note, referintaFoto, modPlata }) {
  let documentId = null;
  let operatiuniNoi = [];
  let renumerotari = [];
  if (sursa === "achizitie" && valoare > 0) {
    const rezultatDoc = await salveazaDocument(parohieId, {
      tip: "plata", data: dataAchizitie, tert: "", modPlata,
      linii: [{ contId: "651", suma: valoare, explicatie: `Achiziție patrimoniu — ${denumire}`, modPlata }],
    });
    documentId = rezultatDoc.documentId;
    operatiuniNoi = rezultatDoc.operatiuniNoi;
    renumerotari = rezultatDoc.renumerotari || [];
  }

  const { data, error } = await supabase
    .from("bunuri_patrimoniu")
    .insert({
      parohie_id: parohieId, denumire, categorie, data_achizitie: dataAchizitie, sursa, valoare,
      stare: "nou", locatie, note, referinta_foto: referintaFoto, document_id: documentId,
    })
    .select()
    .single();
  if (error) throw error;

  return {
    bun: {
      id: data.id, denumire, categorie, dataAchizitie, sursa, valoare, stare: "nou", locatie, note,
      referintaFoto, documentId, motivCasare: null, aprobatDe: null, dataCasare: null,
    },
    operatiuniNoi,
    renumerotari,
  };
}

// Editează un bun de patrimoniu, sincronizând Ordinul de plată legat: îl actualizează dacă
// există deja, îl creează dacă sursa devine "achiziție", sau îl șterge dacă nu mai e cazul.
export async function editeazaBunPatrimoniu(bunId, { denumire, categorie, dataAchizitie, sursa, valoare, locatie, note, referintaFoto, modPlata, documentIdExistent }, parohieId) {
  let documentId = documentIdExistent;
  let operatiuniNoi = [];
  let renumerotari = [];

  if (sursa === "achizitie" && valoare > 0) {
    if (documentId) {
      const { error: errDoc } = await supabase.from("documente").update({ data: dataAchizitie }).eq("id", documentId);
      if (errDoc) throw errDoc;
      const { error: errLinii } = await supabase
        .from("linii_document")
        .update({ suma: valoare, explicatie: `Achiziție patrimoniu — ${denumire}`, mod_plata: modPlata })
        .eq("document_id", documentId);
      if (errLinii) throw errLinii;
    } else {
      const rezultatDoc = await salveazaDocument(parohieId, {
        tip: "plata", data: dataAchizitie, tert: "", modPlata,
        linii: [{ contId: "651", suma: valoare, explicatie: `Achiziție patrimoniu — ${denumire}`, modPlata }],
      });
      documentId = rezultatDoc.documentId;
      operatiuniNoi = rezultatDoc.operatiuniNoi;
      renumerotari = rezultatDoc.renumerotari || [];
    }
  } else if (documentId) {
    await stergeDocument(documentId);
    documentId = null;
  }

  const { error: errBun } = await supabase
    .from("bunuri_patrimoniu")
    .update({
      denumire, categorie, data_achizitie: dataAchizitie, sursa, valoare, locatie, note,
      referinta_foto: referintaFoto, document_id: documentId,
    })
    .eq("id", bunId);
  if (errBun) throw errBun;

  return { documentId, operatiuniNoi, renumerotari, documentSters: !documentId && !!documentIdExistent && documentIdExistent !== documentId };
}

export async function caseazaBunPatrimoniu(bunId, { motiv, aprobatDe }) {
  const { error } = await supabase
    .from("bunuri_patrimoniu")
    .update({ stare: "casat", motiv_casare: motiv, aprobat_de: aprobatDe || null, data_casare: todayISO() })
    .eq("id", bunId);
  if (error) throw error;
}

/* --------------------------------- Corespondență & Arhivă --------------------------------- */

export async function getCorespondenta(parohieId) {
  const { data, error } = await supabase.from("corespondenta").select("*").eq("parohie_id", parohieId);
  if (error) throw error;
  return (data || []).map((c) => ({
    id: c.id, tip: c.tip, nr: c.nr, an: c.an, data: c.data, partener: c.expeditor_destinatar,
    obiect: c.obiect, note: c.note, modPrimire: c.mod_primire, termenRaspuns: c.termen_raspuns,
    status: c.status, referintaIntrareId: c.referinta_intrare_id,
  }));
}

export async function creeazaCorespondentaIntrare(parohieId, { data, partener, obiect, modPrimire, termenRaspuns }) {
  const an = new Date(data).getFullYear();
  const nr = await rezervaUrmatorulNumar(parohieId, an, "corespIntrare");
  const { data: rand, error } = await supabase
    .from("corespondenta")
    .insert({
      parohie_id: parohieId, tip: "intrare", nr, an, data, expeditor_destinatar: partener, obiect,
      mod_primire: modPrimire, termen_raspuns: termenRaspuns, status: "in_lucru",
    })
    .select()
    .single();
  if (error) throw error;
  return { id: rand.id, tip: "intrare", nr, an, data, partener, obiect, modPrimire, termenRaspuns, status: "in_lucru", referintaIntrareId: null };
}

export async function creeazaCorespondentaIesire(parohieId, { data, partener, obiect, referintaIntrareId }) {
  const an = new Date(data).getFullYear();
  const nr = await rezervaUrmatorulNumar(parohieId, an, "corespIesire");
  const { data: rand, error } = await supabase
    .from("corespondenta")
    .insert({
      parohie_id: parohieId, tip: "iesire", nr, an, data, expeditor_destinatar: partener, obiect,
      referinta_intrare_id: referintaIntrareId || null,
    })
    .select()
    .single();
  if (error) throw error;
  return { id: rand.id, tip: "iesire", nr, an, data, partener, obiect, referintaIntrareId: referintaIntrareId || null };
}

export async function actualizeazaStatusCorespondenta(id, statusNou) {
  const { error } = await supabase.from("corespondenta").update({ status: statusNou }).eq("id", id);
  if (error) throw error;
}

export async function getArhiva(parohieId) {
  const { data, error } = await supabase.from("arhiva").select("*").eq("parohie_id", parohieId);
  if (error) throw error;
  return (data || []).map((a) => ({ id: a.id, denumire: a.denumire, categorie: a.categorie, an: a.an, notite: a.notite, dataAdaugare: a.data_adaugare }));
}

export async function creeazaDocumentArhiva(parohieId, { denumire, categorie, an, notite }) {
  const { data, error } = await supabase
    .from("arhiva")
    .insert({ parohie_id: parohieId, denumire, categorie, an, notite })
    .select()
    .single();
  if (error) throw error;
  return { id: data.id, denumire, categorie, an, notite, dataAdaugare: data.data_adaugare };
}

export async function getInventarieriPatrimoniu(parohieId) {
  const { data, error } = await supabase.from("inventarieri_patrimoniu").select("*").eq("parohie_id", parohieId);
  if (error) throw error;
  return (data || []).map((p) => ({ id: p.id, nrPV: p.nr_pv, an: p.an, data: p.data, membri: p.membri, observatii: p.observatii, bunuri: p.bunuri || [] }));
}

// Numărul de proces-verbal se rezervă atomic din Supabase, pe propria secvență ("procesVerbal"),
// separată de restul numerotărilor.
export async function creeazaInventariere(parohieId, { data, membri, observatii, bunuri }) {
  const an = new Date(data).getFullYear();
  const nrPV = await rezervaUrmatorulNumar(parohieId, an, "procesVerbal");
  const { data: rand, error } = await supabase
    .from("inventarieri_patrimoniu")
    .insert({ parohie_id: parohieId, nr_pv: nrPV, an, data, membri, observatii, bunuri })
    .select()
    .single();
  if (error) throw error;
  return { id: rand.id, nrPV, an, data, membri, observatii, bunuri };
}

/* ---------------------------- Organisme parohiale ---------------------------- */
// Adunarea parohială / Consiliul parohial / Comitetul parohial — aceeași structură de date
// pentru toate trei (discriminate prin tip_organism): mandate (perioade), cu membri
// (componență) și — doar la Adunare/Consiliu, în interfață — procese-verbale de ședință.
// Membrii se introduc independent, nelegați de Parteneri.

export async function getOrganismeParohiale(parohieId) {
  const [{ data: mandate, error: errM }, { data: membri, error: errMb }, { data: pv, error: errPv }] = await Promise.all([
    supabase.from("mandate_organisme_parohiale").select("*").eq("parohie_id", parohieId),
    supabase.from("membri_organisme_parohiale").select("*").eq("parohie_id", parohieId),
    supabase.from("procese_verbale_organisme_parohiale").select("*").eq("parohie_id", parohieId),
  ]);
  if (errM) throw errM;
  if (errMb) throw errMb;
  if (errPv) throw errPv;
  return {
    mandateOrganisme: (mandate || []).map((m) => ({ id: m.id, tipOrganism: m.tip_organism, dataInceput: m.data_inceput, dataSfarsit: m.data_sfarsit })),
    membriOrganisme: (membri || []).map((m) => ({ id: m.id, mandatId: m.mandat_id, nume: m.nume, adresa: m.adresa || "", telefon: m.telefon || "", email: m.email || "" })),
    proceseVerbaleOrganisme: (pv || []).map((p) => ({ id: p.id, mandatId: p.mandat_id, data: p.data, ordineZi: p.ordine_zi || "", decizii: p.decizii || "" })),
  };
}

export async function creeazaMandatOrganism(parohieId, { tipOrganism, dataInceput, dataSfarsit }) {
  const { data, error } = await supabase
    .from("mandate_organisme_parohiale")
    .insert({ parohie_id: parohieId, tip_organism: tipOrganism, data_inceput: dataInceput, data_sfarsit: dataSfarsit })
    .select()
    .single();
  if (error) throw error;
  return { id: data.id, tipOrganism, dataInceput, dataSfarsit };
}

export async function stergeMandatOrganism(mandatId) {
  const { error } = await supabase.from("mandate_organisme_parohiale").delete().eq("id", mandatId);
  if (error) throw error;
}

export async function adaugaMembruOrganism(parohieId, { mandatId, nume, adresa, telefon, email }) {
  const { data, error } = await supabase
    .from("membri_organisme_parohiale")
    .insert({ parohie_id: parohieId, mandat_id: mandatId, nume, adresa: adresa || null, telefon: telefon || null, email: email || null })
    .select()
    .single();
  if (error) throw error;
  return { id: data.id, mandatId, nume, adresa: adresa || "", telefon: telefon || "", email: email || "" };
}

export async function actualizeazaMembruOrganism(id, { nume, adresa, telefon, email }) {
  const { error } = await supabase
    .from("membri_organisme_parohiale")
    .update({ nume, adresa: adresa || null, telefon: telefon || null, email: email || null })
    .eq("id", id);
  if (error) throw error;
}

export async function stergeMembruOrganism(id) {
  const { error } = await supabase.from("membri_organisme_parohiale").delete().eq("id", id);
  if (error) throw error;
}

export async function adaugaProcesVerbalOrganism(parohieId, { mandatId, data, ordineZi, decizii }) {
  const { data: rand, error } = await supabase
    .from("procese_verbale_organisme_parohiale")
    .insert({ parohie_id: parohieId, mandat_id: mandatId, data, ordine_zi: ordineZi || null, decizii: decizii || null })
    .select()
    .single();
  if (error) throw error;
  return { id: rand.id, mandatId, data, ordineZi: ordineZi || "", decizii: decizii || "" };
}

export async function actualizeazaProcesVerbalOrganism(id, { data, ordineZi, decizii }) {
  const { error } = await supabase
    .from("procese_verbale_organisme_parohiale")
    .update({ data, ordine_zi: ordineZi || null, decizii: decizii || null })
    .eq("id", id);
  if (error) throw error;
}

export async function stergeProcesVerbalOrganism(id) {
  const { error } = await supabase.from("procese_verbale_organisme_parohiale").delete().eq("id", id);
  if (error) throw error;
}

/* ------------------------------- Utilitare ------------------------------- */

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
