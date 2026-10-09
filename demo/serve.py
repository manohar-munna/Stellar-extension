import http.server
import socketserver
import os
import sys

PORT = 8765
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def translate_path(self, path):
        # Normalize /demo and /demo/* to /*
        if path == "/demo":
            path = "/"
        elif path.startswith("/demo/"):
            path = path[5:]
        return super().translate_path(path)

    def do_GET(self):
        if self.path == "/demo":
            self.send_response(301)
            self.send_header("Location", "/demo/")
            self.end_headers()
            return
        return super().do_GET()

if __name__ == "__main__":
    socketserver.TCPServer.allow_reuse_address = True
    try:
        with socketserver.TCPServer(("", PORT), Handler) as httpd:
            print(f"Stellar demo server running at http://localhost:{PORT}/ and http://localhost:{PORT}/demo/", flush=True)
            httpd.serve_forever()
    except Exception as e:
        print(f"Error starting server: {e}", file=sys.stderr, flush=True)
        sys.exit(1)
