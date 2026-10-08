"""Run each delivered check suite after its documented dependency setup."""
import argparse
import os
from pathlib import Path
import subprocess
import sys

p = argparse.ArgumentParser(description=__doc__)
p.add_argument("--smithers-source", required=True, type=Path)
p.add_argument("--alinery-source", required=True, type=Path)
a = p.parse_args()
root = Path(__file__).resolve().parent
smithers_env = {**os.environ, "SMITHERS_SOURCE": str(a.smithers_source.resolve())}
steps = [
    (["npm", "test"], root / "claude", None),
    (["npm", "test"], root / "smithers", smithers_env),
    ([str(root / "langgraph/.venv/bin/python"), "verify.py"], root / "langgraph", None),
    ([sys.executable, "alinery/verify.py", "--alinery-source", str(a.alinery_source.resolve())], root, None),
]
for command, cwd, env in steps:
    print(f"Running {cwd.name}: {' '.join(command)}", flush=True)
    subprocess.run(command, cwd=cwd, env=env, check=True)
print("All requested check suites passed. Native Claude and live inference remain unverified.")
