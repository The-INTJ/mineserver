#!/usr/bin/env bash
# Start the active profile and watch it: prints progress, detects a stalled JVM (debug.log not
# growing) and thread-dumps it, stops when the server leaves "starting".
B=http://127.0.0.1:3400/api
RT=${1:-forge-1.20.1}
JSTACK="${2:-/c/Program Files/Java/jdk-17/bin/jstack.exe}"
MAX=${3:-300}
DL=/e/Coding/mineserver/data/servers/$RT/logs/debug.log
j() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(String(eval(process.argv[1])))})' "$1"; }
curl -s -X POST $B/server/start -H 'content-type: application/json' -d '{}' | j 'j.error ? "ERROR "+j.error : "started pid "+j.pid'; echo
PID=$(curl -s $B/status | j 'j.server.pid')
n=0; lastsize=0; stale=0
while [ $n -lt $MAX ]; do
  sleep 2; n=$((n+1))
  st=$(curl -s $B/status | j 'j.server.status')
  size=$(stat -c %s "$DL" 2>/dev/null || echo 0)
  if [ "$size" != "$lastsize" ]; then stale=0; lastsize=$size; else stale=$((stale+1)); fi
  if [ $((n % 30)) -eq 0 ]; then echo "[$((n*2))s] $st; debug.log $((size/1024))KB; last: $(tail -1 "$DL" | cut -c1-130)"; fi
  if [ "$st" != "starting" ]; then echo "state=$st at $((n*2))s"; break; fi
  if [ $stale -ge 45 ]; then echo "STALL 90s at $((size/1024))KB; main thread:"; "$JSTACK" $PID 2>&1 | grep -A12 '"main"' | head -16; break; fi
done
echo "--- state ---"; curl -s $B/status | j 'JSON.stringify(j.server)'; echo
echo "--- key lines ---"
grep -E "Done \(|Missing or unsupported|Mod ID:|FATAL|/ERROR\]|Preparing level|Loading [0-9]+ mod|Starting minecraft server|Forge mod loading" "$DL" | grep -vE "^\s+at " | tail -20 | cut -c1-220
