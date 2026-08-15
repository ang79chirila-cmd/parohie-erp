// supabase/functions/reseteaza-mfa-utilizator/index.ts
//
// Apelat din interiorul aplicației de către rolul Administrator/preot
// paroh, pentru a debloca un alt rol (contabil/casier/pangar/auditor)
// din ACEEAȘI parohie care și-a pierdut telefonul. NU funcționează
// pentru resetarea propriului MFA al Administratorului — pentru acel
// caz nu există altă cale decât codul de recuperare tipărit al
// Administratorului însuși (sau intervenție directă în Supabase).
//
// Body așteptat: { utilizatorTintaId: string }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { utilizatorTintaId } = await req.json();
    if (!utilizatorTintaId) throw new Error("Lipsește utilizatorTintaId.");

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Lipsește autentificarea.");

    const supabaseCaller = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: callerData, error: callerErr } = await supabaseCaller.auth.getUser();
    if (callerErr || !callerData?.user) throw new Error("Utilizator neautentificat.");

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // 1. Verifică rolul apelantului — trebuie să fie administrator/preot
    //    (ajustează numele coloanelor/valorilor dacă diferă în schema reală)
    const { data: caller, error: errCallerRow } = await supabaseAdmin
      .from("utilizatori")
      .select("rol, parohie_id")
      .eq("id", callerData.user.id)
      .single();
    if (errCallerRow || !caller) throw new Error("Contul apelant nu a fost găsit.");
    if (!["administrator", "preot"].includes(caller.rol)) {
      throw new Error("Doar Administratorul parohiei poate reseta MFA altor conturi.");
    }

    // 2. Verifică că ținta e din ACEEAȘI parohie (izolare strictă)
    const { data: tinta, error: errTinta } = await supabaseAdmin
      .from("utilizatori")
      .select("rol, parohie_id")
      .eq("id", utilizatorTintaId)
      .single();
    if (errTinta || !tinta) throw new Error("Contul țintă nu a fost găsit.");
    if (tinta.parohie_id !== caller.parohie_id) {
      throw new Error("Nu poți reseta MFA pentru un cont din altă parohie.");
    }
    if (utilizatorTintaId === callerData.user.id) {
      throw new Error(
        "Administratorul nu își poate reseta propriul MFA prin această funcție — folosește codul de recuperare tipărit."
      );
    }

    // 3. Șterge toți factorii TOTP ai țintei
    const { data: factori, error: errFactori } =
      await supabaseAdmin.auth.admin.mfa.listFactors({ userId: utilizatorTintaId });
    if (errFactori) throw errFactori;

    for (const f of factori.factors ?? []) {
      await supabaseAdmin.auth.admin.mfa.deleteFactor({
        id: f.id,
        userId: utilizatorTintaId,
      });
    }

    // 4. Invalidează și codul de recuperare vechi al țintei — se va genera
    //    unul nou automat la următoarea reînrolare
    await supabaseAdmin
      .from("coduri_recuperare_mfa")
      .update({ folosit: true, folosit_la: new Date().toISOString() })
      .eq("utilizator_id", utilizatorTintaId)
      .eq("folosit", false);

    return new Response(
      JSON.stringify({
        succes: true,
        factoriStersi: factori.factors?.length ?? 0,
        mesaj: `Utilizatorul se poate reînrola cu un telefon nou la următorul login.`,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 400,
    });
  }
});
