// parohieDateLocale.js
//
// Modul nou, de sine stătător (ca mfaHelpers.js) — nu atinge supabaseData.js.
//
// Motiv: câteva bucăți din starea aplicației (datele parohiei/"Date parohie",
// exercițiile financiare, jurnalul de audit, tarifele de cimitir, nomenclatorul
// de conturi BVC, contoarele, articolele/mișcările de Consum intern, bonurile
// de consum) nu au fost NICIODATĂ migrate individual pe tabele Supabase —
// existau doar în memorie, ținute între sesiuni exclusiv prin persistența
// locală (window.storage) care tocmai a fost eliminată. Rezultat: aceste date
// se pierdeau la orice reîncărcare a paginii ("Date parohie" cerut la loc).
//
// Soluție: o singură coloană JSONB nouă pe tabelul `parohii` (`date_locale`),
// care ține toate aceste bucăți împreună, per parohie — același tipar deja
// folosit în aplicație pentru `inventarieri_patrimoniu.bunuri` (jsonb).

import { supabase } from "./supabaseClient";

export async function getDateLocaleParohie(parohieId) {
  const { data, error } = await supabase
    .from("parohii")
    .select("date_locale")
    .eq("id", parohieId)
    .maybeSingle();
  if (error) throw error;
  return data?.date_locale || {};
}

export async function salveazaDateLocaleParohie(parohieId, dateLocale) {
  const { error } = await supabase
    .from("parohii")
    .update({ date_locale: dateLocale })
    .eq("id", parohieId);
  if (error) throw error;
}
