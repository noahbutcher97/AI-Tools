"""Measure an installed Codex writer across restart without requesting a model turn."""
import argparse
import json
import os
from pathlib import Path
import queue
import subprocess
import tempfile
import threading
import time
from uuid import UUID


def observe_writer(image, home, thread_id=None, abrupt=False):
    # Use a disposable provider profile. Prevent incidental remote Git fetches.
    env = dict(os.environ, CODEX_HOME=str(home), GIT_ALLOW_PROTOCOL="file")
    with subprocess.Popen(
        [str(image), "app-server"], cwd=home, env=env,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW,
    ) as child:
        replies = queue.Queue()

        def read_replies():
            for line in child.stdout:
                frame = json.loads(line)
                if "id" in frame:
                    replies.put(frame)

        reader = threading.Thread(target=read_replies, daemon=True)
        reader.start()
        request_id = 0

        def request(method, params):
            nonlocal request_id
            request_id += 1
            frame = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
            child.stdin.write((json.dumps(frame) + "\n").encode())
            child.stdin.flush()
            deadline = time.monotonic() + 12
            while time.monotonic() < deadline:
                reply = replies.get(timeout=max(0.01, deadline - time.monotonic()))
                if reply.get("id") == request_id:
                    if "error" in reply:
                        raise RuntimeError(f"Provider refused {method}")
                    return reply["result"]
            raise TimeoutError(method)

        try:
            request("initialize", {"clientInfo": {"name": "relay_qualification", "version": "1"},
                                   "capabilities": {"experimentalApi": True}})
            params = {"cwd": str(home), "model": "gpt-6-luna",
                      "approvalPolicy": "never", "sandbox": "read-only"}
            if thread_id:
                params["threadId"] = thread_id
                result = request("thread/resume", params)
            else:
                result = request("thread/start", params)
            observed = str(UUID(result["thread"]["id"]))
            if thread_id and observed != thread_id:
                raise RuntimeError("Provider resumed a different thread")
            if not thread_id:
                request("thread/name/set", {"threadId": observed, "name": "relay-test-session"})
            lock = home / "thread-writer-locks" / (observed + ".lock")
            stat = lock.stat()
            if not stat.st_ino or stat.st_ino != lock.stat().st_ino:
                raise RuntimeError("File identity unavailable or unstable")
            if abrupt:
                child.kill()
            return observed, lock, stat
        finally:
            child.stdin.close()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)
                raise RuntimeError("Graceful provider shutdown timed out")
            reader.join(timeout=2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path, help="Absolute path to the installed Codex executable")
    args = parser.parse_args()
    if os.name != "nt" or not args.image.is_absolute() or not args.image.is_file():
        parser.error("Supply an installed Windows executable by absolute path")
    for abrupt in (False, True):
        with tempfile.TemporaryDirectory(prefix="relay-writer-") as directory:
            home = Path(directory)
            thread_id, lock, before = observe_writer(args.image, home, abrupt=abrupt)
            remained = lock.exists()
            _, _, after = observe_writer(args.image, home, thread_id)
            print(json.dumps({
                "exit": "abrupt" if abrupt else "graceful",
                "sameThreadResumed": True,
                "lockSurvivedExit": remained,
                "fileIdentityChanged": before.st_ino != after.st_ino,
                "creationTimeChanged": (getattr(before, "st_birthtime_ns", before.st_ctime_ns) !=
                                        getattr(after, "st_birthtime_ns", after.st_ctime_ns)),
                "emptyLocks": before.st_size == after.st_size == 0,
            }))


if __name__ == "__main__":
    main()
