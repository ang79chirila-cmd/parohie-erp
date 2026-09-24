// arhivaZip.mjs
// Construiește o arhivă ZIP standard (deschisă nativ de Windows, macOS, Linux, 7-Zip etc.),
// fără nicio bibliotecă externă. Compresia folosește CompressionStream("deflate-raw"), disponibil
// în browserele actuale (Chrome/Edge 103+, Firefox 113+, Safari 16.4+) și în Node 21.2+; dacă
// lipsește, fișierele se stochează necomprimat (metoda 0) — arhiva rămâne validă.
// Modul separat de restul aplicației, ca să poată fi testat automat în Node.

const TABEL_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

// CRC-32 (polinomul standard ZIP/IEEE 802.3) al unui șir de octeți.
export function crc32(octeti) {
  let c = 0xffffffff;
  for (let i = 0; i < octeti.length; i++) c = TABEL_CRC[(c ^ octeti[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Amprenta SHA-256, în hexazecimal (64 de caractere). Folosește Web Crypto (browser/Node).
export async function sha256Hex(octeti) {
  const rezumat = await globalThis.crypto.subtle.digest("SHA-256", octeti);
  return Array.from(new Uint8Array(rezumat), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function comprimaDeflateRaw(octeti) {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const flux = new Blob([octeti]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(flux).arrayBuffer());
  } catch (e) {
    return null;
  }
}

// Data și ora în formatul MS-DOS folosit de ZIP (ora locală, rezoluție 2 secunde).
function dataDos(d) {
  const an = Math.max(1980, d.getFullYear());
  return {
    ora: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    data: ((an - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// fisiere: [{ nume: "tabele/documente.json", date: Uint8Array }]
// Întoarce Uint8Array cu arhiva completă. Limite (suficiente aici): sub 65.535 fișiere și sub 4 GB.
export async function construiesteZip(fisiere, dataModificare = new Date()) {
  const enc = new TextEncoder();
  const { ora, data } = dataDos(dataModificare);
  const parti = [];
  const central = [];
  let pozitie = 0;

  for (const f of fisiere) {
    const numeOcteti = enc.encode(f.nume);
    const crc = crc32(f.date);
    const comprimat = await comprimaDeflateRaw(f.date);
    // Păstrăm varianta comprimată doar dacă e efectiv mai mică.
    const folosesteDeflate = comprimat !== null && comprimat.length < f.date.length;
    const continut = folosesteDeflate ? comprimat : f.date;
    const metoda = folosesteDeflate ? 8 : 0;

    const antet = new DataView(new ArrayBuffer(30));
    antet.setUint32(0, 0x04034b50, true); // semnătura antetului local
    antet.setUint16(4, 20, true); // versiunea necesară (2.0)
    antet.setUint16(6, 0x0800, true); // bitul 11: nume de fișier în UTF-8
    antet.setUint16(8, metoda, true);
    antet.setUint16(10, ora, true);
    antet.setUint16(12, data, true);
    antet.setUint32(14, crc, true);
    antet.setUint32(18, continut.length, true);
    antet.setUint32(22, f.date.length, true);
    antet.setUint16(26, numeOcteti.length, true);
    antet.setUint16(28, 0, true); // fără câmp suplimentar

    const inregistrareCentrala = new DataView(new ArrayBuffer(46));
    inregistrareCentrala.setUint32(0, 0x02014b50, true); // semnătura directorului central
    inregistrareCentrala.setUint16(4, 20, true); // creat de versiunea 2.0
    inregistrareCentrala.setUint16(6, 20, true); // versiunea necesară
    inregistrareCentrala.setUint16(8, 0x0800, true);
    inregistrareCentrala.setUint16(10, metoda, true);
    inregistrareCentrala.setUint16(12, ora, true);
    inregistrareCentrala.setUint16(14, data, true);
    inregistrareCentrala.setUint32(16, crc, true);
    inregistrareCentrala.setUint32(20, continut.length, true);
    inregistrareCentrala.setUint32(24, f.date.length, true);
    inregistrareCentrala.setUint16(28, numeOcteti.length, true);
    inregistrareCentrala.setUint16(30, 0, true); // câmp suplimentar
    inregistrareCentrala.setUint16(32, 0, true); // comentariu
    inregistrareCentrala.setUint16(34, 0, true); // discul de start
    inregistrareCentrala.setUint16(36, 0, true); // atribute interne
    inregistrareCentrala.setUint32(38, 0, true); // atribute externe
    inregistrareCentrala.setUint32(42, pozitie, true); // poziția antetului local

    parti.push(new Uint8Array(antet.buffer), numeOcteti, continut);
    central.push(new Uint8Array(inregistrareCentrala.buffer), numeOcteti);
    pozitie += 30 + numeOcteti.length + continut.length;
  }

  const inceputCentral = pozitie;
  const marimeCentral = central.reduce((s, p) => s + p.length, 0);
  const final = new DataView(new ArrayBuffer(22));
  final.setUint32(0, 0x06054b50, true); // sfârșitul directorului central
  final.setUint16(4, 0, true);
  final.setUint16(6, 0, true);
  final.setUint16(8, fisiere.length, true);
  final.setUint16(10, fisiere.length, true);
  final.setUint32(12, marimeCentral, true);
  final.setUint32(16, inceputCentral, true);
  final.setUint16(20, 0, true);

  const toate = [...parti, ...central, new Uint8Array(final.buffer)];
  const total = toate.reduce((s, p) => s + p.length, 0);
  const rezultat = new Uint8Array(total);
  let o = 0;
  for (const p of toate) {
    rezultat.set(p, o);
    o += p.length;
  }
  return rezultat;
}
