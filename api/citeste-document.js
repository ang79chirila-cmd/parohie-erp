// api/citeste-document.js — funcție serverless Vercel.
//
// Primește un document (PDF sau imagine: extras de cont, factură, bon, chitanță), îl trimite la
// Claude (Anthropic API) și întoarce date structurate, pe care aplicația le afișează spre
// verificare umană. Nimic nu se salvează automat.
//
// Contract (folosit de src/ImportDateTab.jsx):
//   POST /api/citeste-document
//   Header:  Authorization: Bearer <token sesiune Supabase>
//   Body:    { fileBase64: string, mediaType: string }
//   Răspuns 200: { tipDocument, tranzactii: [{ data, suma, sens, partener, descriere, nrDocument }] }
//   Răspuns eroare: { error: string }
//
// Variabilă de mediu obligatorie în Vercel: ANTHROPIC_API_KEY (nu ajunge niciodată în browser).

const SUPABASE_URL = process.env.SUPABASE_URL || "https://jcdsamfsqfcjryrxftsb.supabase.co";
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpjZHNhbWZzcWZjanJ5cnhmdHNiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM5NjY3MDAsImV4cCI6MjA5OTU0MjcwMH0.mJOYPwiAb1lq2uI-t5t3m-B5aS3KGV9vxggbal6l64E";

const MODEL = "claude-sonnet-5";
const TIPURI_IMAGINE = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const TIP_PDF = "application/pdf";
// Vercel limitează corpul cererii la 4,5 MB; base64 mărește fișierul cu ~33%.
const MAX_BASE64_CARACTERE = 4_300_000;

const PROMPT_SISTEM = `Extragi date financiare din documente (extrase de cont bancar, facturi, bonuri fiscale, chitanțe) pentru o parohie ortodoxă română cu evidență contabilă în partidă simplă, în lei (RON).

Întorci STRICT un obiect JSON, fără niciun text înainte sau după și fără blocuri de cod markdown, cu structura:

{
  "tipDocument": "extras_cont" | "factura" | "bon" | "chitanta" | "necunoscut",
  "tranzactii": [
    {
      "data": "AAAA-LL-ZZ",
      "suma": 123.45,
      "sens": "debit" | "credit",
      "partener": "furnizor / beneficiar / plătitor, exact cum apare",
      "descriere": "natura operațiunii, pe scurt",
      "nrDocument": "numărul facturii/bonului/chitanței/ordinului, sau șir gol"
    }
  ]
}

Reguli:
- Factură, bon sau chitanță primită de parohie: o singură tranzacție, suma TOTALĂ de plată (cu TVA), "sens": "debit".
- Extras de cont: câte o tranzacție pentru FIECARE operațiune; ieșirile de bani sunt "debit", intrările sunt "credit". Nu include soldurile inițial/final ca tranzacții.
- "suma": număr pozitiv, cu punct zecimal (ex. 1234.50), fără separator de mii, fără monedă.
- "data": data operațiunii în format AAAA-LL-ZZ; dacă lipsește, data emiterii documentului; dacă nu există nicio dată, șir gol.
- Nu inventa date. Un câmp care nu apare în document rămâne șir gol.
- Dacă documentul nu e un document financiar lizibil: "tipDocument": "necunoscut", "tranzactii": [].`;

function trimite(res, status, obiect) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obiect));
}

async function verificaSesiuneSupabase(token) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const user = await r.json();
  return user && user.id ? user : null;
}

function extrageJSON(text) {
  const curat = String(text || "").replace(/```json|```/g, "").trim();
  const start = curat.indexOf("{");
  const sfarsit = curat.lastIndexOf("}");
  if (start === -1 || sfarsit <= start) throw new Error("Răspunsul nu conține JSON.");
  return JSON.parse(curat.slice(start, sfarsit + 1));
}

function normalizeazaSuma(v) {
  if (typeof v === "number") return Number.isFinite(v) ? Math.abs(Math.round(v * 100) / 100) : 0;
  const s = String(v ?? "").replace(/\s|RON|lei/gi, "");
  if (!s) return 0;
  // „1.234,56" (format românesc) → 1234.56 ; „1,234.56" → 1234.56
  let n;
  if (/,\d{1,2}$/.test(s)) n = Number(s.replace(/\./g, "").replace(",", "."));
  else n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? Math.abs(Math.round(n * 100) / 100) : 0;
}

function normalizeazaRezultat(brut) {
  const tipuriValide = ["extras_cont", "factura", "bon", "chitanta", "necunoscut"];
  const tipDocument = tipuriValide.includes(brut?.tipDocument) ? brut.tipDocument : "necunoscut";
  const tranzactii = (Array.isArray(brut?.tranzactii) ? brut.tranzactii : [])
    .map((t) => ({
      data: /^\d{4}-\d{2}-\d{2}$/.test(String(t?.data || "")) ? t.data : "",
      suma: normalizeazaSuma(t?.suma),
      sens: t?.sens === "credit" ? "credit" : "debit",
      partener: String(t?.partener || "").trim(),
      descriere: String(t?.descriere || "").trim(),
      nrDocument: String(t?.nrDocument || "").trim(),
    }))
    .filter((t) => t.suma > 0);
  return { tipDocument, tranzactii };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return trimite(res, 405, { error: "Metodă nepermisă — doar POST." });
  }

  const cheie = process.env.ANTHROPIC_API_KEY;
  if (!cheie) {
    return trimite(res, 500, {
      error: "Cheia API Anthropic nu este configurată pe server (Vercel → Settings → Environment Variables → ANTHROPIC_API_KEY).",
    });
  }

  // Doar utilizatorii autentificați în aplicație pot folosi funcția (altfel oricine ar putea
  // consuma creditul API al parohiei apelând direct adresa).
  const antet = req.headers.authorization || "";
  const token = antet.startsWith("Bearer ") ? antet.slice(7).trim() : "";
  if (!token) return trimite(res, 401, { error: "Neautentificat — reconectați-vă în aplicație." });
  let utilizator;
  try {
    utilizator = await verificaSesiuneSupabase(token);
  } catch {
    return trimite(res, 502, { error: "Nu s-a putut verifica sesiunea (Supabase indisponibil)." });
  }
  if (!utilizator) return trimite(res, 401, { error: "Sesiune expirată sau invalidă — reconectați-vă în aplicație." });

  let corp = req.body;
  if (typeof corp === "string") {
    try { corp = JSON.parse(corp); } catch { corp = null; }
  }
  const fileBase64 = corp?.fileBase64;
  const mediaType = corp?.mediaType;
  if (!fileBase64 || typeof fileBase64 !== "string") {
    return trimite(res, 400, { error: "Lipsește fișierul." });
  }
  if (fileBase64.length > MAX_BASE64_CARACTERE) {
    return trimite(res, 413, { error: "Fișier prea mare — maximum 3 MB. Scanați la rezoluție mai mică sau împărțiți PDF-ul." });
  }
  let blocDocument;
  if (mediaType === TIP_PDF) {
    blocDocument = { type: "document", source: { type: "base64", media_type: TIP_PDF, data: fileBase64 } };
  } else if (TIPURI_IMAGINE.includes(mediaType)) {
    blocDocument = { type: "image", source: { type: "base64", media_type: mediaType, data: fileBase64 } };
  } else {
    return trimite(res, 400, { error: `Tip de fișier neacceptat (${mediaType || "necunoscut"}). Acceptate: PDF, JPG, PNG, WEBP.` });
  }

  let raspunsAPI;
  try {
    raspunsAPI = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": cheie,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 16000,
        system: PROMPT_SISTEM,
        messages: [
          {
            role: "user",
            content: [blocDocument, { type: "text", text: "Extrage datele conform instrucțiunilor. Răspunde doar cu JSON." }],
          },
        ],
      }),
    });
  } catch {
    return trimite(res, 502, { error: "Nu s-a putut contacta serviciul Anthropic." });
  }

  const date = await raspunsAPI.json().catch(() => null);
  if (!raspunsAPI.ok) {
    const mesaj = date?.error?.message || `cod ${raspunsAPI.status}`;
    if (raspunsAPI.status === 401) return trimite(res, 502, { error: "Cheia ANTHROPIC_API_KEY este invalidă." });
    if (raspunsAPI.status === 429) return trimite(res, 429, { error: "Limită de utilizare Anthropic atinsă — reîncercați peste un minut." });
    return trimite(res, 502, { error: `Eroare Anthropic: ${mesaj}` });
  }

  // Se iau doar blocurile de tip "text" (modelul poate întoarce și blocuri de gândire).
  const text = (date?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  try {
    return trimite(res, 200, normalizeazaRezultat(extrageJSON(text)));
  } catch {
    return trimite(res, 502, { error: "Răspunsul AI nu a putut fi interpretat — reîncercați sau introduceți datele manual." });
  }
}
