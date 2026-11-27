// Reader accounts: login and signup by SMS, and the profile. Loaded on the first tap of the account button, so the ordinary
// reader never downloads it. The server is the authority on everything here (/api/reader/*); this only draws the steps:
// phone -> code -> (a new reader's form) -> done, and the profile of a signed-in reader.
//
// Two ways to prove the number, chosen by the main admin (context.authMethod, from the public config):
//   sms_send    (default, also when the value is missing or unknown): we send a code, the reader types it.
//   sms_receive: the reader sends an SMS from their own SIM to our line; the page waits and the server tells it when it arrived
//                (step «inbound»). The signup form and the profile after the proof are the same for both.
import { bindDigitField, codeDigits, formatPhone, isNationalPhone, nationalPhone, studentDigits, toFaDigits } from '/shared/digits.v0.1.156.js';
import { fetchOrExplain } from '/shared/network-error.v0.1.156.js';

export const BENEFIT_TEXT = 'با ساختن حساب، دنیای خبری خودتان را بسازید: خبرهای دلخواه را نشان‌دار کنید و در هر دستگاهی دوباره پیدا کنید. اگر دانشجو هستید و شمارهٔ دانشجویی‌تان را وارد کنید، اطلاع‌رسانی‌های ویژهٔ مرکز و دانشگاه خودتان زودتر به دستتان می‌رسد و از قابلیت‌های شخصی‌سازی‌شدهٔ آینده نیز پیش از دیگران بهره‌مند می‌شوید. ثبت‌نام فقط چند لحظه طول می‌کشد و راهی است برای اینکه سامانه بیشتر به نیاز شما نزدیک شود.';

const faNumber = new Intl.NumberFormat('fa-IR');
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

const TITLES = {
  phone: ['ورود یا ثبت‌نام', 'با شمارهٔ موبایل وارد شوید؛ یک کد پیامکی برایتان می‌فرستیم.'],
  phoneReceive: ['ورود یا ثبت‌نام', 'با شمارهٔ موبایل وارد شوید؛ کافی است یک پیامک کوتاه از همان شماره برایمان بفرستید.'],
  inbound: ['ارسال پیامک برای ورود', 'پیامک را از شمارهٔ خودتان بفرستید؛ ورود به‌طور خودکار انجام می‌شود.'],
  code: ['کد تأیید', 'کد ۶ رقمی پیامک‌شده را وارد کنید.'],
  signup: ['تکمیل ثبت‌نام', 'برای ساختن حساب چند اطلاعات ساده لازم است.'],
  profile: ['حساب من', 'اطلاعات خود را همین‌جا ویرایش کنید.'],
};

let dialog = null;
let context = null; // { user, provinces, defaultUnitId, showToast, onUser, onDisabled } of the last openAccount call
let view = 'phone';
const flow = { phone: '', token: '', timer: null, resendLeft: 0, busy: false, inbound: null };

// How the number is proved. Anything but the exact value «sms_receive» (a missing value, a cached older page) is the original method.
const methodOf = () => (context?.authMethod === 'sms_receive' ? 'sms_receive' : 'sms_send');

const POLL_MS = 2500;

// iPhone and iPad, also an iPad that says it is a Mac (iPadOS) but has a touch screen.
export function isIos(nav = globalThis.navigator) {
  if (!nav) return false;
  return /iPhone|iPad|iPod/.test(nav.userAgent ?? '') || (nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1);
}

// A device with a touch screen may have an SMS app; a desktop does not, and only gets the text instructions.
export function hasTouch(win = globalThis.window, nav = globalThis.navigator) {
  return (nav?.maxTouchPoints ?? 0) > 0 || (win ? 'ontouchstart' in win : false);
}

// The link that opens the SMS app with the line and the text filled in. Android wants «?body=», iOS wants «&body=».
// Built only from the server's answer; nothing here invents a code. null when the line is not a plausible international number.
export function buildSmsLink(line, body, ios) {
  if (!/^\+\d{8,18}$/.test(String(line ?? '')) || typeof body !== 'string' || !body) return null;
  return `sms:${line}${ios ? '&' : '?'}body=${encodeURIComponent(body)}`;
}

async function api(path, { method = 'POST', body } = {}) {
  const response = await fetchOrExplain(path, {
    method,
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  let data = {};
  try { data = await response.json(); } catch { /* an empty or broken body */ }
  if (!response.ok) {
    const error = new Error(data.error || 'انجام درخواست ممکن نشد.');
    Object.assign(error, { status: response.status, code: data.code, retryAfter: data.retry_after, attemptsLeft: data.attempts_left });
    throw error;
  }
  return data;
}

const panelBody = () => dialog.querySelector('.account-body');
const fieldOf = (name) => panelBody().querySelector(`[name="${name}"]`);

function setError(message) {
  const box = panelBody().querySelector('.account-error');
  if (!box) return;
  box.textContent = message ?? '';
  box.hidden = !message;
}

// Disables the submit button and shows what is happening while a request is out.
async function busy(button, label, work) {
  const original = button.textContent;
  flow.busy = true; // the sixth digit and the Enter key must not send the same code twice
  button.disabled = true;
  button.textContent = label;
  try {
    return await work();
  } finally {
    flow.busy = false;
    button.disabled = false;
    button.textContent = original;
  }
}

function stopTimer() {
  clearInterval(flow.timer);
  flow.timer = null;
}

// Everything of the waiting step: the countdown, the poll, the listener for coming back from the SMS app. A late answer of a request
// that was already out is ignored (the state is marked done), so a closed dialog or a changed step is never redrawn.
function stopInbound() {
  const state = flow.inbound;
  if (!state) return;
  state.done = true;
  clearInterval(state.tick);
  clearTimeout(state.poll);
  document.removeEventListener('visibilitychange', state.onVisible);
  flow.inbound = null;
}

function startTimer(seconds) {
  stopTimer();
  flow.resendLeft = Math.max(0, Math.ceil(seconds));
  paintResend();
  if (!flow.resendLeft) return;
  flow.timer = setInterval(() => {
    flow.resendLeft -= 1;
    paintResend();
    if (flow.resendLeft <= 0) stopTimer();
  }, 1000);
}

function paintResend() {
  const button = dialog?.querySelector('[data-resend]');
  if (!button) return;
  button.disabled = flow.resendLeft > 0;
  button.textContent = flow.resendLeft > 0 ? `ارسال دوباره کد (${faNumber.format(flow.resendLeft)})` : 'ارسال دوباره کد';
}

function unitOptions(selectedId) {
  const provinces = context?.provinces ?? [];
  if (!provinces.length) return '<option value="" disabled selected>فهرست مراکز هنوز آماده نیست</option>';
  const placeholder = selectedId ? '' : '<option value="" disabled selected>انتخاب کنید…</option>';
  return placeholder + provinces
    .filter((province) => province.cities?.length)
    .map((province) => `<optgroup label="${escapeHtml(province.name)}">${province.cities
      .map((city) => `<option value="${Number(city.id)}"${Number(city.id) === Number(selectedId) ? ' selected' : ''}>${escapeHtml(city.name)}</option>`)
      .join('')}</optgroup>`)
    .join('');
}

// The fields shared by the signup form and the profile.
function personFields(values = {}) {
  const student = Boolean(values.is_student);
  return `
    <div class="account-two">
      <label class="account-field"><span>نام</span><input name="first_name" type="text" autocomplete="given-name" maxlength="60" required value="${escapeHtml(values.first_name ?? '')}"></label>
      <label class="account-field"><span>نام خانوادگی</span><input name="last_name" type="text" autocomplete="family-name" maxlength="60" required value="${escapeHtml(values.last_name ?? '')}"></label>
    </div>
    <label class="account-field"><span>مرکز دانشگاهی</span><select name="unit_id" required>${unitOptions(values.unit_id ?? context?.defaultUnitId)}</select></label>
    <label class="account-switch"><input type="checkbox" name="is_student"${student ? ' checked' : ''}><span class="account-switch-track" aria-hidden="true"></span><span>دانشجو هستم</span></label>
    <div class="account-reveal${student ? ' is-open' : ''}" data-student-field${student ? '' : ' inert'}>
      <div class="account-reveal-inner">
        <label class="account-field"><span>شمارهٔ دانشجویی</span><input name="student_no" type="text" inputmode="numeric" autocomplete="off" dir="ltr" placeholder="مثلاً ۴۰۱۲۳۴۵۶۷۸" value="${escapeHtml(toFaDigits(values.student_no ?? ''))}"></label>
      </div>
    </div>`;
}

// The step of the receiving method. The line and the text are always visible as text with copy buttons (a desktop has no SMS app);
// the button that opens the SMS app is drawn only on a touch device.
function inboundTemplate() {
  const state = flow.inbound ?? {};
  const link = hasTouch() ? buildSmsLink(state.line, state.body, isIos()) : null;
  return `
      <div class="account-inbound" data-form="inbound">
        <p class="account-lead">از شمارهٔ <bdi dir="ltr">${escapeHtml(formatPhone(flow.phone))}</bdi> یک پیامک با متن زیر به خط <bdi dir="ltr">${escapeHtml(toFaDigits(state.line ?? ''))}</bdi> بفرستید.</p>
        ${link ? `<a class="account-primary account-sms-link" data-sms-link href="${escapeHtml(link)}">ارسال پیامک</a>` : ''}
        <div class="account-copy-row">
          <span class="account-copy-label">شمارهٔ گیرنده</span>
          <strong class="account-copy-value" dir="ltr">${escapeHtml(toFaDigits(state.line ?? ''))}</strong>
          <button class="account-link" type="button" data-copy="line">کپی شماره</button>
        </div>
        <div class="account-copy-row">
          <span class="account-copy-label">متن پیام</span>
          <strong class="account-copy-value" dir="auto">${escapeHtml(state.body ?? '')}</strong>
          <button class="account-link" type="button" data-copy="body">کپی متن پیام</button>
        </div>
        <p class="account-hint">پیامک باید از شمارهٔ <bdi dir="ltr">${escapeHtml(formatPhone(flow.phone))}</bdi> فرستاده شود. اگر گوشی‌تان دو سیم‌کارت دارد، همان سیم‌کارت را انتخاب کنید.</p>
        <p class="account-wait" role="status" aria-live="polite" data-inbound-wait><span class="account-spinner" aria-hidden="true"></span><span>در انتظار پیامک شما… <span data-inbound-left></span></span></p>
        <p class="account-error" role="alert" hidden></p>
        <div class="account-row">
          <button class="account-link" type="button" data-edit-phone>ویرایش شماره</button>
          <button class="account-link" type="button" data-inbound-refresh hidden>دریافت کد تازه</button>
        </div>
      </div>`;
}

// A dashboard user has no phone and nothing to edit here: the post, the unit and the name come from the dashboard.
function staffProfileTemplate(user) {
  const rows = [
    ['نام', `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim()],
    ['سمت', user.staff.role_label],
    ...(user.staff.domain ? [['حوزه', user.staff.domain]] : []),
    ['محل خدمت', user.staff.place],
  ].filter(([, value]) => value);
  return `
      <div class="account-staff" data-form="staff">
        <dl class="account-facts">${rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>
        <p class="account-hint">برای ذخیرهٔ خبرها نیازی به ورود دوباره نیست. اطلاعات این حساب را فقط از داشبورد مدیریت می‌توان تغییر داد.</p>
        <a class="account-primary account-sms-link" href="/dashboard/">رفتن به داشبورد</a>
      </div>`;
}

function render(next, { error = '', focus = true } = {}) {
  if (next !== 'inbound') stopInbound(); // a step change ends the waiting for an SMS
  view = next;
  const staff = next === 'profile' && Boolean(context?.user?.staff);
  const [title, sub] = staff ? ['حساب من', 'با حساب مدیریتی خود وارد شده‌اید.'] : TITLES[next === 'phone' && methodOf() === 'sms_receive' ? 'phoneReceive' : next];
  dialog.querySelector('#account-title').textContent = title;
  dialog.querySelector('#account-sub').textContent = sub;
  const user = context?.user;
  const templates = {
    phone: `
      <form class="account-form" data-form="phone" novalidate>
        <label class="account-field"><span>شمارهٔ موبایل</span>
          <input name="phone" type="tel" inputmode="numeric" autocomplete="tel-national" dir="ltr" placeholder="۰۹۱۲۳۴۵۶۷۸۹" enterkeyhint="send" required value="${escapeHtml(toFaDigits(flow.phone))}">
        </label>
        <p class="account-error" role="alert" hidden></p>
        <button class="account-primary" type="submit">${methodOf() === 'sms_receive' ? 'ادامه' : 'دریافت کد'}</button>
      </form>
      <aside class="account-benefit">${BENEFIT_TEXT}</aside>`,
    inbound: inboundTemplate(),
    code: `
      <form class="account-form" data-form="code" novalidate>
        <p class="account-lead">کد به شمارهٔ <bdi dir="ltr">${escapeHtml(formatPhone(flow.phone))}</bdi> پیامک شد.</p>
        <input class="account-code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" dir="ltr" placeholder="······" enterkeyhint="done" aria-label="کد تأیید ۶ رقمی">
        <p class="account-error" role="alert" hidden></p>
        <button class="account-primary" type="submit">تأیید و ادامه</button>
        <div class="account-row">
          <button class="account-link" type="button" data-resend disabled></button>
          <button class="account-link" type="button" data-edit-phone>ویرایش شماره</button>
        </div>
      </form>`,
    signup: `
      <form class="account-form" data-form="signup" novalidate>
        ${personFields({})}
        <p class="account-error" role="alert" hidden></p>
        <button class="account-primary" type="submit">تکمیل ثبت‌نام</button>
      </form>`,
    profile: user?.staff ? staffProfileTemplate(user) : `
      <form class="account-form" data-form="profile" novalidate>
        <div class="account-phone"><span>شمارهٔ موبایل</span><strong dir="ltr">${escapeHtml(formatPhone(String(user?.phone ?? '').replace(/^\+98/, '0')))}</strong><small>پس از ثبت‌نام قابل تغییر نیست.</small></div>
        ${personFields(user ?? {})}
        <p class="account-error" role="alert" hidden></p>
        <button class="account-primary" type="submit">ذخیرهٔ تغییرات</button>
        <button class="account-secondary" type="button" data-logout>خروج از حساب</button>
      </form>`,
  };
  panelBody().innerHTML = templates[next];
  setError(error);

  const phone = fieldOf('phone');
  if (phone) bindDigitField(phone, nationalPhone);
  const code = fieldOf('code');
  if (code) {
    bindDigitField(code, codeDigits, (value) => {
      if (value.length === 6) panelBody().querySelector('form').requestSubmit(); // the sixth digit sends it
    });
    startTimer(flow.resendLeft);
  }
  const studentNo = fieldOf('student_no');
  if (studentNo) bindDigitField(studentNo, studentDigits);
  if (focus) requestAnimationFrame(() => panelBody().querySelector('input:not([type=checkbox]), select')?.focus());
}

function finish(user, message) {
  stopTimer();
  stopInbound();
  context.user = user;
  context.onUser?.(user);
  dialog.close();
  if (message) context.showToast?.(message);
}

// The three fields the server wants from a form of person details, read from the form.
function readPerson(form) {
  const isStudent = form.elements.is_student.checked;
  return {
    first_name: form.elements.first_name.value.trim(),
    last_name: form.elements.last_name.value.trim(),
    is_student: isStudent,
    student_no: isStudent ? studentDigits(form.elements.student_no.value) : null,
    unit_id: Number(form.elements.unit_id.value),
  };
}

function checkPerson(person) {
  if (person.first_name.length < 2) return 'نام را وارد کنید.';
  if (person.last_name.length < 2) return 'نام خانوادگی را وارد کنید.';
  if (!person.unit_id) return 'مرکز دانشگاهی را انتخاب کنید.';
  if (person.is_student && !/^\d{6,14}$/.test(person.student_no ?? '')) return 'شمارهٔ دانشجویی را فقط با رقم و بین ۶ تا ۱۴ رقم وارد کنید.';
  return '';
}


// The main admin changed the method while this page was open: ask the public config what it is now and start over from the number.
async function methodChanged(message) {
  try {
    const response = await fetchOrExplain('/api/public/config', { headers: { accept: 'application/json' } });
    const data = await response.json();
    context.authMethod = data?.reader?.auth_method === 'sms_receive' ? 'sms_receive' : 'sms_send';
    context.onMethod?.(context.authMethod);
  } catch { /* offline: the message below still tells the reader to refresh */ }
  render('phone', { error: message });
}

function paintInboundLeft() {
  const state = flow.inbound;
  const target = dialog?.querySelector('[data-inbound-left]');
  if (!state || !target) return;
  const left = Math.max(0, Math.ceil((state.expiresAt - Date.now()) / 1000));
  target.textContent = `${faNumber.format(Math.floor(left / 60))}:${faNumber.format(left % 60).padStart(2, '۰')}`;
}

// The waiting is over without an SMS: say so and offer a fresh code. Nothing more is asked of the server.
function showInboundExpired() {
  const state = flow.inbound;
  if (!state) return;
  clearInterval(state.tick);
  clearTimeout(state.poll);
  state.done = true;
  document.removeEventListener('visibilitychange', state.onVisible);
  const wait = dialog.querySelector('[data-inbound-wait]');
  if (wait) wait.hidden = true;
  const link = dialog.querySelector('[data-sms-link]');
  if (link) link.hidden = true;
  dialog.querySelector('[data-inbound-refresh]').hidden = false;
  setError('مهلت این پیامک تمام شد؛ کد تازه بگیرید.');
}

// The proof arrived: a known number is signed in, a new one goes on to the signup form.
function inboundConfirmed(answer) {
  if (answer.needs_signup) {
    flow.token = answer.signup_token;
    render('signup');
  } else finish(answer.user, `خوش آمدید ${answer.user.first_name}`);
}

async function pollInbound() {
  const state = flow.inbound;
  if (!state || state.done || state.busy) return;
  state.busy = true;
  clearTimeout(state.poll);
  let answer = null;
  let failure = null;
  try {
    answer = await api('/api/reader/auth/inbound-status', { body: { handle: state.handle } });
  } catch (error) {
    failure = error;
  }
  if (flow.inbound !== state || state.done) return; // the dialog was closed or the step changed while the question was out
  state.busy = false;
  if (failure) {
    if (failure.code === 'disabled') { context.onDisabled?.(); dialog.close(); context.showToast?.(failure.message); return; }
    if (failure.code === 'methodSend') { await methodChanged(failure.message); return; }
    if (failure.code === 'badHandle') return showInboundExpired();
    return schedulePoll(state); // a dropped connection: the next question may get through
  }
  if (answer.status === 'confirmed') { stopInbound(); return inboundConfirmed(answer); }
  if (answer.status === 'expired') return showInboundExpired();
  // «waiting»: the server's clock decides how much time is left (the phone's clock may be off).
  if (Number.isFinite(answer.expires_in)) state.expiresAt = Date.now() + answer.expires_in * 1000;
  return schedulePoll(state);
}

// Questions are asked only while the page is visible; coming back from the SMS app asks at once (see onVisible).
function schedulePoll(state) {
  clearTimeout(state.poll);
  if (state.done || document.hidden) return;
  state.poll = setTimeout(pollInbound, POLL_MS);
}

function beginInbound(answer) {
  stopInbound(); // a fresh code replaces the previous waiting
  const state = {
    handle: answer.handle, line: answer.line, body: answer.body,
    expiresAt: Date.now() + (Number(answer.expires_in) || 300) * 1000,
    tick: null, poll: null, busy: false, done: false, onVisible: null,
  };
  state.onVisible = () => {
    if (state.done) return;
    if (document.hidden) clearTimeout(state.poll);
    else { paintInboundLeft(); pollInbound(); }
  };
  flow.inbound = state;
  render('inbound'); // draws from flow.inbound
  startTick(state);
  document.addEventListener('visibilitychange', state.onVisible);
  paintInboundLeft();
  schedulePoll(state);
}

// The countdown. At zero one last question is asked (the SMS may have arrived in the final seconds, and the phone's clock may be
// off): only if the server does not confirm and no time is left does the step turn into «expired».
function startTick(state) {
  clearInterval(state.tick);
  state.tick = setInterval(async () => {
    paintInboundLeft();
    if (state.done || state.busy || state.expiresAt - Date.now() > 0) return;
    clearInterval(state.tick);
    await pollInbound();
    if (flow.inbound !== state || state.done) return;
    if (state.expiresAt - Date.now() <= 0) showInboundExpired();
    else startTick(state);
  }, 1000);
}

async function requestInbound(button) {
  try {
    const answer = await busy(button, 'در حال آماده‌سازی…', () => api('/api/reader/auth/request-inbound', { body: { phone: flow.phone } }));
    beginInbound(answer);
  } catch (error) {
    if (error.code === 'disabled') {
      context.onDisabled?.();
      dialog.close();
      context.showToast?.(error.message);
    } else if (error.code === 'methodSend') await methodChanged(error.message);
    else setError(error.message);
  }
}

// The clipboard where it is allowed; otherwise the text is selected in a field that is not shown, which works on older browsers.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* no permission or no clipboard API: use the fallback */ }
  const field = document.createElement('textarea');
  field.className = 'account-copy-sink';
  field.value = text;
  field.setAttribute('readonly', '');
  dialog.append(field);
  field.select();
  let copied = false;
  try { copied = document.execCommand('copy'); } catch { /* not supported */ }
  field.remove();
  return copied;
}

const handlers = {
  async phone(form, button) {
    const phone = nationalPhone(form.elements.phone.value);
    if (!isNationalPhone(phone)) return setError('شمارهٔ موبایل را درست وارد کنید؛ مثلاً ۰۹۱۲۱۲۳۴۵۶۷.');
    setError('');
    flow.phone = phone;
    if (methodOf() === 'sms_receive') return requestInbound(button);
    try {
      const answer = await busy(button, 'در حال ارسال…', () => api('/api/reader/auth/request-code', { body: { phone } }));
      flow.resendLeft = answer.resend_after ?? 60;
      render('code');
    } catch (error) {
      if (error.code === 'tooSoon') { // a code was sent a moment ago and is still good
        flow.resendLeft = error.retryAfter ?? 60;
        render('code');
        setError('کد قبلی هنوز معتبر است؛ همان را وارد کنید.');
      } else if (error.code === 'disabled') {
        context.onDisabled?.();
        dialog.close();
        context.showToast?.(error.message);
      } else if (error.code === 'methodReceive') await methodChanged(error.message);
      else setError(error.message);
    }
  },

  async code(form, button) {
    const code = codeDigits(form.elements.code.value);
    if (code.length !== 6) return setError('کد باید ۶ رقم باشد.');
    setError('');
    try {
      const answer = await busy(button, 'در حال بررسی…', () => api('/api/reader/auth/verify', { body: { phone: flow.phone, code } }));
      if (answer.needs_signup) {
        flow.token = answer.signup_token;
        stopTimer();
        render('signup');
      } else finish(answer.user, `خوش آمدید ${answer.user.first_name}`);
    } catch (error) {
      if (error.code === 'disabled') {
        context.onDisabled?.();
        dialog.close();
        context.showToast?.(error.message);
        return;
      }
      if (error.code === 'methodReceive') { await methodChanged(error.message); return; }
      form.elements.code.value = '';
      if (error.code === 'wrongCode') setError(error.attemptsLeft ? `${error.message} (${faNumber.format(error.attemptsLeft)} بار دیگر می‌توانید امتحان کنید)` : `${error.message} کد تازه بگیرید.`);
      else setError(error.message);
      if (error.code === 'expired' || (error.code === 'wrongCode' && !error.attemptsLeft)) { stopTimer(); flow.resendLeft = 0; paintResend(); } // only a new code can help now
      form.elements.code.focus();
    }
  },

  async signup(form, button) {
    const person = readPerson(form);
    const problem = checkPerson(person);
    if (problem) return setError(problem);
    setError('');
    try {
      const answer = await busy(button, 'در حال ثبت…', () => api('/api/reader/auth/signup', { body: { token: flow.token, ...person } }));
      finish(answer.user, `خوش آمدید ${answer.user.first_name}`);
    } catch (error) {
      if (error.code === 'tokenExpired') { flow.token = ''; render('phone', { error: error.message }); } else setError(error.message);
    }
  },

  async profile(form, button) {
    const person = readPerson(form);
    const problem = checkPerson(person);
    if (problem) return setError(problem);
    setError('');
    try {
      const answer = await busy(button, 'در حال ذخیره…', () => api('/api/reader/me', { method: 'PATCH', body: person }));
      context.user = answer.user;
      context.onUser?.(answer.user);
      context.showToast?.('اطلاعات ذخیره شد');
    } catch (error) {
      setError(error.message);
    }
  },
};

function build() {
  dialog = document.createElement('dialog');
  dialog.className = 'info-dialog account-dialog';
  dialog.setAttribute('aria-labelledby', 'account-title');
  dialog.innerHTML = `
    <div class="info-panel">
      <div class="info-header">
        <div><h2 id="account-title" class="info-title"></h2><p id="account-sub" class="info-sub"></p></div>
        <button class="icon-button info-close" type="button" aria-label="بستن" data-dialog-close><svg class="icon"><use href="#icon-close"/></svg></button>
      </div>
      <div class="account-body"></div>
    </div>`;
  document.body.append(dialog);

  dialog.addEventListener('close', () => { stopTimer(); stopInbound(); });
  dialog.addEventListener('click', async (event) => {
    if (event.target === dialog || event.target.closest('[data-dialog-close]')) return dialog.close();
    if (event.target.closest('[data-edit-phone]')) { stopTimer(); return render('phone'); }
    if (event.target.closest('[data-inbound-refresh]')) return requestInbound(event.target.closest('[data-inbound-refresh]'));
    const copy = event.target.closest('[data-copy]');
    if (copy) {
      const text = copy.dataset.copy === 'line' ? flow.inbound?.line : flow.inbound?.body;
      if (text) context.showToast?.((await copyText(text)) ? (copy.dataset.copy === 'line' ? 'شماره کپی شد' : 'متن پیام کپی شد') : 'کپی نشد؛ متن را نگه دارید و کپی کنید');
      return undefined;
    }
    if (event.target.closest('[data-resend]')) {
      return handlers.phone({ elements: { phone: { value: flow.phone } } }, event.target.closest('[data-resend]'));
    }
    if (event.target.closest('[data-logout]')) {
      try {
        await busy(event.target.closest('[data-logout]'), 'در حال خروج…', () => api('/api/reader/auth/logout'));
        finish(null, 'از حساب خارج شدید');
      } catch (error) {
        setError(error.message); // still signed in: say so instead of pretending
      }
    }
    return undefined;
  });
  dialog.addEventListener('submit', (event) => {
    event.preventDefault();
    if (flow.busy) return;
    const form = event.target;
    const run = handlers[form.dataset.form];
    if (run) run(form, form.querySelector('.account-primary'));
  });
  dialog.addEventListener('change', (event) => {
    if (event.target.name !== 'is_student') return;
    const reveal = panelBody().querySelector('[data-student-field]');
    reveal.classList.toggle('is-open', event.target.checked);
    reveal.toggleAttribute('inert', !event.target.checked);
    if (event.target.checked) reveal.querySelector('input').focus();
  });
}

// options: { user, provinces, defaultUnitId, authMethod, showToast, onUser(user|null), onDisabled(), onMethod(method) }
export function openAccount(options) {
  context = options;
  if (!dialog) build();
  stopInbound();
  flow.token = '';
  render(context.user ? 'profile' : 'phone', { focus: !context.user });
  if (!dialog.open) dialog.showModal();
}

export function closeAccount() {
  stopInbound();
  if (dialog?.open) dialog.close();
}
