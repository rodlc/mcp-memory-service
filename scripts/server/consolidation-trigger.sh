#!/bin/bash
# Triggered by launchd com.rodlecoent.mcp-consolidation plist.
# Determines which consolidation horizons to run based on current date,
# then POSTs to the mcp-memory-http API with retry + caffeinate.

set -euo pipefail

LOG="$HOME/Library/Logs/mcp-consolidation.log"
API="http://localhost:4242/api/consolidation/trigger"
MAX_RETRIES=3
BACKOFF=10

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG"; }

trigger() {
    local horizon="$1"
    local attempt=0
    while (( attempt < MAX_RETRIES )); do
        local resp
        resp=$(curl -sf -X POST "$API" \
            -H "Content-Type: application/json" \
            -d "{\"time_horizon\":\"$horizon\"}" 2>&1) && {
            log "OK $horizon: $resp"
            return 0
        }
        attempt=$((attempt + 1))
        log "RETRY $horizon ($attempt/$MAX_RETRIES): $resp"
        sleep $((BACKOFF * attempt))
    done
    log "FAIL $horizon after $MAX_RETRIES attempts"
    return 1
}

log "--- start ---"

caffeinate -i -w $$ &

trigger "daily"

DOW=$(date +%u)  # 6=Saturday
[ "$DOW" -eq 6 ] && trigger "weekly"

DOM=$(date +%d)  # 01-31
[ "$DOM" -eq "01" ] && trigger "monthly"

MON=$(date +%m)  # 01-12
if [ "$DOM" -eq "01" ] && [[ "$MON" =~ ^(01|04|07|10)$ ]]; then
    trigger "quarterly"
fi

log "--- done ---"
