import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  yearOf,
  soldCasaBancaLaAn,
  soldCasaBancaLaData,
  esteSumaFormatata,
  parseSumaFormatata,
  pasGrilaNatural,
} from "../src/jurnalFinanciar.mjs";

describe("yearOf", () => {
  test("extrage anul dintr-o dată AAAA-LL-ZZ", () => {
    assert.equal(yearOf("2026-03-15"), 2026);
  });
});

describe("soldCasaBancaLaAn — REGRESIE: depozit dublat la trecerea dintre ani", () => {
  // Reconstituie exact cazul real găsit în producție: 5.400.000 RON depozit, construiți organic
  // în 2025 (linii reale de intrare), apoi reportați printr-o singură linie nouă la 01.01.2026
  // ("Depozite bancare la 31.12.2025"). Soldul anului 2026 trebuie să arate 5.400.000, NU
  // 10.800.000 (dublu) — bug-ul era cumularea peste granița de an.
  const operatiuni = [
    // 2025: opt intrări reale, în depozit, care construiesc organic 5.400.000 pe parcursul anului.
    { an: 2025, data: "2025-02-01", tip: "incasare", suma: 2000000, modPlata: "depozit" },
    { an: 2025, data: "2025-06-01", tip: "incasare", suma: 3400000, modPlata: "depozit" },
    // 2026: linia de reportare (Chitanța nr. 1/2026) — restatează soldul de la 31.12.2025.
    { an: 2026, data: "2026-01-01", tip: "incasare", suma: 5400000, modPlata: "depozit" },
    // 2026: o mișcare reală, suplimentară, ca anul să nu fie doar linia de reportare.
    { an: 2026, data: "2026-03-10", tip: "plata", suma: 100000, modPlata: "depozit" },
  ];

  test("soldul anului 2025 e corect (5.400.000, doar din tranzacțiile organice)", () => {
    const { soldDepozit } = soldCasaBancaLaAn(operatiuni, 2025);
    assert.equal(soldDepozit, 5400000);
  });

  test("soldul anului 2026 NU dublează depozitul reportat (5.300.000, nu 10.700.000/10.800.000)", () => {
    const { soldDepozit } = soldCasaBancaLaAn(operatiuni, 2026);
    assert.equal(soldDepozit, 5300000); // 5.400.000 (reportat) - 100.000 (plată reală din 2026)
  });

  test("soldul anului 2026, luat separat, nu ajunge niciodată la dublul depozitului reportat", () => {
    const { soldDepozit: sold2026 } = soldCasaBancaLaAn(operatiuni, 2026);
    // Dacă bug-ul ar reapărea (cumulare prin toți anii), sold2026 ar include și cei 5.400.000 din
    // 2025 peste linia de reportare — adică 10.700.000, nu 5.300.000.
    assert.notEqual(sold2026, 10700000);
    assert.equal(sold2026, 5300000);
  });

  test("filtrează strict după op.an (numerotare), NU după anul calendaristic al op.data", () => {
    // Document numerotat "1/2026" dar cu dată efectivă în decembrie 2025 — trebuie să intre în
    // soldul anului 2026 (după `an`), nu 2025 (după dată) — criteriu identic cu Registrul Jurnal.
    const opsCuDecalaj = [{ an: 2026, data: "2025-12-20", tip: "incasare", suma: 500, modPlata: "numerar" }];
    assert.equal(soldCasaBancaLaAn(opsCuDecalaj, 2026).soldCasa, 500);
    assert.equal(soldCasaBancaLaAn(opsCuDecalaj, 2025).soldCasa, 0);
  });

  test("distribuie corect pe Casă/Bancă/Depozit, cu semn +/- după tip", () => {
    const ops = [
      { an: 2026, data: "2026-01-05", tip: "incasare", suma: 1000, modPlata: "numerar" },
      { an: 2026, data: "2026-01-06", tip: "plata", suma: 300, modPlata: "numerar" },
      { an: 2026, data: "2026-01-07", tip: "incasare", suma: 2000, modPlata: "transfer" },
      { an: 2026, data: "2026-01-08", tip: "incasare", suma: 500, modPlata: "depozit" },
    ];
    const sold = soldCasaBancaLaAn(ops, 2026);
    assert.equal(sold.soldCasa, 700);
    assert.equal(sold.soldBanca, 2000);
    assert.equal(sold.soldDepozit, 500);
  });
});

describe("soldCasaBancaLaData — aceeași regresie, pe dată exactă (Reconciliere bancară)", () => {
  const operatiuni = [
    { an: 2025, data: "2025-06-01", tip: "incasare", suma: 5400000, modPlata: "depozit" },
    { an: 2026, data: "2026-01-01", tip: "incasare", suma: 5400000, modPlata: "depozit" },
  ];

  test("la o dată din 2026, nu cumulează și tranzacția din 2025", () => {
    const { soldDepozit } = soldCasaBancaLaData(operatiuni, "2026-06-30");
    assert.equal(soldDepozit, 5400000); // nu 10.800.000
  });

  test("la o dată din 2025, vede doar tranzacția din 2025", () => {
    const { soldDepozit } = soldCasaBancaLaData(operatiuni, "2025-12-31");
    assert.equal(soldDepozit, 5400000);
  });

  test("respectă limita de dată în interiorul aceluiași an (nu vede tranzacții ulterioare)", () => {
    const ops = [
      { an: 2026, data: "2026-01-10", tip: "incasare", suma: 100, modPlata: "numerar" },
      { an: 2026, data: "2026-01-20", tip: "incasare", suma: 200, modPlata: "numerar" },
    ];
    assert.equal(soldCasaBancaLaData(ops, "2026-01-15").soldCasa, 100);
    assert.equal(soldCasaBancaLaData(ops, "2026-01-25").soldCasa, 300);
  });
});

describe("esteSumaFormatata / parseSumaFormatata — REGRESIE: NaN la viramente în XLSX", () => {
  test("recunoaște o sumă formatată obișnuită", () => {
    assert.equal(esteSumaFormatata("1.234,00"), true);
  });

  test("recunoaște forma cu paranteze (sumă negativă, viramente 581/5081)", () => {
    assert.equal(esteSumaFormatata("(1.234,00)"), true);
  });

  test("respinge text obișnuit (cod, denumire, dată)", () => {
    assert.equal(esteSumaFormatata("PROT4"), false);
    assert.equal(esteSumaFormatata("15.03.2026"), false);
  });

  test("conversie obișnuită, pozitivă", () => {
    assert.equal(parseSumaFormatata("1.234,00"), 1234);
  });

  test("conversie cu paranteze — NU mai dă NaN (bug-ul reparat), dă numărul negativ corect", () => {
    const rezultat = parseSumaFormatata("(1.234,00)");
    assert.equal(Number.isNaN(rezultat), false);
    assert.equal(rezultat, -1234);
  });

  test("conversie cu paranteze, sumă mică (fără separator de mii)", () => {
    assert.equal(parseSumaFormatata("(45,50)"), -45.5);
  });

  test("text care nu e sumă formatată rămâne neatins (nu forțează o conversie greșită)", () => {
    assert.equal(parseSumaFormatata("PROT4 340574"), "PROT4 340574");
  });
});

describe("pasGrilaNatural", () => {
  test("alege un pas rotund, din familia 1/2/5 × 10^n", () => {
    const pas = pasGrilaNatural(1000);
    const exponent = Math.floor(Math.log10(pas));
    const normalizat = pas / Math.pow(10, exponent);
    assert.ok([1, 2, 5].includes(Math.round(normalizat)));
  });

  test("niciodată zero sau negativ pentru o maximă pozitivă", () => {
    assert.ok(pasGrilaNatural(5400000) > 0);
    assert.ok(pasGrilaNatural(1) > 0);
  });
});
