// The build date shown in "About": "۲۰ مهر ماه ۱۴۰۵ ساعت ۱۶:۲۷" (Jalali date, Tehran time).
// The moment itself is written into /build-info.json by scripts/make-deploy-branch.sh when the deploy branch is built, so a
// copy that did not come from that script (development, a plain checkout of main) has no file and shows no build date.
const dateParts = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', day: 'numeric', month: 'long', year: 'numeric' });
const time = new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export function formatBuildDate(value) {
  const at = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(at.getTime())) return '';
  const part = Object.fromEntries(dateParts.formatToParts(at).map((piece) => [piece.type, piece.value]));
  if (!part.day || !part.month || !part.year) return '';
  return `${part.day} ${part.month} ماه ${part.year} ساعت ${time.format(at)}`;
}

// Resolves to the text, or '' when there is no build info (404, offline, damaged file): the About dialog then simply has no such line.
export async function loadBuildDate() {
  try {
    const response = await fetch('/build-info.json', { cache: 'no-cache', headers: { accept: 'application/json' } });
    if (!response.ok) return '';
    return formatBuildDate((await response.json())?.builtAt);
  } catch {
    return '';
  }
}
