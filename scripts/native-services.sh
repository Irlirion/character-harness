#!/bin/sh
set -eu
mode=${1:?Usage: native-services.sh check|start|stop|status}
domain="gui/$(id -u)"
agent_dir="${NATIVE_AGENT_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)/work/local-services/launchagents}"
ctl=${LAUNCHCTL:-launchctl}
labels='org.characterharness.qwen-tts org.characterharness.audio-worker'
probe=${NATIVE_CURL:-curl}
sleeper=${NATIVE_SLEEP:-sleep}
pid_of() { "$ctl" print "$1" 2>/dev/null | awk '/^[[:space:]]*pid = [0-9]+/ { print $3; exit }'; }
case "$mode" in
 check|start)
  for label in $labels; do
   agent="$agent_dir/$label.plist"
   test -f "$agent" || { echo "Missing LaunchAgent: $agent" >&2; exit 1; }
  done
  if test "$mode" = check; then exit 0; fi
  for label in $labels; do
   service="$domain/$label"
   "$ctl" enable "$service"
   if ! "$ctl" print "$service" >/dev/null 2>&1; then "$ctl" bootstrap "$domain" "$agent_dir/$label.plist"; fi
   "$ctl" kickstart "$service"
   "$ctl" print "$service" >/dev/null || { echo "Service not loaded: $label" >&2; exit 1; }
   attempts=0
   while test -z "$(pid_of "$service")"; do
    attempts=$((attempts+1)); test "$attempts" -lt 20 || { echo "Service did not start: $label" >&2; exit 1; }
    "$sleeper" 0.25
   done
   if test "$label" = org.characterharness.qwen-tts; then
    attempts=0
    until "$probe" --silent --fail --max-time 1 --output /dev/null http://127.0.0.1:3081/ready; do
     attempts=$((attempts+1)); test "$attempts" -lt 60 || { echo "TTS readiness timed out" >&2; exit 1; }
     "$sleeper" 0.5
    done
   fi
   "$sleeper" 0.5
   test -n "$(pid_of "$service")" || { echo "Service exited during startup: $label" >&2; exit 1; }
  done
 ;;
 stop)
  failed=0
  # Stop the producer first, then the voice server. Disable survives login/restart.
  for label in org.characterharness.audio-worker org.characterharness.qwen-tts; do
   service="$domain/$label"
   if ! "$ctl" disable "$service"; then failed=1; fi
   if "$ctl" print "$service" >/dev/null 2>&1; then
    if ! "$ctl" bootout "$service"; then failed=1; fi
   fi
   if "$ctl" print "$service" >/dev/null 2>&1; then echo "Service is still loaded: $label" >&2; failed=1; fi
  done
  exit "$failed"
 ;;
 status)
  for label in $labels; do
   service="$domain/$label"
   pid=$(pid_of "$service")
   if test -n "$pid"; then echo "$label: running (PID $pid)";
   elif "$ctl" print "$service" >/dev/null 2>&1; then echo "$label: loaded, not running";
   else echo "$label: stopped"; fi
  done
 ;;
 *) echo "Usage: native-services.sh check|start|stop|status" >&2; exit 2 ;;
esac
