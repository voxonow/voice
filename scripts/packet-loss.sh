#!/usr/bin/env bash
# Packet loss (and delay) on the demo's media traffic only — macOS, for the
# M1 listening test "is speech intelligible at 5% loss?".
#
#   scripts/packet-loss.sh plan            dry run (default): scope checks and
#                                          the exact root script; changes nothing
#   scripts/packet-loss.sh apply --yes     apply (one sudo prompt); reverts
#                                          itself after AUTO_REVERT_MIN minutes
#   scripts/packet-loss.sh revert          remove everything it added (sudo)
#   scripts/packet-loss.sh status          show what is active (sudo)
#
# Settings (environment):
#   LOSS=0.05          packet loss rate (0–1)
#   DELAY_MS=100       added one-way delay
#   DIRECTION=out      out  = voice server → participants (what listeners hear)
#                      in   = participants → voice server
#                      both = both (end-to-end loss then roughly doubles)
#   PORTS=40000:40001  the voice server's media ports (RTC_PORT_BASE ..
#                      RTC_PORT_BASE + NUM_WORKERS - 1)
#   AUTO_REVERT_MIN=30
#
# Scope: only UDP packets to/from PORTS that stay inside this Mac's LAN
# subnet(s). TCP (including ICE-TCP on the same ports), every other port and
# all internet traffic are untouched. Rules live in their own pf anchor
# (com.apple/voxonow-voice-loss — macOS evaluates com.apple/* by default), so
# the system's pf configuration is never edited; pf is enabled with a
# reference token and that reference is released on revert.
set -euo pipefail

LOSS="${LOSS:-0.05}"
DELAY_MS="${DELAY_MS:-100}"
DIRECTION="${DIRECTION:-out}"
PORTS="${PORTS:-40000:40001}"
AUTO_REVERT_MIN="${AUTO_REVERT_MIN:-30}"
ANCHOR="com.apple/voxonow-voice-loss"
PIPE=45170
STATE_DIR="$(cd "$(dirname "$0")/.." && pwd)/.dev-logs"
STATE="$STATE_DIR/packet-loss.state"

die() { echo "error: $*" >&2; exit 1; }

[[ "$(uname -s)" == Darwin ]] || die "macOS only (uses pf + dummynet)"
[[ "$LOSS" =~ ^0(\.[0-9]+)?$|^1(\.0+)?$ ]] || die "LOSS must be between 0 and 1, got $LOSS"
[[ "$DELAY_MS" =~ ^[0-9]+$ && "$DELAY_MS" -le 1000 ]] || die "DELAY_MS must be 0–1000, got $DELAY_MS"
[[ "$DIRECTION" =~ ^(out|in|both)$ ]] || die "DIRECTION must be out, in or both"
[[ "$PORTS" =~ ^([0-9]+):([0-9]+)$ ]] || die "PORTS must look like 40000:40001"
PORT_LO="${BASH_REMATCH[1]}"; PORT_HI="${BASH_REMATCH[2]}"
(( PORT_LO >= 1024 && PORT_HI >= PORT_LO && PORT_HI - PORT_LO < 16 )) || die "PORTS must be ≥1024 and at most 16 ports"
[[ "$AUTO_REVERT_MIN" =~ ^[0-9]+$ && "$AUTO_REVERT_MIN" -ge 1 && "$AUTO_REVERT_MIN" -le 240 ]] || die "AUTO_REVERT_MIN must be 1–240"

# This Mac's IPv4 subnets in CIDR form (e.g. 192.168.1.0/24).
subnets() {
  node -e '
    const seen = new Set();
    for (const l of Object.values(require("os").networkInterfaces()))
      for (const a of l ?? []) if (a.family === "IPv4" && !a.internal) {
        const [ip, bits] = a.cidr.split("/");
        const n = ip.split(".").reduce((x, p) => (x << 8) + +p, 0) >>> 0;
        const m = bits === "0" ? 0 : (~0 << (32 - +bits)) >>> 0;
        const net = (n & m) >>> 0;
        seen.add([net >>> 24, (net >> 16) & 255, (net >> 8) & 255, net & 255].join(".") + "/" + bits);
      }
    console.log([...seen].join(" "));'
}

rules() {
  local nets; nets="$(subnets)"
  [[ -n "$nets" ]] || die "no LAN interface found"
  local list="{ ${nets// /, } }"
  if [[ "$DIRECTION" == out || "$DIRECTION" == both ]]; then
    echo "dummynet out quick proto udp from any port $PORT_LO:$PORT_HI to $list pipe $PIPE"
  fi
  if [[ "$DIRECTION" == in || "$DIRECTION" == both ]]; then
    echo "dummynet in quick proto udp from $list to any port $PORT_LO:$PORT_HI pipe $PIPE"
  fi
}

# Who listens on the media ports: must be the voice server's mediasoup workers.
scope_check() {
  local listeners others
  # lsof matches local OR remote port; keep sockets whose LOCAL port is in
  # range (a browser connected *to* the server is not a competing user).
  listeners="$(lsof -nP -iUDP:"$PORT_LO"-"$PORT_HI" 2>/dev/null | awk -v lo="$PORT_LO" -v hi="$PORT_HI" '
    NR > 1 { local = $9; sub(/->.*/, "", local); n = split(local, part, ":"); port = part[n] + 0
             if (port >= lo && port <= hi) print $1 }' | sort -u || true)"
  if [[ -z "$listeners" ]]; then
    echo "  ✗ nothing listens on UDP ${PORT_LO}–${PORT_HI} — start the voice server first (npm run dev / dev:lan)"
    return 1
  fi
  others="$(grep -v '^mediasoup' <<<"$listeners" || true)"
  if [[ -n "$others" ]]; then
    echo "  ✗ other processes use UDP ${PORT_LO}–${PORT_HI}: $others — refusing (would affect them)"
    return 1
  fi
  echo "  ✓ UDP ${PORT_LO}–${PORT_HI} is used only by mediasoup-worker (the voice server)"
}

# Cleanup shared by apply's failure path, revert and the auto-revert. Dummynet
# rules are flushed explicitly: macOS documents `-F all` for filter, nat,
# queue, state and table data only, not dummynet.
cleanup_lines() {
  cat <<EOF
/sbin/pfctl -q -a $ANCHOR -F dummynet 2>/dev/null || true
/sbin/pfctl -q -a $ANCHOR -F all 2>/dev/null || true
/usr/sbin/dnctl pipe $PIPE delete 2>/dev/null || true
EOF
}

root_script() {
  # The exact script run as root by `apply`. Printed in full by `plan`.
  cat <<EOF
set -u
token=""
fail() {
  echo "apply failed: \$1 - undoing" >&2
$(cleanup_lines | sed 's/^/  /')
  if [ -n "\$token" ]; then /sbin/pfctl -q -X "\$token" 2>/dev/null || true; fi
  rm -f '$STATE'
  exit 1
}
trap 'fail interrupted' INT TERM HUP
rules_file="\$(mktemp /tmp/voxonow-voice-loss.XXXXXX)" || fail mktemp
cat > "\$rules_file" <<'RULES'
$(rules)
RULES
/usr/sbin/dnctl pipe $PIPE config plr $LOSS delay $DELAY_MS || fail dnctl
/sbin/pfctl -q -a $ANCHOR -f "\$rules_file" || fail "pfctl load"
rm -f "\$rules_file"
# Enable pf by reference: if pf was already on for others, releasing our token
# later leaves it on; if only we turned it on, it goes off again.
token="\$(/sbin/pfctl -E 2>&1 | sed -n 's/^Token : //p')"
[ -n "\$token" ] || fail "pf enabled but no token reported (see: pfctl -s References)"
mkdir -p '$STATE_DIR'
# State is written before anything else can fail, so revert always has the token.
printf 'token=%s\napplied=%s\nloss=%s\ndelay_ms=%s\ndirection=%s\nports=%s\n' "\$token" "\$(date -u +%FT%TZ)" '$LOSS' '$DELAY_MS' '$DIRECTION' '$PORTS' > '$STATE'
chown "\${SUDO_USER:-root}" '$STATE' 2>/dev/null || true
# Automatic revert after $AUTO_REVERT_MIN min. The marker in its command line lets
# 'revert' check the pid is really this process before killing it.
nohup /bin/sh -c "sleep $(( AUTO_REVERT_MIN * 60 )); : voxonow-voice-loss-reverter; $(cleanup_lines | tr '\n' ';' | sed 's/;$//'); /sbin/pfctl -q -X \$token; rm -f '$STATE'" >/dev/null 2>&1 &
echo "reverter=\$!" >> '$STATE'
trap - INT TERM HUP
EOF
}

revert_script() {
  # The exact script run as root by `revert` (and printed by `plan`).
  cat <<EOF
$(cleanup_lines)
if [ -f '$STATE' ]; then
  token="\$(sed -n 's/^token=//p' '$STATE')"
  reverter="\$(sed -n 's/^reverter=//p' '$STATE')"
  if [ -n "\$token" ]; then /sbin/pfctl -q -X "\$token" 2>/dev/null || true; fi
  # Kill only if the pid is still our reverter (after a reboot it may not be).
  if [ -n "\$reverter" ] && ps -o command= -p "\$reverter" 2>/dev/null | grep -q voxonow-voice-loss-reverter; then
    kill "\$reverter" 2>/dev/null || true
  fi
  rm -f '$STATE'
fi
echo "reverted: dummynet + rules flushed in $ANCHOR, pipe $PIPE deleted, pf reference released"
EOF
}

plan() {
  echo "Packet loss plan (dry run — nothing is changed)"
  echo "  loss $LOSS, delay ${DELAY_MS} ms, direction $DIRECTION, UDP ports ${PORT_LO}–${PORT_HI}"
  echo "  LAN subnets: $(subnets)"
  echo "  auto-revert after $AUTO_REVERT_MIN min; manual: scripts/packet-loss.sh revert"
  if [[ -f "$STATE" ]]; then echo "  ! already applied (state: $STATE) — run revert first"; fi
  echo
  echo "Scope check:"
  local ok=0; scope_check || ok=1
  echo
  echo "pf rules (anchor $ANCHOR):"
  rules | sed 's/^/  /'
  echo
  echo "Not affected: TCP (incl. ICE-TCP), any other port, traffic leaving the LAN, the system pf.conf."
  echo
  echo "Root script that 'apply --yes' runs with one 'sudo /bin/sh' (shown in full):"
  echo "----------------------------------------------------------------------"
  root_script
  echo "----------------------------------------------------------------------"
  echo
  echo "Root script that 'revert' (and the auto-revert) runs (shown in full):"
  echo "----------------------------------------------------------------------"
  revert_script
  echo "----------------------------------------------------------------------"
  return $ok
}

case "${1:-plan}" in
  plan)
    plan
    ;;
  apply)
    [[ "${2:-}" == --yes ]] || die "apply changes system networking; review 'plan' first, then run: $0 apply --yes"
    [[ -f "$STATE" ]] && die "already applied ($STATE); run '$0 revert' first"
    plan || die "scope check failed; nothing applied"
    echo
    sudo /bin/sh -c "$(root_script)"
    echo "applied. revert any time with: $0 revert   (automatic after $AUTO_REVERT_MIN min)"
    ;;
  revert)
    sudo /bin/sh -c "$(revert_script)"
    ;;
  status)
    [[ -f "$STATE" ]] && { echo "state ($STATE):"; sed 's/^/  /' "$STATE"; } || echo "no state file: not applied by this script"
    echo "anchor $ANCHOR dummynet rules (none listed = clean):"; sudo /sbin/pfctl -a "$ANCHOR" -s dummynet 2>/dev/null | sed 's/^/  /' || true
    echo "pipe $PIPE:"; sudo /usr/sbin/dnctl pipe show "$PIPE" 2>/dev/null | sed 's/^/  /' || true
    ;;
  *)
    die "usage: $0 plan | apply --yes | revert | status"
    ;;
esac
