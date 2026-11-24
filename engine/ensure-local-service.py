#!/usr/bin/env python3
"""Start one detached loopback engine from an ACP launcher."""

import argparse
from contextlib import closing
from enum import Enum, auto
import fcntl
from http.client import HTTPConnection, HTTPException
import json
import os
import re
from socket import timeout as SocketTimeout
import stat
import subprocess
import sys
import time


class StartupError(Exception):
    pass


class EngineHealth(Enum):
    READY = auto()
    ABSENT = auto()
    WAITING = auto()


def private_file(path, flags):
    file = os.fdopen(os.open(path, flags | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600))
    opened = os.fstat(file.fileno())
    if not stat.S_ISREG(opened.st_mode) or opened.st_uid != os.getuid() or opened.st_mode & 0o077:
        file.close()
        raise StartupError("Engine startup files must be owner-only regular files.")
    return file


def engine_health(port, key):
    try:
        with closing(HTTPConnection("127.0.0.1", port, timeout=1)) as connection:
            connection.request("GET", "/v1/health", headers={"Authorization": "Bearer " + key})
            response = connection.getresponse()
            if response.status != 200:
                raise StartupError("The loopback port did not confirm this engine's identity.")
            view = json.loads(response.read(16 * 1024))
            if not isinstance(view, dict) or not isinstance(view.get("lanes"), dict):
                raise StartupError("The loopback port returned an invalid engine health view.")
            return EngineHealth.READY
    except ConnectionRefusedError:
        return EngineHealth.ABSENT
    except (TimeoutError, SocketTimeout):
        # The engine can own the listener while it is still opening the store.
        return EngineHealth.WAITING
    except (OSError, HTTPException, ValueError) as error:
        raise StartupError("The engine's loopback health could not be confirmed.") from error


def take_lock(lock):
    try:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return False
    return True


def ensure_service(port, key_file, lock_file, launcher):
    with private_file(key_file, os.O_RDONLY) as file:
        key = file.read(66)
    if not re.fullmatch(r"[0-9a-f]{64}\n?", key):
        raise StartupError("Invalid local engine health credential.")
    key = key.strip()
    if engine_health(port, key) is EngineHealth.READY:
        return

    deadline = time.monotonic() + 25
    with private_file(lock_file, os.O_RDONLY | os.O_CREAT) as lock:
        child = None
        while time.monotonic() < deadline:
            health = engine_health(port, key)
            if health is EngineHealth.READY:
                return
            if health is EngineHealth.ABSENT and child is None and take_lock(lock):
                health = engine_health(port, key)
                if health is EngineHealth.READY:
                    return
                if health is EngineHealth.ABSENT:
                    # The child keeps the lock even if this launcher exits.
                    child = subprocess.Popen(
                        [launcher],
                        stdin=subprocess.DEVNULL,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        pass_fds=(lock.fileno(),),
                        start_new_session=True,
                    )
            if child is not None and child.poll() is not None:
                raise StartupError("The local engine exited during startup. Check its service log.")
            time.sleep(0.25)
    raise StartupError("The local engine did not report healthy before the startup deadline.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("port", type=int)
    parser.add_argument("key_file")
    parser.add_argument("lock_file")
    parser.add_argument("launcher")
    args = parser.parse_args()
    try:
        ensure_service(args.port, args.key_file, args.lock_file, args.launcher)
    except StartupError as error:
        sys.exit(str(error))
    except (OSError, ValueError):
        sys.exit("The local engine startup files could not be opened or used.")


if __name__ == "__main__":
    main()
