import os
from pathlib import Path
import shlex
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest


HELPER = Path(__file__).resolve().parents[1] / "ensure-local-service.py"


class LocalServiceTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        self.key = self.root / "controller.key"
        self.key.touch(mode=0o600)
        self.key.write_text("a" * 64 + "\n")
        self.marker = self.root / "launches"
        self.addCleanup(self.stop_children)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            self.port = listener.getsockname()[1]

    def stop_children(self):
        if self.marker.exists():
            for pid in self.marker.read_text().splitlines():
                try:
                    os.kill(int(pid), signal.SIGTERM)
                except ProcessLookupError:
                    pass

    def launch_fixture(self, status):
        worker = self.root / "worker.py"
        worker.write_text(f"""
import os
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response({status})
        self.end_headers()
        self.wfile.write(b'{{"lanes":{{}}}}')

with open({str(self.marker)!r}, "a") as marker:
    marker.write(str(os.getpid()) + "\\n")
time.sleep(0.6)
HTTPServer(("127.0.0.1", {self.port}), Handler).serve_forever()
""")
        launcher = self.root / "serve"
        launcher.write_text(f"#!/bin/sh\nexec {shlex.quote(sys.executable)} {shlex.quote(str(worker))}\n")
        launcher.chmod(0o700)
        return launcher

    def command(self, launcher):
        return [sys.executable, HELPER, str(self.port), self.key, self.root / "serve.lock", launcher]

    def test_concurrent_sessions_start_one_service_and_restart_after_exit(self):
        command = self.command(self.launch_fixture(200))
        with subprocess.Popen(command, stdout=subprocess.PIPE) as first:
            second = subprocess.run(command, capture_output=True, timeout=10, check=True)
            self.assertEqual(first.communicate(timeout=10), (b"", None))
            self.assertEqual(first.returncode, 0)
        self.assertEqual(second.stdout, b"")
        launched = self.marker.read_text().splitlines()
        self.assertEqual(len(launched), 1)
        os.kill(int(launched[0]), signal.SIGTERM)
        until = time.monotonic() + 5
        while time.monotonic() < until:
            with socket.socket() as probe:
                if probe.connect_ex(("127.0.0.1", self.port)) != 0:
                    break
            time.sleep(0.05)
        subprocess.run(command, capture_output=True, timeout=10, check=True)
        self.assertEqual(len(self.marker.read_text().splitlines()), 2)

    def test_an_unverified_listener_does_not_start_a_service(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", self.port))
            listener.listen()
            with subprocess.Popen(self.command(self.launch_fixture(200)), stderr=subprocess.PIPE) as caller:
                listener.settimeout(3)
                connection, _ = listener.accept()
                with connection:
                    connection.recv(4096)
                    connection.sendall(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n")
                _, error = caller.communicate(timeout=5)
                self.assertNotEqual(caller.returncode, 0)
        self.assertIn(b"did not confirm", error)
        self.assertFalse(self.marker.exists())


if __name__ == "__main__":
    unittest.main()
