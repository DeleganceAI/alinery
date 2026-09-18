#!/usr/bin/env python3
"""Throwaway browser IPC adapter: authoring operations execute the real core CLI."""
import argparse
import http.server
import json
import pathlib
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--port', type=int, default=31627)
parser.add_argument('--keep', action='store_true')
args = parser.parse_args()
workspace = pathlib.Path(__file__).resolve().parents[1]
binary = workspace / 'alinery-app/src-tauri/target/debug/examples/playbook_ui_bridge'
root = pathlib.Path(tempfile.mkdtemp(prefix='alinery-v2-ui-'))
repo, config = root / 'repo', root / 'config'
repo.mkdir()
config.mkdir()

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass
    def respond(self, payload, status=200):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def do_OPTIONS(self):
        self.respond({})
    def do_GET(self):
        self.respond({'repo': str(repo), 'config': str(config)})
    def do_POST(self):
        size = int(self.headers.get('Content-Length', '0'))
        if not 0 < size <= 1024 * 1024:
            self.respond({'ok': False, 'error': 'smoke request size'}, 400)
            return
        raw = self.rfile.read(size)
        try:
            result = subprocess.run([str(binary), str(repo), str(config)], input=raw, capture_output=True, timeout=15)
            if result.returncode:
                raise RuntimeError(result.stderr.decode())
            self.respond(json.loads(result.stdout))
        except Exception as error:
            self.respond({'ok': False, 'error': str(error)}, 500)

server = http.server.ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
print(json.dumps({'event': 'ui_bridge_ready', 'port': server.server_port, 'repo': str(repo), 'config': str(config)}), flush=True)
try:
    server.serve_forever()
finally:
    server.server_close()
    if args.keep:
        print(json.dumps({'event': 'retained_ui_fixture', 'path': str(root)}), flush=True)
    else:
        shutil.rmtree(root)
