/* Licht of donker. Staat in de <head> en niet onderaan bij de rest: zo weet de
 * pagina haar kleur vóór ze iets tekent en flitst ze niet eerst wit op.
 * Een eigen bestandje omdat de CSP geen script in de pagina zelf toelaat.
 *
 * De keuze is "system", "light" of "dark" en zit in localStorage. Op <html>
 * staat altijd wat het geworden is (data-theme="light" of "dark"), zodat
 * styles.css maar één regel nodig heeft en niet twee keer dezelfde kleuren.
 */
window.FollowUpTheme = (() => {
  "use strict";
  const KEY = "followup-theme";
  const dark = window.matchMedia("(prefers-color-scheme: dark)");
  const read = () => {
    try {
      const v = localStorage.getItem(KEY);
      return v === "light" || v === "dark" ? v : "system";
    } catch (e) { return "system"; } // privévenster
  };
  let choice = read();
  const apply = () => {
    const theme = choice === "system" ? (dark.matches ? "dark" : "light") : choice;
    document.documentElement.dataset.theme = theme;
    // De kleur van de balk van de browser of het toestel volgt het paneel.
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === "dark" ? "#16181d" : "#ffffff";
  };
  // Wisselt het toestel zelf (zonsondergang), dan volgt "system" meteen.
  dark.addEventListener("change", apply);
  // Niet elke browser meldt die wissel aan een tabblad dat op de achtergrond
  // stond; bij het terugkomen kijken we dus nog eens. Kost niets.
  document.addEventListener("visibilitychange", apply);
  window.addEventListener("focus", apply);
  apply();
  return {
    get: () => choice,
    set(v) {
      choice = v === "light" || v === "dark" ? v : "system";
      try {
        if (choice === "system") localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, choice);
      } catch (e) { /* privévenster */ }
      apply();
    },
  };
})();
