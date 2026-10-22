"""Lokaler Server: liefert die Web-App aus und reicht /adsb/* an api.adsb.lol weiter
(die APIs senden keine CORS-Header, daher darf der Browser sie nicht direkt abfragen).

Start:  python server.py [port]
"""
import os, sys, time, urllib.request, urllib.error
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

ROOT = os.path.dirname(os.path.abspath(__file__))
UPSTREAMS = ['https://api.adsb.lol'] * 2      # adsb.lol ist manchmal zickig: bei 5xx einmal wiederholen (airplanes.live blockt: 403)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def _proxy(self):
        path = self.path[len('/adsb'):]
        body = None
        if self.command == 'POST':
            body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        last = None
        for base in UPSTREAMS:
            if base.endswith('airplanes.live') and not path.startswith('/v2'):
                continue
            req = urllib.request.Request(base + path, data=body, method=self.command,
                                         headers={'Content-Type': 'application/json', 'User-Agent': 'Flugzeug-Lauscher'})
            try:
                with urllib.request.urlopen(req, timeout=15) as r:
                    data = r.read()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            except urllib.error.HTTPError as e:
                if e.code in (404, 429):          # 429: nicht weiter hämmern, App wartet selbst
                    return self.send_error(e.code)
                last = e
            except Exception as e:
                last = e
            time.sleep(0.4)
        self.send_error(502, str(last))

    def do_GET(self):
        self._proxy() if self.path.startswith('/adsb/') else super().do_GET()

    def do_POST(self):
        self._proxy() if self.path.startswith('/adsb/') else self.send_error(404)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f'http://localhost:{port}/')
    ThreadingHTTPServer(('0.0.0.0', port), Handler).serve_forever()
