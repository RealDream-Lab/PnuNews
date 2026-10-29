#!/usr/bin/env bash
# Entry point for schedulers (cron, systemd timer, ...). Works on the host or inside the `nodejs` container:
#   docker exec nodejs bash /workspace/PnuNews/scripts/fetch-portal-news.sh
# It reads the same secrets file (.autostart) as the web server and never runs two imports at once.
set -euo pipefail

app_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$app_dir"

if [[ -f .autostart ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.autostart
  set +a
fi

lock_file="${PORTAL_FETCH_LOCK:-${TMPDIR:-/tmp}/pnunews-portal-fetch.lock}"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$lock_file"
  if ! flock -n 9; then
    echo "[portal-news] اجرای قبلی هنوز در حال انجام است؛ رد شد." >&2
    exit 0
  fi
fi

exec timeout "${PORTAL_FETCH_TIMEOUT:-120}" node scripts/fetch-portal-news.js "$@"
