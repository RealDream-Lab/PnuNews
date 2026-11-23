// Reader accounts: login and signup by SMS code, and the profile. Loaded on the first tap of the account button, so the
// ordinary reader never downloads it. The server is the authority on everything here (/api/reader/*); this only draws the
// steps: phone -> code -> (a new reader's form) -> done, and the profile of a signed-in reader.
import { bindDigitField, codeDigits, formatPhone, isNationalPhone, nationalPhone, studentDigits, toFaDigits } from '/shared/digits.v0.1.142.js';
import { fetchOrExplain } from '/shared/network-error.v0.1.142.js';

export const BENEFIT_TEXT = 'با ساختن حساب، دنیای خبری خودتان را بسازید: خبرهای دلخواه را نشان‌دار کنید و در هر دستگاهی دوباره پیدا کنید. اگر دانشجو هستید و شمارهٔ دانشجویی‌تان را وارد کنید، اطلاع‌رسانی‌های ویژهٔ مرکز و دانشگاه خودتان زودتر به دستتان می‌رسد و از قابلیت‌های شخصی‌سازی‌شدهٔ آینده نیز پیش از دیگران بهره‌مند می‌شوید. ثبت‌نام فقط چند لحظه طول می‌کشد و راهی است برای اینکه سامانه بیشتر به نیاز شما نزدیک شود.';

const faNumber = new Intl.NumberFormat('fa-IR');
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

const TITLES = {
  phone: ['ورود یا ثبت‌نام', 'با شمارهٔ موبایل وارد شوید؛ یک کد پیامکی برایتان می‌فرستیم.'],
  code: ['کد تأیید', 'کد ۶ رقمی پیامک‌شده را وارد کنید.'],
  signup: ['تکمیل ثبت‌نام', 'برای ساختن حساب چند اطلاعات ساده لازم است.'],
  profile: ['حساب من', 'اطلاعات خود را همین‌جا ویرایش کنید.'],
};

let dialog = null;
let context = null; // { user, provinces, defaultUnitId, showToast, onUser, onDisabled } of the last openAccount call
let view = 'phone';
const flow = { phone: '', token: '', timer: null, resendLeft: 0, busy: false };

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

function render(next, { error = '', focus = true } = {}) {
  view = next;
  const [title, sub] = TITLES[next];
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
        <button class="account-primary" type="submit">دریافت کد</button>
      </form>
      <aside class="account-benefit">${BENEFIT_TEXT}</aside>`,
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
    profile: `
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

const handlers = {
  async phone(form, button) {
    const phone = nationalPhone(form.elements.phone.value);
    if (!isNationalPhone(phone)) return setError('شمارهٔ موبایل را درست وارد کنید؛ مثلاً ۰۹۱۲۱۲۳۴۵۶۷.');
    setError('');
    flow.phone = phone;
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
      } else setError(error.message);
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

  dialog.addEventListener('close', stopTimer);
  dialog.addEventListener('click', async (event) => {
    if (event.target === dialog || event.target.closest('[data-dialog-close]')) return dialog.close();
    if (event.target.closest('[data-edit-phone]')) { stopTimer(); return render('phone'); }
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

// options: { user, provinces, defaultUnitId, showToast, onUser(user|null), onDisabled() }
export function openAccount(options) {
  context = options;
  if (!dialog) build();
  flow.token = '';
  render(context.user ? 'profile' : 'phone', { focus: !context.user });
  if (!dialog.open) dialog.showModal();
}

export function closeAccount() {
  if (dialog?.open) dialog.close();
}
