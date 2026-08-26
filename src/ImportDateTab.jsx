import React, { useState, useMemo } from "react";
import * as XLSX from "xlsx";
import { AlertTriangle, Upload, FileSpreadsheet, Check, X, ChevronRight, RefreshCw, Sparkles, FileText, Image as ImageIcon } from "lucide-react";
import {
  getDocumenteExistentePentruAn,
  insereazaDocumentCuNumarFix,
  inlocuiesteDocument,
  sincronizeazaContor,
} from "./supabaseImportJurnal";

/* ---------------------------------------------------------------------- *
 *  Import date — Registru Jurnal din Excel (ani anteriori)
 *
 *  Citește un fișier .xlsx cu structura folosită deja de parohii pentru
 *  ținerea manuală a jurnalului: sheet "Jurnal [an]" (obligatoriu), plus
 *  opțional "Plati [an]" (sursa Bancă/Casă pentru OP-uri) și
 *  "Plati BCR [an]" (extras de cont, pentru semnalarea încasărilor care ar
 *  putea fi de fapt prin bancă, nu numerar).
 *
 *  Fiecare rând din "Jurnal [an]" e o linie bugetară — un document (chitanță
 *  sau OP) poate avea mai multe linii consecutive cu același număr.
 * ---------------------------------------------------------------------- */

const fmt = (n) =>
  (Math.round((Number(n) + Number.EPSILON) * 100) / 100).toLocaleString("ro-RO", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

function excelDataToISO(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "string") {
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
    const m = v.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  return null;
}

function separaPartenerExplicatie(text) {
  if (!text) return { tert: "", explicatie: "" };
  const idx = text.indexOf(": ");
  if (idx === -1) return { tert: "", explicatie: text.trim() };
  return { tert: text.slice(0, idx).trim(), explicatie: text.slice(idx + 2).trim() };
}

function gasesteSheet(workbook, prefix, an) {
  const tinta = `${prefix} ${an}`.toLowerCase();
  return workbook.SheetNames.find((n) => n.toLowerCase() === tinta) || null;
}

function parseazaJurnal(workbook, an) {
  const numeSheet = gasesteSheet(workbook, "Jurnal", an);
  if (!numeSheet) return { eroare: `Nu am găsit sheet-ul "Jurnal ${an}" în fișier.`, documente: [] };

  const ws = workbook.Sheets[numeSheet];
  const randuri = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
  const grupuri = new Map();

  for (let i = 1; i < randuri.length; i++) {
    const r = randuri[i];
    if (!r || r.length === 0) continue;
    const [, dataRaw, chitNr, opNr, artBugNr, explicatieRaw, venituri, cheltuieli] = r;
    if (!dataRaw || (chitNr == null && opNr == null) || artBugNr == null) continue;

    const tip = chitNr != null ? "incasare" : "plata";
    const nr = chitNr != null ? Number(chitNr) : Number(opNr);
    const suma = tip === "incasare" ? Number(venituri) : Number(cheltuieli);
    if (!nr || !suma || suma <= 0) continue;

    const dataISO = excelDataToISO(dataRaw);
    if (!dataISO) continue;

    const cheie = `${tip}-${nr}`;
    const { tert, explicatie } = separaPartenerExplicatie(String(explicatieRaw || ""));
    if (!grupuri.has(cheie)) {
      grupuri.set(cheie, { tip, nr, an, data: dataISO, tert, linii: [] });
    }
    const doc = grupuri.get(cheie);
    if (!doc.tert && tert) doc.tert = tert;
    doc.linii.push({
      contId: String(artBugNr).trim(),
      suma,
      explicatie,
      modPlata: tip === "incasare" ? "numerar" : "transfer",
    });
  }

  return { eroare: null, documente: [...grupuri.values()] };
}

function parseazaSursaPlati(workbook, an) {
  const numeSheet = gasesteSheet(workbook, "Plati", an);
  if (!numeSheet) return {};
  const ws = workbook.Sheets[numeSheet];
  const randuri = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
  if (randuri.length === 0) return {};
  const antet = randuri[0].map((h) => String(h || "").toLowerCase());
  const idxOp = antet.findIndex((h) => h.includes("op nr"));
  const idxSursa = antet.findIndex((h) => h.includes("banca") || h.includes("casa"));
  if (idxOp === -1 || idxSursa === -1) return {};

  const harta = {};
  for (let i = 1; i < randuri.length; i++) {
    const r = randuri[i];
    if (!r || r[idxOp] == null) continue;
    const sursa = String(r[idxSursa] || "").toLowerCase();
    harta[Number(r[idxOp])] = sursa.includes("banc") ? "transfer" : "numerar";
  }
  return harta;
}

function parseazaExtrasBCR(workbook, an) {
  const numeSheet = gasesteSheet(workbook, "Plati BCR", an);
  if (!numeSheet) return [];
  const ws = workbook.Sheets[numeSheet];
  const randuri = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
  if (randuri.length === 0) return [];
  const antet = randuri[0].map((h) => String(h || "").toLowerCase());
  const idxData = antet.findIndex((h) => h.includes("data"));
  const idxCredit = antet.findIndex((h) => h.includes("credit"));
  if (idxData === -1 || idxCredit === -1) return [];

  const rezultat = [];
  for (let i = 1; i < randuri.length; i++) {
    const r = randuri[i];
    if (!r || r[idxCredit] == null || Number(r[idxCredit]) === 0) continue;
    const dataISO = excelDataToISO(r[idxData]);
    if (!dataISO) continue;
    rezultat.push({ data: dataISO, suma: Number(r[idxCredit]) });
  }
  return rezultat;
}

function marcheazaPosibilBanca(documente, credituriBCR) {
  return documente.map((doc) => {
    if (doc.tip !== "incasare") return doc;
    const totalDoc = doc.linii.reduce((s, l) => s + l.suma, 0);
    const dataDoc = new Date(doc.data);
    const match = credituriBCR.find((c) => {
      if (Math.abs(c.suma - totalDoc) > 0.02) return false;
      const diffZile = Math.abs((new Date(c.data) - dataDoc) / 86400000);
      return diffZile <= 10;
    });
    return { ...doc, posibilBanca: !!match };
  });
}

function aplicaSursaPlati(documente, hartaSursa) {
  return documente.map((doc) => {
    if (doc.tip !== "plata") return doc;
    const sursa = hartaSursa[doc.nr];
    if (!sursa) return doc;
    return { ...doc, linii: doc.linii.map((l) => ({ ...l, modPlata: sursa })) };
  });
}

function fisierLaBase64(fisier) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = () => reject(new Error("Nu am putut citi fișierul."));
    reader.readAsDataURL(fisier);
  });
}

/* ------------------------------- UI -------------------------------- */

function BtnMic({ children, onClick, variant = "ghost", disabled, className = "" }) {
  const variants = {
    primary: "bg-[#1F3864] text-white hover:bg-[#152848] disabled:bg-stone-300",
    gold: "bg-[#B8860B] text-white hover:bg-[#9c7209] disabled:bg-stone-300",
    verde: "bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-stone-300",
    ghost: "bg-transparent text-stone-600 hover:bg-stone-100 border border-stone-300",
    danger: "bg-transparent text-rose-600 hover:bg-rose-50 border border-rose-200",
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

function Card({ children, className = "" }) {
  return <div className={`bg-white rounded-lg border border-stone-200 shadow-sm ${className}`}>{children}</div>;
}

export default function ImportDateTab({ parohieId, conturi, permisiuni, onImportFinalizat, onCreeazaOrdinPlata }) {
  const [an, setAn] = useState(new Date().getFullYear() - 1);
  const [fisier, setFisier] = useState(null);
  const [pas, setPas] = useState("selectie");
  const [eroare, setEroare] = useState("");
  const [documenteNoi, setDocumenteNoi] = useState([]);
  const [documenteConflict, setDocumenteConflict] = useState([]);
  const [decizii, setDecizii] = useState({});
  const [surseCorectate, setSurseCorectate] = useState({});
  const [rezultatImport, setRezultatImport] = useState(null);

  // --- Citire automată din PDF/poză (extras de cont, factură, bon, chitanță), prin AI ---
  const [fisierAI, setFisierAI] = useState(null);
  const [citindAI, setCitindAI] = useState(false);
  const [eroareAI, setEroareAI] = useState("");
  const [tipDetectatAI, setTipDetectatAI] = useState(null);
  const [liniiAI, setLiniiAI] = useState([]); // [{ id, data, suma, partener, explicatie, contId, sursa, selectat }]
  const [creandOP, setCreandOP] = useState(false);
  const [rezultatCreareAI, setRezultatCreareAI] = useState(null); // { create, erori }

  const conturiCheltuiala = useMemo(() => (conturi || []).filter((c) => c.clasa === "cheltuiala"), [conturi]);

  async function citesteDocumentAI() {
    if (!fisierAI) return;
    setCitindAI(true);
    setEroareAI("");
    setLiniiAI([]);
    setTipDetectatAI(null);
    setRezultatCreareAI(null);
    try {
      const base64 = await fisierLaBase64(fisierAI);
      const raspuns = await fetch("/api/citeste-document", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileBase64: base64, mediaType: fisierAI.type }),
      });
      const rezultat = await raspuns.json();
      if (!raspuns.ok) {
        setEroareAI(rezultat.error || "Eroare la citirea documentului.");
        return;
      }
      if (!rezultat.tranzactii || rezultat.tranzactii.length === 0) {
        setEroareAI("Nu am reușit să extrag nicio tranzacție din acest document — verifică dacă e lizibil, sau introdu datele manual.");
        return;
      }
      setTipDetectatAI(rezultat.tipDocument);
      // Doar liniile de "debit" (plăți/cheltuieli) sunt candidate pentru emiterea unui Ordin de
      // plată aici — încasările (extras de cont) au nevoie de o Chitanță, flux separat.
      const debiteDetectate = rezultat.tranzactii.filter((t) => t.sens === "debit");
      setLiniiAI(
        debiteDetectate.map((t, i) => ({
          id: `ai-${i}`,
          data: /^\d{4}-\d{2}-\d{2}$/.test(t.data || "") ? t.data : todayISOLocal(),
          suma: t.suma || 0,
          partener: t.partener || "",
          explicatie: t.descriere || "",
          nrDocument: t.nrDocument || "",
          contId: "",
          sursa: "transfer",
          selectat: true,
        }))
      );
      if (debiteDetectate.length < rezultat.tranzactii.length) {
        setEroareAI(`Notă: documentul mai conține ${rezultat.tranzactii.length - debiteDetectate.length} încasare(ăi) — acestea nu sunt afișate aici (au nevoie de o Chitanță, nu de un Ordin de plată).`);
      }
    } catch (e) {
      setEroareAI(e.message || "Eroare neașteptată la citirea documentului.");
    } finally {
      setCitindAI(false);
    }
  }

  function actualizeazaLinieAI(id, patch) {
    setLiniiAI((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }

  async function creeazaOrdinelePlataAI() {
    const deCreat = liniiAI.filter((l) => l.selectat);
    if (deCreat.length === 0) return;
    if (deCreat.some((l) => !l.contId || !l.suma || Number(l.suma) <= 0)) {
      setEroareAI("Fiecare linie selectată trebuie să aibă un articol bugetar ales și o sumă validă.");
      return;
    }
    setCreandOP(true);
    setEroareAI("");
    let create = 0;
    const erori = [];
    const idsReusite = [];
    for (const l of deCreat) {
      try {
        await onCreeazaOrdinPlata({
          data: l.data,
          modPlata: l.sursa,
          tert: l.partener,
          linii: [{ contId: l.contId, suma: Number(l.suma), explicatie: l.explicatie }],
        });
        create++;
        idsReusite.push(l.id);
      } catch (e) {
        erori.push({ doc: `${l.partener || "Document"} — ${fmt(l.suma)} lei`, mesaj: e.message });
      }
    }
    setRezultatCreareAI({ create, erori });
    setLiniiAI((ls) => ls.filter((l) => !idsReusite.includes(l.id)));
    setCreandOP(false);
  }

  function reseteazaAI() {
    setFisierAI(null);
    setEroareAI("");
    setTipDetectatAI(null);
    setLiniiAI([]);
    setRezultatCreareAI(null);
  }

  function todayISOLocal() {
    return new Date().toISOString().slice(0, 10);
  }

  const contById = useMemo(() => Object.fromEntries((conturi || []).map((c) => [c.id, c])), [conturi]);

  async function analizeazaFisier() {
    setEroare("");
    setPas("analizand");
    try {
      const buffer = await fisier.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: "array", cellDates: true });

      const { eroare: eroareJurnal, documente } = parseazaJurnal(workbook, an);
      if (eroareJurnal) {
        setEroare(eroareJurnal);
        setPas("selectie");
        return;
      }
      if (documente.length === 0) {
        setEroare(`Sheet-ul "Jurnal ${an}" nu conține rânduri de date recunoscute.`);
        setPas("selectie");
        return;
      }

      const hartaSursaPlati = parseazaSursaPlati(workbook, an);
      const credituriBCR = parseazaExtrasBCR(workbook, an);
      let docs = aplicaSursaPlati(documente, hartaSursaPlati);
      docs = marcheazaPosibilBanca(docs, credituriBCR);

      const [existenteIncasari, existentePlati] = await Promise.all([
        getDocumenteExistentePentruAn(parohieId, an, "incasare"),
        getDocumenteExistentePentruAn(parohieId, an, "plata"),
      ]);
      const existenteToate = { ...existenteIncasari, ...existentePlati };

      const noi = [];
      const conflicte = [];
      for (const doc of docs) {
        const cheie = `${doc.tip}-${doc.nr}`;
        const existent = existenteToate[cheie];
        if (!existent) {
          noi.push(doc);
        } else {
          conflicte.push({ cheie, document: doc, existent });
        }
      }

      setDocumenteNoi(noi);
      setDocumenteConflict(conflicte);
      setDecizii({});
      setSurseCorectate({});
      setPas("revizuire");
    } catch (e) {
      setEroare(e.message || "Eroare la citirea fișierului. Verifică formatul.");
      setPas("selectie");
    }
  }

  function suntToateDeciziileLuate() {
    return documenteConflict.every((c) => {
      if (c.existent.esteExcedentReportat) return decizii[c.cheie] === "pastreaza" || decizii[c.cheie] === "sari";
      if (c.existent.legatDeAltModul) return decizii[c.cheie] === "pastreaza" || decizii[c.cheie] === "sari";
      return !!decizii[c.cheie];
    });
  }

  async function ruleazaImportul() {
    setPas("importand");
    let inserate = 0;
    let inlocuite = 0;
    let sarite = 0;
    const erori = [];

    for (const doc of documenteNoi) {
      try {
        const modPlataForatat = surseCorectate[`${doc.tip}-${doc.nr}`];
        const linii = modPlataForatat ? doc.linii.map((l) => ({ ...l, modPlata: modPlataForatat })) : doc.linii;
        await insereazaDocumentCuNumarFix(parohieId, { ...doc, linii });
        inserate++;
      } catch (e) {
        erori.push({ doc: `${doc.tip === "incasare" ? "Chitanță" : "OP"} nr. ${doc.nr}/${doc.an}`, mesaj: e.message });
      }
    }

    for (const c of documenteConflict) {
      const decizie = decizii[c.cheie];
      if (decizie === "sari" || (!decizie && (c.existent.esteExcedentReportat || c.existent.legatDeAltModul))) {
        sarite++;
        continue;
      }
      if (decizie === "pastreaza") {
        sarite++;
        continue;
      }
      if (decizie === "inlocuieste") {
        try {
          const modPlataForatat = surseCorectate[c.cheie];
          const linii = modPlataForatat ? c.document.linii.map((l) => ({ ...l, modPlata: modPlataForatat })) : c.document.linii;
          await inlocuiesteDocument(c.existent.documentId, { ...c.document, linii });
          inlocuite++;
        } catch (e) {
          erori.push({ doc: `${c.document.tip === "incasare" ? "Chitanță" : "OP"} nr. ${c.document.nr}/${c.document.an}`, mesaj: e.message });
        }
      }
    }

    try {
      await sincronizeazaContor(parohieId, an, "incasare");
      await sincronizeazaContor(parohieId, an, "plata");
    } catch (e) {
      erori.push({ doc: "Sincronizare contor", mesaj: e.message });
    }

    setRezultatImport({ inserate, inlocuite, sarite, erori });
    setPas("finalizat");
    if (onImportFinalizat) onImportFinalizat();
  }

  function reseteaza() {
    setFisier(null);
    setPas("selectie");
    setEroare("");
    setDocumenteNoi([]);
    setDocumenteConflict([]);
    setDecizii({});
    setSurseCorectate({});
    setRezultatImport(null);
  }

  const totalDocumenteDeRevizuit = documenteNoi.length + documenteConflict.length;
  const chitanteSemnalate = documenteNoi.filter((d) => d.posibilBanca).length;

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="font-serif text-2xl text-[#1F3864]">Import date</h1>
        <p className="text-sm text-stone-500">
          Importă Registrul Jurnal al unui an anterior, dintr-un fișier Excel ținut anterior manual —
          sau citește automat un document curent (extras de cont, factură, bon, chitanță).
        </p>
      </header>

      <Card className="p-5 flex flex-col gap-4 max-w-2xl">
        <div className="flex items-center gap-2">
          <Sparkles size={18} className="text-[#B8860B]" />
          <h2 className="font-serif text-lg text-[#1F3864]">Citire automată document (AI)</h2>
        </div>
        <p className="text-xs text-stone-500">
          Încarcă un extras de cont bancar, o factură, un bon fiscal sau o chitanță — în format PDF sau
          poză (JPG/PNG) — iar aplicația extrage automat datele, gata de revizuit. Documentul e trimis
          criptat, direct la Anthropic (compania care face Claude), nu e stocat de nimeni altcineva.
        </p>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-stone-600 font-medium">Fișier (PDF sau poză)</span>
          <input
            type="file"
            accept=".pdf,.jpg,.jpeg,.png,.webp"
            className="border border-stone-300 rounded-md px-2.5 py-1.5 text-sm"
            onChange={(e) => { setFisierAI(e.target.files?.[0] || null); reseteazaAI(); }}
          />
        </label>
        {eroareAI && (
          <span className="text-xs flex items-center gap-1 text-amber-700">
            <AlertTriangle size={12} /> {eroareAI}
          </span>
        )}
        <BtnMic variant="gold" onClick={citesteDocumentAI} disabled={!fisierAI || citindAI || permisiuni?.citireOnly} className="self-start">
          {citindAI ? <RefreshCw size={14} className="animate-spin" /> : <Sparkles size={14} />}
          {citindAI ? "Se citește..." : "Citește documentul"}
        </BtnMic>

        {liniiAI.length > 0 && (
          <div className="flex flex-col gap-3 border-t border-stone-200 pt-3">
            <div className="flex items-center gap-2 text-xs text-stone-500">
              {fisierAI?.type === "application/pdf" ? <FileText size={13} /> : <ImageIcon size={13} />}
              Tip document detectat: <strong>{tipDetectatAI === "extras_cont" ? "extras de cont" : tipDetectatAI === "factura" ? "factură" : tipDetectatAI === "bon" ? "bon fiscal" : tipDetectatAI === "chitanta" ? "chitanță" : "necunoscut"}</strong>
              — {liniiAI.length} plată(ăi) candidate pentru Ordin de plată
            </div>
            {liniiAI.map((l) => (
              <Card key={l.id} className="p-3 border-stone-200">
                <div className="flex items-start gap-2">
                  <input type="checkbox" className="mt-2" checked={l.selectat} onChange={(e) => actualizeazaLinieAI(l.id, { selectat: e.target.checked })} />
                  <div className="grid grid-cols-2 gap-2 flex-1 text-xs">
                    <label className="flex flex-col gap-0.5">
                      <span className="text-stone-500">Data</span>
                      <input type="date" className="border border-stone-300 rounded px-2 py-1" value={l.data} onChange={(e) => actualizeazaLinieAI(l.id, { data: e.target.value })} />
                    </label>
                    <label className="flex flex-col gap-0.5">
                      <span className="text-stone-500">Sumă (lei)</span>
                      <input type="number" step="0.01" className="border border-stone-300 rounded px-2 py-1" value={l.suma} onChange={(e) => actualizeazaLinieAI(l.id, { suma: e.target.value })} />
                    </label>
                    <label className="flex flex-col gap-0.5">
                      <span className="text-stone-500">Furnizor/Beneficiar</span>
                      <input className="border border-stone-300 rounded px-2 py-1" value={l.partener} onChange={(e) => actualizeazaLinieAI(l.id, { partener: e.target.value })} />
                    </label>
                    <label className="flex flex-col gap-0.5">
                      <span className="text-stone-500">Sursă</span>
                      <select className="border border-stone-300 rounded px-2 py-1" value={l.sursa} onChange={(e) => actualizeazaLinieAI(l.id, { sursa: e.target.value })}>
                        <option value="numerar">Casă</option>
                        <option value="transfer">Bancă</option>
                      </select>
                    </label>
                    <label className="flex flex-col gap-0.5 col-span-2">
                      <span className="text-stone-500">Explicație</span>
                      <input className="border border-stone-300 rounded px-2 py-1" value={l.explicatie} onChange={(e) => actualizeazaLinieAI(l.id, { explicatie: e.target.value })} />
                    </label>
                    <label className="flex flex-col gap-0.5 col-span-2">
                      <span className="text-stone-500">Articol bugetar <span className="text-rose-600">*</span></span>
                      <select className="border border-stone-300 rounded px-2 py-1" value={l.contId} onChange={(e) => actualizeazaLinieAI(l.id, { contId: e.target.value })}>
                        <option value="">— selectați —</option>
                        {conturiCheltuiala.map((c) => <option key={c.id} value={c.id}>{c.simbol} — {c.denumire}</option>)}
                      </select>
                    </label>
                  </div>
                </div>
              </Card>
            ))}
            <BtnMic variant="verde" onClick={creeazaOrdinelePlataAI} disabled={creandOP || !liniiAI.some((l) => l.selectat)} className="self-start">
              {creandOP ? <RefreshCw size={14} className="animate-spin" /> : <ChevronRight size={14} />}
              {creandOP ? "Se creează..." : `Creează Ordin${liniiAI.filter((l) => l.selectat).length > 1 ? "e" : ""} de plată (${liniiAI.filter((l) => l.selectat).length})`}
            </BtnMic>
          </div>
        )}

        {rezultatCreareAI && (
          <div className="border-t border-stone-200 pt-3 flex flex-col gap-1 text-xs">
            <span className="text-emerald-700 font-medium flex items-center gap-1"><Check size={13} /> {rezultatCreareAI.create} Ordin(e) de plată create.</span>
            {rezultatCreareAI.erori.map((e, i) => (
              <span key={i} className="text-rose-700">{e.doc}: {e.mesaj}</span>
            ))}
          </div>
        )}
      </Card>

      {pas === "selectie" && (
        <Card className="p-5 flex flex-col gap-4 max-w-xl">
          <h2 className="font-serif text-lg text-[#1F3864]">Registru Jurnal (an anterior)</h2>
          <p className="text-xs text-stone-500">
            Fișierul trebuie să conțină un sheet numit exact „Jurnal [an]" (ex. „Jurnal 2025"), cu structura:
            Nr crt / Data / Chit Nr / OP nr. / Art. Bug. Nr. / Explicație / Venituri / Cheltuieli / Sold / Nr vol chit.
            Opțional, sheet-urile „Plati [an]" (sursa Bancă/Casă a plăților) și „Plati BCR [an]" (extras de cont,
            pentru semnalarea încasărilor posibil prin bancă) sunt folosite automat, dacă există.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-stone-600 font-medium">An</span>
              <input
                type="number"
                className="border border-stone-300 rounded-md px-2.5 py-1.5 text-sm"
                value={an}
                onChange={(e) => setAn(Number(e.target.value))}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-stone-600 font-medium">Fișier Excel (.xlsx)</span>
              <input
                type="file"
                accept=".xlsx"
                className="border border-stone-300 rounded-md px-2.5 py-1.5 text-sm"
                onChange={(e) => setFisier(e.target.files?.[0] || null)}
              />
            </label>
          </div>
          {eroare && (
            <span className="text-rose-600 text-xs flex items-center gap-1">
              <AlertTriangle size={12} /> {eroare}
            </span>
          )}
          <BtnMic variant="gold" onClick={analizeazaFisier} disabled={!fisier || permisiuni?.citireOnly}>
            <Upload size={14} /> Analizează fișierul
          </BtnMic>
        </Card>
      )}

      {pas === "analizand" && (
        <Card className="p-5 flex items-center gap-2 text-sm text-stone-500">
          <RefreshCw size={14} className="animate-spin" /> Se analizează fișierul și se verifică documentele existente...
        </Card>
      )}

      {pas === "revizuire" && (
        <div className="flex flex-col gap-4">
          <Card className="p-4 bg-stone-50 flex flex-wrap items-center gap-4 text-sm">
            <span><strong>{documenteNoi.length}</strong> documente noi</span>
            <span><strong>{documenteConflict.length}</strong> în conflict (necesită decizie)</span>
            {chitanteSemnalate > 0 && (
              <span className="text-amber-700 flex items-center gap-1">
                <AlertTriangle size={13} /> {chitanteSemnalate} chitanțe semnalate „posibil Bancă"
              </span>
            )}
          </Card>

          {documenteNoi.length > 0 && (
            <Card className="overflow-x-auto">
              <div className="px-3 pt-3 text-xs uppercase tracking-wide text-stone-500 font-medium">Documente noi (fără conflict)</div>
              <table className="w-full text-xs mt-2">
                <thead>
                  <tr className="text-left bg-stone-50 text-stone-500 border-b border-stone-200">
                    <th className="px-2 py-1.5">Tip</th>
                    <th className="px-2 py-1.5">Nr.</th>
                    <th className="px-2 py-1.5">Data</th>
                    <th className="px-2 py-1.5">Partener</th>
                    <th className="px-2 py-1.5 text-right">Sumă</th>
                    <th className="px-2 py-1.5">Sursă</th>
                  </tr>
                </thead>
                <tbody>
                  {documenteNoi.map((d) => {
                    const cheie = `${d.tip}-${d.nr}`;
                    const total = d.linii.reduce((s, l) => s + l.suma, 0);
                    const sursaAfisata = surseCorectate[cheie] || d.linii[0]?.modPlata;
                    return (
                      <tr key={cheie} className={`border-b border-stone-100 ${d.posibilBanca ? "bg-amber-50" : ""}`}>
                        <td className="px-2 py-1.5">{d.tip === "incasare" ? "Chitanță" : "OP"}</td>
                        <td className="px-2 py-1.5 tabular-nums">{d.nr}/{d.an}</td>
                        <td className="px-2 py-1.5 tabular-nums">{d.data}</td>
                        <td className="px-2 py-1.5">{d.tert || "—"}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmt(total)}</td>
                        <td className="px-2 py-1.5">
                          {d.posibilBanca ? (
                            <select
                              className="border border-amber-300 rounded px-1.5 py-0.5 text-xs"
                              value={sursaAfisata}
                              onChange={(e) => setSurseCorectate((s) => ({ ...s, [cheie]: e.target.value }))}
                            >
                              <option value="numerar">Casă</option>
                              <option value="transfer">Bancă</option>
                            </select>
                          ) : (
                            <span className="text-stone-500">{sursaAfisata === "numerar" ? "Casă" : "Bancă"}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
          )}

          {documenteConflict.length > 0 && (
            <Card className="overflow-x-auto">
              <div className="px-3 pt-3 text-xs uppercase tracking-wide text-stone-500 font-medium">Documente în conflict — necesită decizie</div>
              <div className="flex flex-col gap-3 p-3">
                {documenteConflict.map((c) => {
                  const totalExcel = c.document.linii.reduce((s, l) => s + l.suma, 0);
                  const totalExistent = c.existent.linii.reduce((s, l) => s + l.suma, 0);
                  const diferaData = c.document.data !== c.existent.data;
                  const diferaTert = (c.document.tert || "") !== (c.existent.tert || "");
                  const diferaSuma = Math.abs(totalExcel - totalExistent) > 0.01;
                  const blocatInlocuire = c.existent.esteExcedentReportat || c.existent.legatDeAltModul;
                  const decizie = decizii[c.cheie];
                  return (
                    <Card key={c.cheie} className="p-3 border-stone-200">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm font-medium">
                          {c.document.tip === "incasare" ? "Chitanță" : "OP"} nr. {c.document.nr}/{c.document.an}
                        </span>
                        {blocatInlocuire && (
                          <span className="text-xs text-amber-700 flex items-center gap-1">
                            <AlertTriangle size={12} />
                            {c.existent.esteExcedentReportat ? "Excedent reportat — nu poate fi înlocuit" : "Legat de alt modul (Pangar/Patrimoniu) — nu poate fi înlocuit"}
                          </span>
                        )}
                      </div>
                      <div className="grid grid-cols-2 gap-3 text-xs">
                        <div className="border border-stone-200 rounded p-2">
                          <div className="text-stone-400 uppercase text-[10px] mb-1">În aplicație (existent)</div>
                          <div className={diferaData ? "text-rose-700 font-medium" : ""}>Data: {c.existent.data}</div>
                          <div className={diferaTert ? "text-rose-700 font-medium" : ""}>Partener: {c.existent.tert || "—"}</div>
                          <div className={diferaSuma ? "text-rose-700 font-medium" : ""}>Sumă: {fmt(totalExistent)} lei</div>
                          <div className="text-stone-400 mt-1">{c.existent.linii.length} linii</div>
                        </div>
                        <div className="border border-stone-200 rounded p-2">
                          <div className="text-stone-400 uppercase text-[10px] mb-1">Din Excel</div>
                          <div className={diferaData ? "text-rose-700 font-medium" : ""}>Data: {c.document.data}</div>
                          <div className={diferaTert ? "text-rose-700 font-medium" : ""}>Partener: {c.document.tert || "—"}</div>
                          <div className={diferaSuma ? "text-rose-700 font-medium" : ""}>Sumă: {fmt(totalExcel)} lei</div>
                          <div className="text-stone-400 mt-1">{c.document.linii.length} linii</div>
                        </div>
                      </div>
                      <div className="flex gap-2 mt-3">
                        <BtnMic variant={decizie === "pastreaza" ? "primary" : "ghost"} onClick={() => setDecizii((d) => ({ ...d, [c.cheie]: "pastreaza" }))}>
                          <Check size={12} /> Păstrează existent
                        </BtnMic>
                        <BtnMic
                          variant={decizie === "inlocuieste" ? "gold" : "ghost"}
                          disabled={blocatInlocuire}
                          onClick={() => setDecizii((d) => ({ ...d, [c.cheie]: "inlocuieste" }))}
                        >
                          <RefreshCw size={12} /> Înlocuiește cu Excel
                        </BtnMic>
                        <BtnMic variant={decizie === "sari" ? "danger" : "ghost"} onClick={() => setDecizii((d) => ({ ...d, [c.cheie]: "sari" }))}>
                          <X size={12} /> Sari peste
                        </BtnMic>
                      </div>
                    </Card>
                  );
                })}
              </div>
            </Card>
          )}

          <div className="flex justify-end gap-2">
            <BtnMic variant="ghost" onClick={reseteaza}>Anulează</BtnMic>
            <BtnMic variant="verde" onClick={ruleazaImportul} disabled={!suntToateDeciziileLuate() || totalDocumenteDeRevizuit === 0}>
              <ChevronRight size={14} /> Confirmă importul ({totalDocumenteDeRevizuit} documente)
            </BtnMic>
          </div>
        </div>
      )}

      {pas === "importand" && (
        <Card className="p-5 flex items-center gap-2 text-sm text-stone-500">
          <RefreshCw size={14} className="animate-spin" /> Se importă documentele...
        </Card>
      )}

      {pas === "finalizat" && rezultatImport && (
        <Card className="p-5 flex flex-col gap-3 max-w-xl">
          <div className="flex items-center gap-2 text-emerald-700 text-sm font-medium">
            <Check size={16} /> Import finalizat
          </div>
          <div className="text-sm text-stone-600 flex flex-col gap-1">
            <span>{rezultatImport.inserate} documente noi inserate</span>
            <span>{rezultatImport.inlocuite} documente înlocuite</span>
            <span>{rezultatImport.sarite} documente sărite (păstrate cum erau)</span>
          </div>
          {rezultatImport.erori.length > 0 && (
            <div className="border border-rose-200 bg-rose-50 rounded-md p-3 flex flex-col gap-1">
              <span className="text-xs text-rose-800 font-medium">Erori întâmpinate:</span>
              {rezultatImport.erori.map((e, i) => (
                <span key={i} className="text-xs text-rose-700">{e.doc}: {e.mesaj}</span>
              ))}
            </div>
          )}
          <BtnMic variant="gold" onClick={reseteaza} className="self-start">
            <FileSpreadsheet size={14} /> Importă alt fișier
          </BtnMic>
        </Card>
      )}
    </div>
  );
}
