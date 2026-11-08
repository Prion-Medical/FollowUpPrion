/* Supabase-instellingen / Supabase settings.
 *
 * Twee databanken, één bestand. Localhost praat met de ontwikkeldatabank, de
 * gepubliceerde app altijd met de echte: welke van de twee het wordt, beslist
 * de hostnaam hieronder en niet de tak waarop je staat. Zo kan een deploy de
 * ontwikkelsleutel niet meenemen en valt er bij een merge niets te schrappen.
 *
 * Two databases, one file. Localhost talks to the development database, the
 * published app always to the real one.
 *
 * Nieuw project opzetten? Maak het op supabase.com, voer supabase/schema.sql
 * uit, zet aanmelden uit onder Authentication, maak de gebruikers met de hand
 * en vul hieronder de Project URL en de "anon public" / publishable sleutel in.
 * Die sleutels mogen publiek staan: de databank laat enkel aangemelde
 * gebruikers toe, en wat iemand mag staat in app_users.
 */
(() => {
  "use strict";

  // De echte databank: wat op GitHub Pages staat, werkt hierop.
  const PRODUCTIE = {
    supabaseUrl: "https://hpkmobbfcryygtxgjvlu.supabase.co",
    supabaseAnonKey: "sb_publishable_yr3JMrwWdwLaPLprTOKZOQ_2fW_U2OV",
  };

  // De ontwikkeldatabank: een tweede Supabase-project met verzonnen gegevens.
  // Nooit een export uit de echte databank hierin: dit project is niet de
  // plaats voor namen en nummers van echte artsen.
  //
  // Staan de twee regels hieronder in commentaar, dan is er op localhost geen
  // Supabase en werkt de app op data/db.json via server.py.
  const ONTWIKKEL = {
    supabaseUrl: "https://fdlyaljnusmylywtptfn.supabase.co",
    supabaseAnonKey: "sb_publishable_y2Sh-_H2_x2Wn6jVEZ2tBA_tfUMx6kv",

    // Zonder Supabase is er geen login. Zet hier je naam als je wil dat die
    // bij je contactmomenten komt te staan; laat het weg en de stempel blijft
    // leeg. Met Supabase komt de naam uit het gebruikersbeheer en doet dit
    // niets.
    // localUser: "Dante",
  };

  // Welke van de twee. Alleen op je eigen computer de ontwikkeldatabank: wat
  // GitHub Pages uitlevert draait per definitie niet op localhost en krijgt
  // dus de echte, op welke tak dit bestand ook staat. Een leeg location.host
  // is een bestand dat rechtstreeks geopend werd (file://) — ook niet de
  // echte databank.
  const LOKAAL = ["localhost", "127.0.0.1", "[::1]", ""];
  window.FOLLOWUP_CONFIG = LOKAAL.includes(location.hostname) ? ONTWIKKEL : PRODUCTIE;
})();
