-- ============================================================
-- Coloană nouă pe `parohii` pentru datele care nu au fost încă
-- migrate individual pe tabele proprii (Date parohie, exerciții
-- financiare, jurnal audit, tarife cimitir, nomenclator conturi
-- BVC, contoare, Consum intern nomenclator+mișcări, bonuri consum).
-- ============================================================

alter table parohii
  add column if not exists date_locale jsonb not null default '{}'::jsonb;

-- Politică RLS explicită pentru actualizare: fără ea, salvarea din aplicație
-- va eșua tăcut (RLS blochează UPDATE-ul) dacă nu exista deja o politică
-- UPDATE generală pe `parohii`. Presupune că funcția `parohia_curenta()`
-- (deja folosită în aplicație pentru alte politici) întoarce parohie_id-ul
-- contului logat — dacă numele/semnătura reală diferă, spune-mi și corectez.
-- (PostgreSQL nu are "CREATE POLICY IF NOT EXISTS" — verificăm manual.)
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'parohii'
      and policyname = 'utilizator actualizeaza date_locale propria parohie'
  ) then
    create policy "utilizator actualizeaza date_locale propria parohie"
      on parohii for update
      using (id = parohia_curenta())
      with check (id = parohia_curenta());
  end if;
end $$;

-- Verificare rapidă după rulare:
select cif, denumire, date_locale
from parohii
order by cif;
