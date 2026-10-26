#!/usr/bin/env bash
set -euo pipefail

app_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
matching_pids=()

for proc_dir in /proc/[0-9]*; do
  [[ -r "$proc_dir/cwd" && -r "$proc_dir/cmdline" ]] || continue
  process_cwd="$(readlink -f -- "$proc_dir/cwd" 2>/dev/null || true)"
  [[ "$process_cwd" == "$app_dir" ]] || continue

  process_args=()
  mapfile -d '' -t process_args <"$proc_dir/cmdline" 2>/dev/null || continue
  [[ ${#process_args[@]} -ge 2 ]] || continue
  [[ "${process_args[0]##*/}" == node && "${process_args[1]}" == server.js ]] || continue
  matching_pids+=("${proc_dir##*/}")
done

if [[ ${#matching_pids[@]} -eq 0 ]]; then
  printf 'پردازش PnuNews پیدا نشد؛ هیچ پردازشی متوقف نشد.\nNo PnuNews node server.js process found; nothing was stopped.\n' >&2
  exit 1
fi
if [[ ${#matching_pids[@]} -ne 1 ]]; then
  printf 'بیش از یک پردازش PnuNews پیدا شد؛ برای ایمنی هیچ‌کدام متوقف نشدند.\nMultiple PnuNews processes found; none was stopped.\n' >&2
  exit 1
fi

pid="${matching_pids[0]}"
if ! kill -TERM "$pid" 2>/dev/null; then
  if kill -0 "$pid" 2>/dev/null; then
    printf 'ارسال SIGTERM به پردازش PnuNews ناموفق بود.\nCould not signal the PnuNews process.\n' >&2
    exit 1
  fi
fi

for _ in {1..40}; do
  if ! kill -0 "$pid" 2>/dev/null; then
    printf 'پردازش PnuNews متوقف شد؛ start-all.sh آن را دوباره اجرا می‌کند.\nPnuNews stopped; start-all.sh will respawn it.\n'
    exit 0
  fi
  sleep 0.25
done

printf 'پردازش PnuNews پس از ۱۰ ثانیه متوقف نشد؛ برای ایمنی SIGKILL ارسال نشد.\nPnuNews did not stop within 10 seconds; SIGKILL was not sent.\n' >&2
exit 1
