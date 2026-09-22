#!/usr/bin/env bash
# Installer preflight helpers.
#
# The installer's irreversible step is `rm -rf "$DEST"`. Every decision that gates it
# lives here, in sourceable functions, so it is provable without downloading a release
# (scripts/tests/preflight_test.sh, scripts/tests/install_prompt_test.sh). `install.sh`
# is only the caller.
#
# THE CONTRACT, in one sentence: swapping the bundle requires a quiet machine, so the
# installer reports everything that is live, asks once, and either tears all of it down
# or changes nothing at all.
#
# It deliberately does NOT try to work out whether this release "needs" a teardown. That
# check used to compare the incoming `alineryd --protocol-version` against every running
# daemon's `version` reply and only stop the ones it had to. It was correct and nobody
# could hold it in their head: four verdicts, three decisions, a `--force` interaction,
# and a "compatible" path that swapped the binary under a running daemon and asked the
# user to trust that the wire had not moved. One question with one obvious meaning beats
# a decision table the user has to audit.
#
# Two rules that survive from the old design, because they were the right ones:
#
#   1. PROBE BY CONNECTING, NEVER BY `stat`. `.alinery/` can accumulate
#      dead lane sockets (#71 Mode C debris); a file-exists check reports phantom daemons
#      and would prompt about work that is not there. Same rule #74 already set for MCP.
#   2. NOTHING IS KILLED / RENAMED UNTIL THE USER SAYS SO. Everything here is read-only
#      up to the prompt. A declined install touches nothing: no daemon, no session, no
#      bundle, no mv of `.alinery` or app-support dirs.
#
# Plain bash + base macOS tools, no jq (matching scripts/homebrew/check-version-sync.sh).

# Live == running + idle. `exited` sessions stay registered for replay and must never
# inflate a loss-of-work warning. An unreachable daemon (empty reply) counts zero.
live_sessions_from_list_reply() {
  local n
  n="$(printf '%s' "${1-}" |
    grep -oE '"status"[[:space:]]*:[[:space:]]*"(running|idle)"' |
    wc -l | tr -d '[:space:]' || true)"
  printf '%s' "${n:-0}"
}

# Ask a unix socket one JSON op and echo the first reply line.
#
# ALWAYS returns 0: under the installer's `set -euo pipefail` a non-zero return here
# would abort the install just because a dead lane socket is lying around on disk.
probe_op() {
  local sock="${1-}" op="${2-version}" reply=""
  if [ -n "$sock" ] && command -v nc >/dev/null 2>&1; then
    reply="$(printf '{"op":"%s"}\n' "$op" | nc -U -w 2 "$sock" 2>/dev/null | head -n 1 || true)"
  fi
  printf '%s' "$reply"
  return 0
}

# `version` is the liveness probe: a daemon that answers it is real, a socket file that
# does not is debris. The reply's *contents* are no longer read by the installer.
probe_version() { probe_op "${1-}" version; }
probe_list() { probe_op "${1-}" list; }

# End one repo's daemon. `shutdown` SIGTERM/SIGKILLs every harness process group and
# reaps it, so the meta gets its `ended_at`/`exit_code` and sessions show as exited
# rather than interrupted on next launch. Only ever called after an explicit yes.
probe_shutdown() { probe_op "${1-}" shutdown; }

# Block until a socket stops answering, or give up. 0 = quiet, 1 = still answering.
#
# `shutdown` returns `{"ok":true}` as soon as the daemon accepts it, not when it has
# finished tearing down. `probe_op` already costs up to 2s per attempt once nothing is
# listening, so a handful of tries covers a slow teardown without hanging the installer.
wait_socket_quiet() {
  local sock="${1-}" tries="${2-10}" i=0
  while [ "$i" -lt "$tries" ]; do
    [ -n "$(probe_op "$sock" version)" ] || return 0
    i=$((i + 1))
    sleep 0.3
  done
  return 1
}

# Repos this machine knows about, one per line, read from the app-level config that
# `alinery_core::app_config_toml_path()` writes. Tolerates the array being wrapped across
# lines by the toml serializer.
#
# Read the current application configuration without changing it.
_known_repos_from_one_toml() {
  local cfg="${1-}"
  [ -f "$cfg" ] || return 0
  sed -n '/^known_repos[[:space:]]*=/,/\]/p' "$cfg" |
    tr ',' '\n' |
    sed -n 's/.*"\(\/[^"]*\)".*/\1/p'
}

known_repos_from_app_config() {
  _known_repos_from_one_toml "${1:-${HOME}/Library/Application Support/ai.delegance.alinery/app.toml}"
}

# Current per-repository daemon socket.
repo_daemon_socket() { printf '%s/.alinery/alineryd.sock' "${1%/}"; }

# The current daemon socket for a repository.
repo_daemon_sockets() { repo_daemon_socket "$1"; printf '\n'; }

# First candidate that answers `version`. Empty if none are live.
first_live_daemon_socket() {
  local sock
  while IFS= read -r sock || [ -n "$sock" ]; do
    [ -n "$sock" ] || continue
    if [ -n "$(probe_version "$sock")" ]; then
      printf '%s' "$sock"
      return 0
    fi
  done < <(repo_daemon_sockets "${1-}")
  return 0
}

# Match product alineryd / leftover alineryd command lines from process listing.
# Tight on the binary name so a random tool named similarly is ignored;
# connect-don't-stat is still the true liveness check once we have a candidate path.
ALINERYD_PROCESS_PATTERN='(^|[[:space:]/])alineryd([[:space:]]|$)'

is_product_daemon_ps_line() {
  printf '%s' "${1-}" | grep -qE "$ALINERYD_PROCESS_PATTERN"
}

# Strip trailing slashes so `/x` and `/x/` are one repo. `repo_daemon_socket` already
# does this for the socket path; the discovery/known_repos union has to agree or the same
# daemon is reported and shut down twice.
normalize_repo_path() {
  local p="${1-}"
  while [ "${#p}" -gt 1 ] && [ "${p%/}" != "$p" ]; do p="${p%/}"; done
  printf '%s' "$p"
}

# Parse a process-list line for `alineryd --repo <path>`. Echoes the path or nothing.
# Accepts both `--repo /path` and `--repo=/path` forms.
#
# The value ends at the next long option, NOT at the first space: alineryd is always spawned
# as `--repo <path> --app-config <path> …`, and a repo living under "~/My Projects" is
# ordinary on macOS. Cutting at the first space truncated the path, the socket probe then
# missed, and a live daemon read as "machine quiet" — the exact hole finding 6 is about.
parse_alineryd_repo_from_ps_line() {
  local line="${1-}" repo=""
  case "$line" in
    *--repo=*) repo="${line#*--repo=}" ;;
    *--repo\ *) repo="${line#*--repo }" ;;
    *) return 0 ;;
  esac
  # Trim at the next ` --option`, if this was not the last argument.
  case "$repo" in
    *' --'*) repo="${repo%% --*}" ;;
  esac
  # Trailing whitespace (last arg on the line).
  while [ -n "$repo" ] && [ "${repo% }" != "$repo" ]; do repo="${repo% }"; done
  [ -n "$repo" ] || return 0
  normalize_repo_path "$repo"
}

# PID + full argv for matching daemons.
#
# procps-ng (`pgrep -l`) is PID + 15-char comm — no `--repo`, so discovery
# reports a quiet machine. `--list-full` (`-a`) is the Linux flag. BSD pgrep
# has no `-a`; `-fl` already prints the matching command. Feature-detect the
# help text so Ubuntu CI and a Mac laptop share one path.
_pgrep_daemon_listing() {
  if pgrep --help 2>&1 | grep -q -- '--list-full'; then
    pgrep -fa "$ALINERYD_PROCESS_PATTERN" 2>/dev/null || true
  else
    pgrep -fl "$ALINERYD_PROCESS_PATTERN" 2>/dev/null || true
  fi
}

# Repos whose product daemons are running *right now*, discovered from the process
# list — not only from app.toml known_repos. Pre-#132 delist-left-daemon orphans and
# any daemon whose repo was never written to known_repos would otherwise be invisible
# ("machine quiet" while live). PID files are never trusted; callers still probe the
# socket with connect-don't-stat before treating a path as live.
discover_live_daemon_repos() {
  local line repo
  # Process list only (same spirit as ALINERY_APP_PATTERN) — no TCC, no filesystem walk.
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    is_product_daemon_ps_line "$line" || continue
    repo="$(parse_alineryd_repo_from_ps_line "$line")"
    [ -n "$repo" ] || continue
    printf '%s\n' "$repo"
  done < <(_pgrep_daemon_listing)
}

# Is an Alinery.app (or leftover alinery.app) GUI process running? (`pgrep -f` so a bundle/install
# in any dir matches.) The third alternative is the Linux install layout (no bundle: a plain
# $INSTALL_DIR/Alinery/Alinery, see scripts/install.sh) -- anchored on two literal "Alinery"
# path components, same specificity as the macOS bundle path, so it does not also match the
# sidecar binaries scripts/release/build-linux.sh stages right next to it in that same
# directory (alineryd-<triple>, alinery-mcp-<triple>, alinery-runner-<triple> all end in
# something other than exactly "/Alinery/Alinery"). No OS branching needed: a macOS ps line
# never contains that Linux-only substring, so one static pattern covers both platforms.
#
# Process list only. NEVER `osascript` / System Events: reaching the app through Apple
# Events costs an Automation TCC prompt that is unpredictable under `curl … | bash` and
# absent entirely in CI. A signal to a pid needs no such permission.
ALINERY_APP_PATTERN='(Alinery\.app/Contents/MacOS/[Aa]linery|/Alinery/Alinery)$'

alinery_app_is_running() {
  pgrep -f "$ALINERY_APP_PATTERN" >/dev/null 2>&1
}

# The matching processes, `<pid> <command>` per line, for the report.
alinery_app_processes() {
  pgrep -fl "$ALINERY_APP_PATTERN" 2>/dev/null || true
}

# Polls per phase, at 0.2s each — ~5s to honour SIGTERM, then ~5s to confirm SIGKILL took.
# Overridable only so the stubborn-process test does not have to burn 10s proving a
# timeout; nothing in the installer sets it.
ALINERY_STOP_POLLS="${ALINERY_STOP_POLLS:-25}"

# Quit the app: SIGTERM, then SIGKILL anything still up after ~5s. The bundle is about
# to be `rm -rf`'d out from under this process — leaving it running breaks its sidecar
# lookup (`resolve_alineryd_path` reads the bundle dir) and orphans its managed alinery-mcp.
#
# Returns 0 only when no Alinery process remains. Callers must treat non-zero as "do not
# touch anything else" — see `preflight_gate`.
stop_alinery_app() {
  local i
  pkill -TERM -f "$ALINERY_APP_PATTERN" 2>/dev/null || true
  for i in $(seq 1 "$ALINERY_STOP_POLLS"); do
    alinery_app_is_running || return 0
    sleep 0.2
  done
  pkill -KILL -f "$ALINERY_APP_PATTERN" 2>/dev/null || true
  # SIGKILL is a request to the kernel, not proof of death: the process stays visible
  # until it is reaped, and the `sleep 0.5` that used to stand here was a guess about how
  # long that takes rather than a check that it happened — after which this returned
  # success unconditionally. Everything the caller does next (stopping daemons, then
  # `rm -rf`ing the bundle) is unsafe while any Alinery is alive, because its 5s poller can
  # respawn a daemon we just stopped and its sidecar lookup reads the bundle we are about
  # to delete. A process can also outlive SIGKILL for real: uninterruptible I/O, or a pid
  # we are not permitted to signal. So look again, and report rather than assume.
  for i in $(seq 1 "$ALINERY_STOP_POLLS"); do
    alinery_app_is_running || return 0
    sleep 0.2
  done
  return 1
}

# Ask a yes/no question on the controlling terminal. Echoes `y` or `n`, never fails.
#
# Reads /dev/tty, NOT stdin, and gates on the open SUCCEEDING rather than on `[ -t 0 ]`.
# The documented install path is `curl … | bash`, which hands the script a pipe: stdin is
# not a tty there, so a `[ -t 0 ]` guard would skip the question entirely and silently
# take the default — the user never gets asked in the one path most people use. Opening
# /dev/tty finds the terminal behind the pipe. With no controlling terminal at all (CI,
# launchd) the open fails and the answer is `n`.
#
# `[ -r /dev/tty ]` is NOT a usable test: it stats a crw-rw-rw- device node that exists
# whether or not this process has a terminal, so it passes in exactly the case it is
# meant to catch. The open attempt is the test.
ask_tty() {
  local prompt="${1-Continue? [y/N] }" answer=""
  { printf '%s' "$prompt" >/dev/tty && read -r answer </dev/tty; } 2>/dev/null ||
    answer=n
  case "$answer" in
    y | Y | yes | YES) printf 'y' ;;
    *) printf 'n' ;;
  esac
}

# ── the gate ─────────────────────────────────────────────────────────────────────
#
#   preflight_gate <force>
#     0  the machine is quiet (or was just quieted) — proceed to the swap
#     1  the user declined — the caller must exit having changed NOTHING
#
# Lives here rather than inline in install.sh because this is the code guarding
# `rm -rf "$DEST"`, and this project has already shipped one confirmation that looked
# correct in source and never actually asked anyone (see check-no-window-confirm.sh).
# Sourceable ⇒ drivable by scripts/tests/install_prompt_test.sh, prompt and all.
preflight_gate() {
  local force="${1-0}"
  local repos=() live_repos=() live_socks=() r sock reply live live_total=0 report="" app_running=0
  local seen=$'\n'

  # Union of known repositories and process-discovered daemon repository paths.
  # Dedupe so an orphan outside known_repos still shows up once.
  # `|| [ -n "$r" ]` so a final line with no trailing newline is not silently dropped.
  while IFS= read -r r || [ -n "$r" ]; do
    [ -n "$r" ] || continue
    r="$(normalize_repo_path "$r")"
    case "$seen" in
      *$'\n'"$r"$'\n'*) continue ;;
    esac
    seen="${seen}${r}"$'\n'
    repos+=("$r")
  done < <({
    known_repos_from_app_config
    discover_live_daemon_repos
  })

  local i=0
  while [ "$i" -lt "${#repos[@]}" ]; do
    r="${repos[$i]}"
    i=$((i + 1))
    # Probe the socket; do not infer liveness from its presence.
    sock="$(first_live_daemon_socket "$r")"
    [ -n "$sock" ] || continue
    live="$(live_sessions_from_list_reply "$(probe_list "$sock")")"
    live_total=$((live_total + live))
    live_repos+=("$r")
    live_socks+=("$sock")
    report="${report}  $r — $live live session(s)
"
  done

  alinery_app_is_running && app_running=1

  # Nothing to tear down: no daemon answered and the app is not up. There is no question
  # to ask and nothing to kill, so say nothing and get on with it.
  if [ "${#live_repos[@]}" -eq 0 ] && [ "$app_running" -eq 0 ]; then
    return 0
  fi

  echo
  echo "Installing replaces the Alinery bundle, so everything running out of it has to stop"
  echo "first — the app, its session daemons, and every harness they own."
  echo
  if [ "${#live_repos[@]}" -gt 0 ]; then
    echo "Session daemons running (${#live_repos[@]} repo(s), $live_total live session(s)):"
    printf '%s' "$report"
  fi
  if [ "$app_running" -eq 1 ]; then
    echo "Alinery is running:"
    alinery_app_processes | sed 's/^/  /'
  fi
  echo
  echo "Answering yes ends those sessions. Unsaved harness work is lost; artifacts and"
  echo "scrollback already written to .alinery/ are not."
  echo

  if [ "$force" -ne 1 ] &&
    [ "$(ask_tty 'Stop all of it and install? [y/N] ')" != y ]; then
    echo
    echo "Install cancelled. Nothing has been stopped and nothing has been changed."
    echo "Finish your work, quit Alinery and stop its sessions from"
    echo '  Settings → Chat → "Stop all sessions in <repo>"'
    echo "then run this installer again."
    return 1
  fi

  # ── past this line the user has said yes ────────────────────────────────────────
  [ "$force" -ne 1 ] || echo "--force given: stopping everything without asking."

  # Order matters: stop the app FIRST, then daemons. The app's 5s poller respawns a
  # daemon for any known repo that looks quiet; killing daemons while the app is still
  # up races that poller into resurrecting what we just stopped.
  if [ "$app_running" -eq 1 ]; then
    echo "  quitting Alinery"
    # Abort BEFORE the daemon loop below. An Alinery process that survived SIGKILL is still polling,
    # so stopping daemons now would kill live sessions and then watch them come back —
    # the worst of both outcomes, and precisely the "update killed my sessions" failure
    # this gate exists to prevent.
    if ! stop_alinery_app; then
      echo
      echo "ERROR: Alinery is still running after being asked, then told, to quit." >&2
      echo "       Nothing has been stopped. Quit it manually and re-run:" >&2
      echo >&2
      alinery_app_processes | sed 's/^/         /' >&2
      return 1
    fi
  fi

  i=0
  while [ "$i" -lt "${#live_repos[@]}" ]; do
    r="${live_repos[$i]}"
    sock="${live_socks[$i]}"
    i=$((i + 1))
    echo "  stopping daemon: $r"
    probe_shutdown "$sock" >/dev/null
  done

  # `shutdown` is acknowledged before the daemon has finished SIGTERM/SIGKILLing its
  # harness process groups and unwinding. Returning here would let install.sh `rm -rf`
  # the bundle out from under a process still running from inside it — and alineryd IS in
  # that bundle. Wait for each socket to actually go quiet.
  i=0
  while [ "$i" -lt "${#live_repos[@]}" ]; do
    r="${live_repos[$i]}"
    sock="${live_socks[$i]}"
    i=$((i + 1))
    if ! wait_socket_quiet "$sock"; then
      echo
      echo "WARN: the daemon for $r is still answering after being asked to stop." >&2
      echo "      Installing now could leave an orphan holding that repo. Quit it" >&2
      echo "      manually and re-run." >&2
      return 1
    fi
  done

  return 0
}
