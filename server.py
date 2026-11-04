#!/usr/bin/env python3
"""FollowUp Prion – lokale server / local server.

Start:  python3 server.py   en open http://localhost:8080

Bewaart alles in data/db.json. Bij elke wijziging komt er een kopie in
data/backups/: db-vorige.json (één stap terug) en db-JJJJ-MM-DD.json (de
toestand bij de eerste wijziging van die dag).
Geen externe libraries nodig.
"""
import json
import os
import shutil
import sys
import tempfile
from datetime import date
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
DATA = ROOT / "data"
DB = DATA / "db.json"
SEED = DATA / "seed.json"
BACKUPS = DATA / "backups"
PORT = int(os.environ.get("PORT", "8080"))
MAX_BODY = 20 * 1024 * 1024
# Enkel deze hosts mogen /api/data gebruiken; zie _host_ok().
ALLOWED_HOSTS = {f"localhost:{PORT}", f"127.0.0.1:{PORT}", f"[::1]:{PORT}"}


def load_db():
    if not DB.exists():
        if SEED.exists():
            shutil.copy(SEED, DB)
        else:
            DB.write_text(json.dumps({"version": 1, "hospitals": []}), encoding="utf-8")
    return DB.read_text(encoding="utf-8")


def save_db(payload):
    data = json.loads(payload)
    if not isinstance(data, dict) or not isinstance(data.get("hospitals"), list):
        raise ValueError("Ongeldige data: 'hospitals' ontbreekt")
    text = json.dumps(data, indent=2, ensure_ascii=False)
    fd, tmp = tempfile.mkstemp(dir=DATA, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
    except BaseException:
        os.unlink(tmp)  # anders blijft er een halve .tmp in data/ staan
        raise
    # Twee vangnetten, elk één kopie:
    #  - db-vorige.json: de toestand van net voor deze opslag, één stap terug;
    #  - db-JJJJ-MM-DD.json: de toestand bij de eerste wijziging van die dag.
    #    Die schrijven we niet meer over, anders neemt een verkeerde opslag de
    #    dagkopie mee en valt er van vandaag niets terug te halen.
    if DB.exists():
        BACKUPS.mkdir(exist_ok=True)
        day = BACKUPS / f"db-{date.today().isoformat()}.json"
        if not day.exists():
            shutil.copy(DB, day)
        shutil.copy(DB, BACKUPS / "db-vorige.json")
    os.replace(tmp, DB)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC), **kwargs)

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        raw = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def _host_ok(self):
        # De server luistert enkel op 127.0.0.1, maar zonder deze controle kan
        # een webpagina via DNS-rebinding alsnog bij de databank: de browser
        # stuurt dan een eigen naam mee in Host. Enkel /api/data is beschermd;
        # de app zelf is gewone statische inhoud.
        return (self.headers.get("Host") or "").strip() in ALLOWED_HOSTS

    def do_GET(self):
        if self.path.split("?")[0] == "/api/data":
            if not self._host_ok():
                return self._send(403, '{"error":"verkeerde host"}')
            return self._send(200, load_db())
        return super().do_GET()

    def do_PUT(self):
        if self.path.split("?")[0] != "/api/data":
            return self._send(404, '{"error":"not found"}')
        if not self._host_ok():
            return self._send(403, '{"error":"verkeerde host"}')
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self._send(400, '{"error":"ongeldige Content-Length"}')
        if length <= 0 or length > MAX_BODY:
            return self._send(400, '{"error":"lege of te grote body"}')
        try:
            save_db(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError, RecursionError) as e:
            return self._send(400, json.dumps({"error": str(e)}))
        except OSError as e:
            return self._send(500, json.dumps({"error": str(e)}))
        return self._send(200, '{"ok":true}')

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        super().end_headers()

    def log_message(self, fmt, *args):
        # log_error geeft een HTTPStatus mee i.p.v. een string (bv. bij een 404
        # op /favicon.ico); str() voorkomt dat de request-thread daarop crasht.
        if "/api/" in str(args[0] if args else ""):
            sys.stderr.write("%s\n" % (fmt % args))


if __name__ == "__main__":
    DATA.mkdir(exist_ok=True)
    load_db()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"FollowUp Prion draait op http://localhost:{PORT}  (Ctrl+C om te stoppen)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
