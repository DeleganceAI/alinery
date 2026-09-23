#!/usr/bin/env python3
"""Check the fixed models and require the historical models to fail as expected."""
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile

JAR_SHA256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88"


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python3 docs/formal/playbooks/check.py /path/to/tla2tools-1.7.4.jar")
    jar = Path(sys.argv[1]).resolve()
    if hashlib.sha256(jar.read_bytes()).hexdigest() != JAR_SHA256:
        raise SystemExit("Expected official tla2tools.jar v1.7.4; SHA-256 mismatch")
    cases = [
        ("ExitOwnership.before", 12, "Invariant ShutdownMeansStopped is violated"),
        ("ExitOwnership", 0, "Model checking completed. No error has been found."),
        ("ExitDelivery.before", 13, "Temporal properties were violated"),
        ("ExitDelivery", 0, "Model checking completed. No error has been found."),
    ]
    with tempfile.TemporaryDirectory(prefix="alinery-tlc-") as work:
        for name, expected_code, expected_message in cases:
            result = subprocess.run(
                [os.environ.get("JAVA", "java"), "-XX:+UseParallelGC", "-Xmx512m",
                 "-cp", str(jar), "tlc2.TLC", "-workers", "1", "-seed", "1",
                 "-metadir", str(Path(work) / name), "-config", name + ".cfg",
                 name.split(".")[0] + ".tla"],
                cwd=Path(__file__).resolve().parent, text=True,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60,
            )
            if result.returncode != expected_code or expected_message not in result.stdout:
                print(result.stdout)
                raise SystemExit(f"FAIL {name}: exit {result.returncode}, expected {expected_code}")
            print(f"PASS {name}: {'expected counterexample' if expected_code else 'no violation'}")
            for line in result.stdout.splitlines():
                if "distinct states found" in line and not line.startswith("Progress"):
                    print("  " + line)


if __name__ == "__main__":
    main()
