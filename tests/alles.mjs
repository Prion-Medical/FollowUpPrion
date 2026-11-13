// FollowUp Prion – controles zonder browser en zonder databank.
//
//   node --experimental-strip-types tests/alles.mjs
//
// (Vanaf Node 23.6 mag de vlag weg: die leest de TypeScript van de Edge
// Functions zelf.) Geen testkader, geen pakketten: gewone Node-asserts,
// zoals CLAUDE.md het vraagt. Alles hier rekent met verzonnen gegevens.
//
// Wat het nakijkt: dat de regels die op meer dan één plaats staan nog
// overeenkomen. De databank zelf kijkt supabase/controle.sql na; dit is de
// andere helft.
//
// Elk bestand in een eigen proces: één bestand dat faalt, houdt de andere
// niet tegen, en de nagebootste Deno en fetch van het ene lopen niet door in
// het volgende.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DELEN = ["lijsten", "vertalingen", "regels", "planning", "cijfers", "samenvoegen", "agenda"];
const mislukt = [];
for (const deel of DELEN) {
  const pad = fileURLToPath(new URL(`./${deel}.mjs`, import.meta.url));
  const r = spawnSync(process.execPath, [...process.execArgv, pad], { stdio: "inherit" });
  if (r.status !== 0) mislukt.push(deel);
}
if (mislukt.length) {
  console.error(`\nmislukt: ${mislukt.join(", ")}`);
  process.exitCode = 1;
} else console.log("\nalles ok");
