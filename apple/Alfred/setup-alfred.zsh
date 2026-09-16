#!/bin/zsh

set -euo pipefail

if [[ $# -ne 2 ]]; then
  /usr/bin/printf '%s\n' "Usage: ./setup-alfred.zsh https://your-omni.example op_capture_..."
  exit 1
fi

service="jp.random-walk.omniplan.capture"
capture_url="${1%/}"
capture_token="$2"

if [[ "$capture_url" != https://* && "$capture_url" != http://127.0.0.1:* && "$capture_url" != http://localhost:* ]]; then
  /usr/bin/printf '%s\n' "Use an HTTPS service URL (localhost is allowed for development)."
  exit 1
fi
if [[ "$capture_token" != op_capture_* ]]; then
  /usr/bin/printf '%s\n' "The token must be a capture-scoped op_capture_ token."
  exit 1
fi

/usr/bin/security add-generic-password -U -s "$service" -a "alfred-url" -w "$capture_url" >/dev/null
/usr/bin/security add-generic-password -U -s "$service" -a "alfred-token" -w "$capture_token" >/dev/null
/usr/bin/printf '%s\n' "Alfred capture service saved in macOS Keychain."
