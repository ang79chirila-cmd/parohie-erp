// pangarFinanciar.mjs
//
// Logica financiară "pură" a aplicației — fără nicio dependință de React, Supabase sau stare
// locală — extrasă din ParohieERP.jsx și supabaseData.js exact ca să poată fi testată automat,
// izolat, fără să pornească aplicația întreagă. Fiecare funcție de aici e folosită DIRECT din
// cele două fișiere mari (nu e o copie separată care ar putea "aluneca" în timp, necorelată cu
// codul real) — vezi tests/pangarFinanciar.test.mjs pentru testele care o verifică.

/**
 * Normalizează o listă de plăți introduse de utilizator (ex. [{modPlata:"transfer", suma:"100"}])
 * — rotunjește fiecare sumă la bani (2 zecimale) și elimină intrările neglijabile (sub o jumătate
 * de leu, practic zero, rezultate din erori de rotunjire). Întoarce și suma lor totală, la fel
 * rotunjită.
 */
export function normalizeazaPlati(plati) {
  const platiValide = (plati || [])
    .map((p) => ({ modPlata: p.modPlata, suma: Math.round(Number(p.suma) * 100) / 100 }))
    .filter((p) => p.suma > 0.004);
  const suma = Math.round(platiValide.reduce((s, p) => s + p.suma, 0) * 100) / 100;
  return { platiValide, suma };
}

/**
 * O achitare (parțială sau integrală) e validă doar dacă: există cel puțin o sursă de plată cu
 * sumă pozitivă, suma totală e pozitivă, și nu depășește restul de plată curent (cu o marjă de
 * o sutime de leu, ca să nu respingă o achitare integrală din cauza unei rotunjiri de-o zecime
 * de bănuț).
 */
export function esteAchitareValida(platiValide, suma, sumaRamasaCurenta) {
  return platiValide.length > 0 && suma > 0 && suma <= sumaRamasaCurenta + 0.01;
}

/**
 * Restul de plată rămas pe fiecare categorie bugetară a unei facturi (NRCD), după toate plățile
 * parțiale deja făcute pe ea — necesar ca o achitare NOUĂ să distribuie suma introdusă proporțional
 * cu ce mai e de plată pe fiecare categorie (nu cu valoarea ei totală inițială, care poate fi deja
 * parțial acoperită de-o plată anterioară).
 *
 * @param liniiAchizitie  [{categorieBVC, suma}] — valoarea totală inițială pe fiecare categorie.
 * @param platiExistente  [{liniiPeCont: [{contId, suma}]}] — plățile deja făcute pe factură.
 * @param categoriiPangar CATEGORII_PANGAR — mapează categorieBVC -> {achizitie: contId, ...}.
 * @param contIdFallback  cont de rezervă, dacă liniiAchizitie e goală (caz defensiv, rar).
 * @param categorieBVCFallback  la fel, categorie de rezervă pentru cazul defensiv.
 * @param sumaRamasaCurenta  restul total de plată — folosit doar în cazul defensiv (o singură linie).
 */
export function calculeazaLiniiCuRest({ liniiAchizitie, platiExistente, categoriiPangar, contIdFallback, categorieBVCFallback, sumaRamasaCurenta }) {
  const platitPeCont = {};
  for (const p of platiExistente || []) {
    for (const l of p.liniiPeCont || []) {
      platitPeCont[l.contId] = (platitPeCont[l.contId] || 0) + l.suma;
    }
  }
  return liniiAchizitie && liniiAchizitie.length > 0
    ? liniiAchizitie
        .map((l) => {
          const contId = categoriiPangar[l.categorieBVC]?.achizitie || contIdFallback;
          const rest = l.suma - (platitPeCont[contId] || 0);
          return { contId, rest };
        })
        .filter((l) => l.rest > 0.005)
    : [{ contId: contIdFallback || categoriiPangar[categorieBVCFallback]?.achizitie, rest: sumaRamasaCurenta }];
}

/**
 * Construiește liniile finale ale unui Ordin de plată de achitare — suma introdusă se distribuie
 * ÎNTÂI proporțional cu restul rămas pe fiecare categorie bugetară (ultima categorie absoarbe
 * diferența de rotunjire), APOI, dacă plata e mixtă (mai multe surse — ex. casă + bancă), fiecare
 * parte de categorie se re-împarte proporțional cu raportul dintre surse (ultima sursă absoarbe
 * rotunjirea, de data asta în interiorul categoriei) — ca totalul liniilor să fie mereu EXACT suma
 * introdusă, atât pe fiecare categorie cât și pe fiecare sursă, niciodată doar aproximativ egal.
 */
export function construiesteLiniiAchitare({ liniiCuRest, suma, sumaRamasaCurenta, platiValide, explicatie }) {
  let alocatCategorie = 0;
  const linii = [];
  liniiCuRest.forEach((l, idx) => {
    const esteUltimaCategorie = idx === liniiCuRest.length - 1;
    const parteCategorie = esteUltimaCategorie
      ? Math.round((suma - alocatCategorie) * 100) / 100
      : Math.round((suma * (l.rest / sumaRamasaCurenta)) * 100) / 100;
    alocatCategorie += parteCategorie;
    if (parteCategorie <= 0.004) return;

    if (platiValide.length === 1) {
      linii.push({ contId: l.contId, suma: parteCategorie, modPlata: platiValide[0].modPlata, explicatie });
      return;
    }
    let alocatSursa = 0;
    platiValide.forEach((p, pidx) => {
      const esteUltimaSursa = pidx === platiValide.length - 1;
      const parteSursa = esteUltimaSursa
        ? Math.round((parteCategorie - alocatSursa) * 100) / 100
        : Math.round((parteCategorie * (p.suma / suma)) * 100) / 100;
      alocatSursa += parteSursa;
      if (parteSursa <= 0.004) return;
      linii.push({ contId: l.contId, suma: parteSursa, modPlata: p.modPlata, explicatie });
    });
  });
  return linii;
}

/**
 * Ultima zi calendaristică a unei luni date (luna: 1=ianuarie ... 12=decembrie), ca șir ISO
 * (aaaa-ll-zz) — corect inclusiv pentru februarie, în orice an, bisect sau nu.
 */
export function ultimaZiCalendaristica(an, luna) {
  return new Date(Date.UTC(an, luna, 0)).toISOString().slice(0, 10);
}

/**
 * Formatează o cantitate (unități de măsură — buc., kg) STRICT FĂRĂ NICIO ZECIMALĂ, stil
 * românesc — 35 rămâne "35", nu "35.000" sau "35,000" (semnătura unei coloane numerice din
 * Postgres cu scală fixă, citită fără conversie explicită) — niciodată confundabilă cu o sumă de
 * bani sau cu o valoare de mii.
 */
export function formateazaCantitate(n) {
  return Math.round(Number(n)).toLocaleString("ro-RO");
}
