/* Supabase-instellingen / Supabase settings.
 *
 * Leeg = lokale opslag via server.py (data/db.json).
 * Empty = local storage through server.py (data/db.json).
 *
 * Online zetten? Maak een project op supabase.com, voer supabase/schema.sql uit,
 * maak een gebruiker aan onder Authentication → Users, en vul hieronder de
 * Project URL en de "anon public" / publishable sleutel in. Die sleutel mag
 * publiek staan: de databank laat enkel aangemelde gebruikers toe.
 */
window.FOLLOWUP_CONFIG = {
  supabaseUrl: "",
  supabaseAnonKey: "",
};
