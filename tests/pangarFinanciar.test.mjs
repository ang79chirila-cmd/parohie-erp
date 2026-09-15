// tests/pangarFinanciar.test.mjs
//
// Rulează cu: node --test tests/
// Nu are nicio dependință externă — folosește doar test runner-ul inclus în Node (node:test) și
// modulul de assert inclus (node:assert) — nimic de instalat, rulează identic local și în CI.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeazaPlati,
  esteAchitareValida,
  calculeazaLiniiCuRest,
  construiesteLiniiAchitare,
  ultimaZiCalendaristica,
  formateazaCantitate,
} from "../pangarFinanciar.mjs";

describe("normalizeazaPlati", () => {
  test("elimină sursele cu sumă zero sau neglijabilă", () => {
    const { platiValide, suma } = normalizeazaPlati([
      { modPlata: "transfer", suma: "200.33" },
      { modPlata: "numerar", suma: "0" },
    ]);
    assert.equal(platiValide.length, 1);
    assert.equal(platiValide[0].modPlata, "transfer");
    assert.equal(suma, 200.33);
  });

  test("rotunjește corect la bani, chiar cu erori de virgulă mobilă", () => {
    const { suma } = normalizeazaPlati([{ modPlata: "transfer", suma: 0.1 + 0.2 }]); // 0.30000000000000004 în JS
    assert.equal(suma, 0.3);
  });

  test("plată mixtă — suma totală e exact suma celor două surse", () => {
    const { platiValide, suma } = normalizeazaPlati([
      { modPlata: "transfer", suma: 200.33 },
      { modPlata: "numerar", suma: 100.1 },
    ]);
    assert.equal(platiValide.length, 2);
    assert.equal(suma, 300.43);
  });
});

describe("esteAchitareValida", () => {
  test("respinge o sumă mai mare decât restul de plată", () => {
    assert.equal(esteAchitareValida([{ modPlata: "transfer", suma: 100 }], 100, 50), false);
  });
  test("respinge o listă de plăți goală", () => {
    assert.equal(esteAchitareValida([], 0, 50), false);
  });
  test("acceptă o achitare integrală exactă", () => {
    assert.equal(esteAchitareValida([{ modPlata: "transfer", suma: 50 }], 50, 50), true);
  });
  test("acceptă o depășire neglijabilă de rotunjire (o sutime de leu)", () => {
    assert.equal(esteAchitareValida([{ modPlata: "transfer", suma: 50.01 }], 50.01, 50), true);
  });
});

describe("calculeazaLiniiCuRest", () => {
  const categoriiPangar = { lumanari: { achizitie: "672.01.01" }, vin: { achizitie: "672.01.03.02" } };

  test("fără plăți anterioare, restul e valoarea totală a fiecărei categorii", () => {
    const rezultat = calculeazaLiniiCuRest({
      liniiAchizitie: [{ categorieBVC: "lumanari", suma: 600 }, { categorieBVC: "vin", suma: 400 }],
      platiExistente: [],
      categoriiPangar,
    });
    assert.deepEqual(rezultat, [{ contId: "672.01.01", rest: 600 }, { contId: "672.01.03.02", rest: 400 }]);
  });

  test("scade corect o plată parțială deja făcută pe o singură categorie", () => {
    const rezultat = calculeazaLiniiCuRest({
      liniiAchizitie: [{ categorieBVC: "lumanari", suma: 600 }, { categorieBVC: "vin", suma: 400 }],
      platiExistente: [{ liniiPeCont: [{ contId: "672.01.01", suma: 200 }] }],
      categoriiPangar,
    });
    assert.deepEqual(rezultat, [{ contId: "672.01.01", rest: 400 }, { contId: "672.01.03.02", rest: 400 }]);
  });

  test("o categorie complet achitată dispare din listă (rest ~0, exclusă)", () => {
    const rezultat = calculeazaLiniiCuRest({
      liniiAchizitie: [{ categorieBVC: "lumanari", suma: 600 }, { categorieBVC: "vin", suma: 400 }],
      platiExistente: [{ liniiPeCont: [{ contId: "672.01.01", suma: 600 }] }],
      categoriiPangar,
    });
    assert.deepEqual(rezultat, [{ contId: "672.01.03.02", rest: 400 }]);
  });

  test("cazul defensiv (fără liniiAchizitie) folosește contul/suma de rezervă", () => {
    const rezultat = calculeazaLiniiCuRest({
      liniiAchizitie: [],
      platiExistente: [],
      categoriiPangar,
      contIdFallback: "672.01.01",
      sumaRamasaCurenta: 123.45,
    });
    assert.deepEqual(rezultat, [{ contId: "672.01.01", rest: 123.45 }]);
  });
});

describe("construiesteLiniiAchitare", () => {
  test("o singură sursă, achitare integrală — o linie per categorie, sumă exactă", () => {
    const liniiCuRest = [{ contId: "A", rest: 600.13 }, { contId: "B", rest: 400.87 }];
    const linii = construiesteLiniiAchitare({
      liniiCuRest,
      suma: 1001,
      sumaRamasaCurenta: 1001,
      platiValide: [{ modPlata: "transfer", suma: 1001 }],
      explicatie: "test",
    });
    assert.deepEqual(linii, [
      { contId: "A", suma: 600.13, modPlata: "transfer", explicatie: "test" },
      { contId: "B", suma: 400.87, modPlata: "transfer", explicatie: "test" },
    ]);
    const total = linii.reduce((s, l) => s + l.suma, 0);
    assert.equal(Math.round(total * 100) / 100, 1001);
  });

  test("plată mixtă (bancă + casă), parțială, cu zecimale — totalul liniilor e exact suma cerută", () => {
    // Exact scenariul verificat manual în conversație: NRCD cu 2 categorii (600.13 + 400.87 =
    // 1001.00), plătit parțial cu 300.43 lei (200.33 din bancă + 100.10 din casă).
    const liniiCuRest = [{ contId: "A", rest: 600.13 }, { contId: "B", rest: 400.87 }];
    const platiValide = [{ modPlata: "transfer", suma: 200.33 }, { modPlata: "numerar", suma: 100.1 }];
    const suma = 300.43;
    const linii = construiesteLiniiAchitare({ liniiCuRest, suma, sumaRamasaCurenta: 1001, platiValide, explicatie: "mixt" });

    // Patru linii — câte una per (categorie x sursă).
    assert.equal(linii.length, 4);

    // Totalul general e exact suma cerută, la bănuț.
    const total = Math.round(linii.reduce((s, l) => s + l.suma, 0) * 100) / 100;
    assert.equal(total, 300.43);

    // Totalul PE FIECARE SURSĂ (indiferent de categorie) e exact ce a introdus utilizatorul —
    // partea cea mai importantă de verificat: banii nu se "pierd" și nu se amestecă între surse.
    const totalPeMod = {};
    for (const l of linii) totalPeMod[l.modPlata] = Math.round(((totalPeMod[l.modPlata] || 0) + l.suma) * 100) / 100;
    assert.equal(totalPeMod.transfer, 200.33);
    assert.equal(totalPeMod.numerar, 100.1);

    // Totalul PE FIECARE CATEGORIE (indiferent de sursă) respectă proporția restului rămas.
    const totalPeCont = {};
    for (const l of linii) totalPeCont[l.contId] = Math.round(((totalPeCont[l.contId] || 0) + l.suma) * 100) / 100;
    const asteptatA = Math.round(suma * (600.13 / 1001) * 100) / 100;
    assert.equal(totalPeCont.A, asteptatA);
  });

  test("o categorie cu rest neglijabil (sub jumătate de bănuț) e omisă din rezultat", () => {
    const liniiCuRest = [{ contId: "A", rest: 100 }, { contId: "B", rest: 0.001 }];
    const linii = construiesteLiniiAchitare({
      liniiCuRest, suma: 100, sumaRamasaCurenta: 100.001,
      platiValide: [{ modPlata: "transfer", suma: 100 }], explicatie: "x",
    });
    assert.equal(linii.length, 1);
    assert.equal(linii[0].contId, "A");
  });

  test("plată mixtă cu 3 surse — totalul fiecărei surse rămâne exact, indiferent de numărul de categorii", () => {
    const liniiCuRest = [{ contId: "A", rest: 300 }, { contId: "B", rest: 200 }, { contId: "C", rest: 100 }];
    const platiValide = [
      { modPlata: "transfer", suma: 250.25 },
      { modPlata: "numerar", suma: 125.13 },
      { modPlata: "depozit", suma: 24.62 },
    ];
    const suma = 400;
    const linii = construiesteLiniiAchitare({ liniiCuRest, suma, sumaRamasaCurenta: 600, platiValide, explicatie: "3surse" });
    const totalPeMod = {};
    for (const l of linii) totalPeMod[l.modPlata] = Math.round(((totalPeMod[l.modPlata] || 0) + l.suma) * 100) / 100;
    assert.equal(totalPeMod.transfer, 250.25);
    assert.equal(totalPeMod.numerar, 125.13);
    assert.equal(totalPeMod.depozit, 24.62);
  });
});

describe("ultimaZiCalendaristica", () => {
  const cazuri = [
    [2025, 1, "2025-01-31"],
    [2025, 2, "2025-02-28"],
    [2024, 2, "2024-02-29"], // an bisect
    [2025, 4, "2025-04-30"],
    [2025, 11, "2025-11-30"],
    [2025, 12, "2025-12-31"], // decembrie — nu trebuie să "sară" în ianuarie anul următor
  ];
  for (const [an, luna, asteptat] of cazuri) {
    test(`${an}-${String(luna).padStart(2, "0")} → ${asteptat}`, () => {
      assert.equal(ultimaZiCalendaristica(an, luna), asteptat);
    });
  }
});

describe("formateazaCantitate", () => {
  test("elimină complet zecimalele unei valori întregi", () => {
    assert.equal(formateazaCantitate(35), "35");
  });
  test("rotunjește o valoare cu zecimale reale", () => {
    assert.equal(formateazaCantitate(35.6), "36");
  });
  test("corectează un șir de forma unei coloane Postgres cu scală fixă (bug-ul deja reparat)", () => {
    assert.equal(formateazaCantitate("35.000"), "35");
  });
  test("formatează miile cu punct, stil românesc, fără nicio zecimală", () => {
    assert.equal(formateazaCantitate(12345), "12.345");
  });
});
