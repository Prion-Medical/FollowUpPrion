# FollowUp Prion

Opvolging van de verkoop van **EndoQ** (ScopeWatch) en **Ainex** (ENAD) in de Benelux:
een kaart met alle ziekenhuizen, zoeken op naam, en per ziekenhuis een fiche met status,
contactpersonen, contactmomenten en de gegevens van de endoscopie-afdeling.

De app is tweetalig — **Nederlands / English** — met de knop rechtsboven.

*Follow-up of EndoQ and Ainex sales across the Benelux: a map of all hospitals, search by
name, and per hospital a record with status, contacts, contact moments and endoscopy unit
details. Bilingual (Dutch / English) via the button at the top right.*

## Starten

Geen installatie nodig, enkel Python 3 (staat standaard op je Mac).

- **Dubbelklik** op `start.command`, of
- in de terminal: `python3 server.py`, of
- in VS Code: Run and Debug → "FollowUp Prion starten".

Open daarna <http://localhost:8080>. Stoppen met `Ctrl+C` in de terminal.

## Werken met de app

| Kleur | Betekenis |
|---|---|
| 🟢 Groen | Aan het verkopen |
| 🟠 Oranje | In progress / nog actie nodig |
| 🔴 Rood | Nog geen contact |

- **Zoeken**: op ziekenhuis, arts, functie, stad, e-mail, scope-details of AI die er al staat.
  `Enter` opent het eerste resultaat, `/` springt naar de zoekbalk.
- **Filters**: status, product (EndoQ / Ainex), land (BE / NL / LU) en "Actie te laat".
- **Fiche**: klik op een bolletje op de kaart of in de lijst. Alles is aanpasbaar.
- **Contactpersonen**: toevoegen, bewerken (✎), verwijderen. Met ★ markeer je de hoofdcontactpersoon.
  Denk niet alleen aan de gastro-enterologen: hoofd endoscopie, aankoop en ICT beslissen mee.
- **Contactmomenten**: Prospectie, E-mail, Telefoon, Bezoek, Congres, Demo, Installatie,
  Training, Offerte, Bestelling, Andere. Bij Demo / Installatie / Bestelling vul je het
  aantal kamers in; dat werkt meteen de afdelingsgegevens bij.
  - Eerste contactmoment bij een rood ziekenhuis → wordt automatisch oranje.
  - Een installatie of bestelling → wordt automatisch groen. De kleur kan je altijd zelf terugzetten.
- **Endoscopie-afdeling**: welke scopes ze gebruiken (Olympus / Pentax / Fujifilm — belangrijk
  voor de compatibiliteit), hoeveel endoscopiekamers er zijn, hoeveel er een demo of een
  installatie hebben, coloscopieën per jaar, welke AI er al staat, en of ze meedoen aan het
  bevolkingsonderzoek darmkanker. **Niets is verplicht** — laat leeg wat je nog niet weet.
- **Volgende actie + datum**: verlopen acties krijgen een rode badge; filter "Actie te laat" toont ze allemaal.
- **Demo gepland op**: komt bovenaan in de KPI "Demo's gepland".
- **Locatie**: de coördinaten in de startlijst zijn **benaderd**. Gebruik "Versleep marker" of
  "Klik nieuwe locatie" in de fiche om ze te verbeteren. Een adres kiezen uit de suggesties
  zet de locatie meteen juist.
- **Exporteer**: CSV's voor Excel (ziekenhuizen, contactpersonen, contactmomenten,
  endoscopie-afdelingen) of een volledige JSON-back-up. **Importeer** zet zo'n back-up terug.
- **Statistieken**: installaties per maand, kamers live per ziekenhuis, pijplijn per fase,
  ziekenhuizen per land, scope-merken in de pijplijn, contactmomenten per type, en doelen
  per jaar per product. De doelen staan op 0 — vul ze zelf in op de statistiekenpagina.

## Data

### Lokaal (standaard)

- `data/db.json` – je actuele data (wordt automatisch opgeslagen bij elke wijziging).
- `data/backups/db-JJJJ-MM-DD.json` – automatische dagelijkse back-up.
- `data/seed.json` – startlijst met 39 ziekenhuizen in BE, NL en LU. Wordt alleen gebruikt
  als `db.json` nog niet bestaat. Geen contactpersonen: die vul je zelf aan.

Volledig opnieuw beginnen: verwijder `data/db.json` en herstart de server.

### Online (Supabase + GitHub Pages)

Zo werkt de app ook op je gsm, met login:

1. Maak een project op [supabase.com](https://supabase.com).
2. SQL Editor → New query → plak `supabase/schema.sql` → Run.
3. Authentication → Users → voeg je eigen gebruiker toe.
4. Vul in `public/config.js` de Project URL en de "anon public" sleutel in.
   Die sleutel mag publiek staan: de databank laat enkel aangemelde gebruikers toe.
5. Push naar GitHub en zet Pages aan (branch `main`, map `/`).

Bij de eerste keer openen is de databank leeg; de app biedt dan aan om de startlijst te laden.

> **Let op bij een publieke repo.** Zodra je er echte contactpersonen in zet, staan namen,
> telefoonnummers en e-mailadressen van artsen in de git-geschiedenis. Zet de repo dan op
> **private**, of houd de contactpersonen enkel in Supabase en commit `data/db.json` niet
> (die staat al in `.gitignore`).

## Verschil met FollowUp Vaseo

Dezelfde opzet, ander verkoopverhaal. Bij Vaseo werd per *procedure* een anonieme klinische
fiche bijgehouden (nodule, volume, VRR). EndoQ en Ainex worden niet per procedure verkocht
maar per *endoscopiekamer*, dus die klinische fiche is vervangen door het profiel van de
endoscopie-afdeling. Er is geen patiëntgegeven in deze app.
