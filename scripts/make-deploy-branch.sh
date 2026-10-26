#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/make-deploy-branch.sh [--prepare-only]

Builds local branch deploy from committed main plus Linux x86_64/glibc
production dependencies. The new deploy commit has origin/deploy as a parent, so
the server can update with a plain "git pull --ff-only" and no force-push is needed.
By default, asks before pushing deploy to origin.
--prepare-only builds and verifies the branch without contacting GitHub.
USAGE
}

prepare_only=false
case "${1:-}" in
  '') ;;
  --prepare-only) prepare_only=true ;;
  --help|-h) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repo_root"

if [[ "$(git branch --show-current)" != main ]]; then
  printf 'این فرمان باید از شاخهٔ main اجرا شود.\nRun this script from the main branch.\n' >&2
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  printf 'درخت کاری باید پاک باشد؛ ابتدا تغییرها را commit یا کنار بگذارید.\nWorking tree must be clean; commit or set aside changes first.\n' >&2
  exit 1
fi
if [[ "$(git remote get-url origin)" != 'git@github.com:RealDream-Lab/PnuNews.git' ]]; then
  printf 'آدرس SSH مورد انتظار برای origin تنظیم نشده است.\nExpected SSH origin is not configured.\n' >&2
  exit 1
fi

printf 'بررسی می‌کنم که main محلی شامل origin/main باشد...\n'
git fetch origin main
git fetch origin deploy 2>/dev/null || true
git merge-base --is-ancestor origin/main main || {
  printf 'origin/main جلوتر از main محلی است؛ ابتدا تغییرات را ادغام کنید.\norigin/main is not an ancestor of local main; integrate it first.\n' >&2
  exit 1
}

build_dir="$(mktemp -d "${TMPDIR:-/tmp}/pnunews-deploy.XXXXXX")"
worktree="$build_dir/worktree"
cleanup() {
  git -C "$repo_root" worktree remove --force "$worktree" >/dev/null 2>&1 || true
  rm -rf -- "$build_dir"
}
trap cleanup EXIT INT TERM

git worktree add --detach "$worktree" main
printf 'وابستگی‌های تولید Linux x86_64/glibc را نصب می‌کنم...\n'
npm ci --prefix "$worktree" --omit=dev --os=linux --cpu=x64 --libc=glibc

printf 'باینری sharp را بررسی می‌کنم...\n'
sharp_node="$(find "$worktree/node_modules/@img/sharp-linux-x64/lib" -maxdepth 1 -type f -name 'sharp-linux-x64-*.node' -print -quit)"
libvips_library="$(find "$worktree/node_modules/@img" -path '*/sharp-libvips-linux-x64/lib/libvips-cpp.so.*' -print -quit)"
if [[ ! -f "$sharp_node" || -z "$libvips_library" ]]; then
  printf 'باینری‌های sharp/libvips لینوکس x64 در node_modules پیدا نشدند.\nLinux x64 sharp/libvips binaries were not found in node_modules.\n' >&2
  exit 1
fi
printf 'باینری‌های sharp/libvips لینوکس x64 حاضرند.\nLinux x64 sharp/libvips binaries are present.\n'

git -C "$worktree" -c core.filemode=true add -f node_modules
deploy_tree="$(git -C "$worktree" write-tree)"
parents=(-p main)
if git rev-parse --verify --quiet refs/remotes/origin/deploy >/dev/null; then
  parents=(-p refs/remotes/origin/deploy -p main)
fi
deploy_commit="$(git -C "$worktree" commit-tree "$deploy_tree" "${parents[@]}" -m 'به‌روزرسانی شاخهٔ استقرار از main همراه وابستگی‌های لینوکس')"
git branch -f deploy "$deploy_commit"
printf 'شاخهٔ محلی deploy آماده شد.\nLocal deploy branch is ready.\n'

if [[ "$prepare_only" == true ]]; then
  printf 'حالت prepare-only: هیچ اتصالی به GitHub یا push انجام نشد.\nprepare-only: no GitHub connection or push was made.\n'
  exit 0
fi

printf 'پیش از push، هویت SSH در GitHub را بررسی می‌کنم...\n'
ssh_result="$(ssh -T -o BatchMode=yes git@github.com 2>&1 || true)"
printf '%s\n' "$ssh_result"
if [[ "$ssh_result" != Hi\ * ]]; then
  printf 'احراز هویت SSH تأیید نشد؛ کلید خصوصی را به اشتراک نگذارید و push نکنید.\nGitHub SSH authentication was not confirmed; do not share a private key or push.\n' >&2
  exit 1
fi

printf 'این کار deploy را (بدون force) به origin push می‌کند. ادامه؟ [y/N] '
IFS= read -r answer
if [[ "$answer" != y && "$answer" != Y ]]; then
  printf 'push لغو شد؛ شاخهٔ محلی deploy آماده است.\nPush cancelled; local deploy branch is ready.\n'
  exit 0
fi

git push origin deploy
