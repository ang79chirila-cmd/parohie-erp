// supabase/functions/foloseste-cod-recuperare/index.ts
//
// Apelat când utilizatorul și-a pierdut telefonul (nu mai poate genera
// cod TOTP) dar are codul de recuperare tipărit. Necesită totuși login
// reușit cu CIF+user+parolă înainte (acesta e doar al doilea factor) —
// codul de recuperare NU înlocuiește parola.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { cod } = await req.json();
    if (!cod || typeof cod !== "string") throw new Error("Cod lipsă sau invalid.");

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Lipsește autentificarea.");

    const supabaseUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: userData, error: userErr } = await supabaseUser.auth.getUser();
    if (userErr || !userData?.user) throw new Error("Utilizator neautentificat.");

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const codHash = await sha256Hex(cod.trim().toUpperCase());

    const { data: randCod, error: errCod } = await supabaseAdmin
      .from("coduri_recuperare_mfa")
      .select("id")
      .eq("utilizator_id", userData.user.id)
      .eq("cod_hash", codHash)
      .eq("folosit", false)
      .maybeSingle();
    if (errCod) throw errCod;
    if (!randCod) throw new Error("Cod de recuperare invalid sau deja folosit.");

    // marchează codul ca folosit — devine inutilizabil imediat
    await supabaseAdmin
      .from("coduri_recuperare_mfa")
      .update({ folosit: true, folosit_la: new Date().toISOString() })
      .eq("id", randCod.id);

    // șterge factorii TOTP existenți ai utilizatorului (telefonul pierdut)
    // ca să se poată reînrola imediat cu un telefon nou
    const { data: factori, error: errFactori } =
      await supabaseAdmin.auth.admin.mfa.listFactors({ userId: userData.user.id });
    if (errFactori) throw errFactori;

    for (const f of factori.factors ?? []) {
      await supabaseAdmin.auth.admin.mfa.deleteFactor({
        id: f.id,
        userId: userData.user.id,
      });
    }

    return new Response(
      JSON.stringify({ succes: true, factoriStersi: factori.factors?.length ?? 0 }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 400,
    });
  }
});
