// supabase/functions/genereaza-cod-recuperare/index.ts
//
// Apelat de utilizator (autentificat) imediat după ce a confirmat
// înrolarea TOTP. Generează un cod format XXXX-XXXX-XXXX (necesar de
// tipărit), îl returnează O SINGURĂ DATĂ în clar, și salvează doar
// hash-ul lui în tabel. Orice cod vechi nefolosit al aceluiași
// utilizator e invalidat automat (un singur cod activ per cont).

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function genereazaCodAleator(): string {
  const alfabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // fără O/0, I/1 confuze
  const bloc = () =>
    Array.from({ length: 4 }, () =>
      alfabet[Math.floor(crypto.getRandomValues(new Uint32Array(1))[0] / (0xffffffff / alfabet.length))]
    ).join("");
  return `${bloc()}-${bloc()}-${bloc()}`;
}

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

    const cod = genereazaCodAleator();
    const codHash = await sha256Hex(cod);

    // invalidează orice cod vechi nefolosit al acestui utilizator
    await supabaseAdmin
      .from("coduri_recuperare_mfa")
      .update({ folosit: true, folosit_la: new Date().toISOString() })
      .eq("utilizator_id", userData.user.id)
      .eq("folosit", false);

    const { error: insErr } = await supabaseAdmin
      .from("coduri_recuperare_mfa")
      .insert({ utilizator_id: userData.user.id, cod_hash: codHash });
    if (insErr) throw insErr;

    return new Response(JSON.stringify({ cod }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 400,
    });
  }
});
