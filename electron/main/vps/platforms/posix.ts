import { VPS_GUARD } from '@shared/utils/vps'
import { shQuote } from '@shared/utils/vps'

/*
 * Pieces shared by the macOS and Ubuntu scripts. Plain POSIX sh, ASCII only.
 *
 * Every change is followed by `undo '<command>'`, which pushes the command
 * that reverses it onto a stack kept in a root-owned temp file. `fail` runs
 * the stack (newest first) and exits, so a setup that stops half-way leaves
 * the system as it found it.
 */

/** Script start: $1 is the work folder; reads and deletes the password file when `withSecret`. */
export const prelude = (withSecret: boolean): string => `
set -u
umask 022
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
WORK="$1"
OUT="$WORK/progress.log"
UNDO=$(mktemp /tmp/featured-vps-undo.XXXXXX) || exit 1
chmod 600 "$UNDO"
say() { printf '%s\\n' "$*" >> "$OUT"; }
step() { say "STEP $*"; }
change() { say "CHANGE $1"; }
undo() { { printf '%s\\n' "$1"; cat "$UNDO"; } > "$UNDO.n" && mv "$UNDO.n" "$UNDO"; }
DONE=0
rollback() {
  # Undo commands may report back through $OUT (e.g. USERKEPT).
  if [ -s "$UNDO" ]; then OUT="$OUT" sh "$UNDO" >/dev/null 2>&1; fi
  rm -f "$UNDO"
}
fail() {
  DONE=1
  say "ERROR $1"
  rollback
  exit 1
}
# Any other way out (a command that kills the shell, a signal) still reports and undoes.
on_exit() {
  if [ "$DONE" != 1 ]; then
    say "ERROR The setup script stopped unexpectedly; its changes were undone."
    rollback
  fi
}
trap on_exit EXIT
trap 'exit 1' HUP INT TERM
finish() { DONE=1; rm -f "$UNDO"; say OK; exit 0; }
[ "$(id -u)" = 0 ] || fail "Not running as administrator."
${
  withSecret
    ? `[ -f "$WORK/secret" ] || fail "The password was not handed over."
PW=$(cat "$WORK/secret")
rm -f "$WORK/secret"
[ -n "$PW" ] || fail "The password was empty."`
    : ''
}
`

/** A literal file written by the script (no shell expansion inside). */
export const writeFile = (path: string, content: string, mode: string): string => {
  if (content.includes('FEATURED_VPS_EOF')) throw new Error('Bad file content.')
  return `cat > ${shQuote(path)} <<'FEATURED_VPS_EOF'
${content.replace(/\n$/, '')}
FEATURED_VPS_EOF
chmod ${mode} ${shQuote(path)}`
}

/**
 * Write sshd_config with per-source penalties, and fall back to the same
 * config without them when this sshd is older than 9.8 and rejects the line.
 */
export const writeSshdConfig = (sshd: string, path: string, withPenalties: string, without: string): string => `
${writeFile(path, withPenalties, '644')}
if ! ${shQuote(sshd)} -t -f ${shQuote(path)} >/dev/null 2>&1; then
${writeFile(path, without, '644')}
  ERR=$(${shQuote(sshd)} -t -f ${shQuote(path)} 2>&1 | tr '\\n' ' ' | cut -c1-200)
  ${shQuote(sshd)} -t -f ${shQuote(path)} >/dev/null 2>&1 || fail "sshd rejected the configuration: $ERR"
fi`

/**
 * The guard, run by the service manager once a minute as root: counts wrong
 * passwords in the server's log and locks the account for a while when there
 * are too many. State files are world-readable so the app can show the lock.
 */
export const guardScript = (dir: string, lockCommand: string, unlockCommand: string): string => `#!/bin/sh
# Featured App VPS guard: temporary account lockout after repeated failed logins.
PATH=/usr/sbin:/usr/bin:/sbin:/bin
DIR=${shQuote(dir)}
LOG="$DIR/sshd.log"
NOW=$(date +%s)
OFF=$(cat "$DIR/guard.offset" 2>/dev/null || echo 0)
case "$OFF" in ''|*[!0-9]*) OFF=0 ;; esac
SIZE=$(wc -c < "$LOG" 2>/dev/null | tr -d ' ')
case "$SIZE" in ''|*[!0-9]*) SIZE=0 ;; esac
[ "$SIZE" -lt "$OFF" ] && OFF=0
N=$(tail -c +$((OFF + 1)) "$LOG" 2>/dev/null | grep -cE 'Failed password|Invalid user')
case "$N" in ''|*[!0-9]*) N=0 ;; esac
touch "$DIR/guard.fails"
i=0
while [ "$i" -lt "$N" ]; do echo "$NOW" >> "$DIR/guard.fails"; i=$((i + 1)); done
awk -v c=$((NOW - ${VPS_GUARD.windowSeconds})) '$1 >= c' "$DIR/guard.fails" > "$DIR/guard.fails.n" && mv "$DIR/guard.fails.n" "$DIR/guard.fails"
chmod 644 "$DIR/guard.fails"
COUNT=$(wc -l < "$DIR/guard.fails" | tr -d ' ')
if [ -f "$DIR/guard.lock" ]; then
  UNTIL=$(cat "$DIR/guard.lock" 2>/dev/null || echo 0)
  case "$UNTIL" in ''|*[!0-9]*) UNTIL=0 ;; esac
  if [ "$NOW" -ge "$UNTIL" ]; then
    ${unlockCommand} >/dev/null 2>&1
    rm -f "$DIR/guard.lock"
    : > "$DIR/guard.fails"
  fi
elif [ "$COUNT" -ge ${VPS_GUARD.threshold} ]; then
  ${lockCommand} >/dev/null 2>&1
  echo $((NOW + ${VPS_GUARD.lockSeconds})) > "$DIR/guard.lock"
  chmod 644 "$DIR/guard.lock"
fi
# Keep the log small (sshd appends, so truncating in place is safe).
if [ "$SIZE" -gt 5242880 ]; then
  tail -c 1048576 "$LOG" > "$LOG.n" && cat "$LOG.n" > "$LOG"
  rm -f "$LOG.n"
  SIZE=$(wc -c < "$LOG" | tr -d ' ')
fi
echo "$SIZE" > "$DIR/guard.offset"
`

/** Wait up to ~15 s for something to answer on the port. `probe` is a shell test command. */
export const waitForPort = (probe: string, message: string): string => `
i=0
until ${probe}; do
  i=$((i + 1))
  [ "$i" -ge 15 ] && fail ${shQuote(message)}
  sleep 1
done`
