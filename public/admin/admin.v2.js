import {
  JALALI_MONTHS,

  jalaliMonthLength,
  jalaliToGregorian,
} from '/shared/jalali.v1.js';

const authRoot = document.getElementById('auth-root');
const adminShell = document.getElementById('admin-shell');
const state = {
  user: null,
  regions: [],
  categories: [],
  settings: {},
  currentNews: null,
  newsCursor: null,
  auditCursor: null,
  newsDates: { published_at: null, expires_at: null },
  calendar: { year: 0, month: 0, day: 0, hour: 12, minute: 0, target: 'published_at' },
  toastTimer: null,
  activeView: '',
  busy: false,
};
const faDigits = new Intl.NumberFormat('fa-IR');
const dateDisplay = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', day: 'numeric', month: 'long', year: 'numeric' });
const dateTimeDisplay = new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const weekdayNames = ['شنبه', 'یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه'];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function normalizeDigits(value) {
  return String(value ?? '').replace(/[۰-۹٠-٩]/g, (digit) => {
    const index = '۰۱۲۳۴۵۶۷۸۹'.indexOf(digit);
    return String(index >= 0 ? index : '٠١٢٣٤٥٦٧٨٩'.indexOf(digit));
  });
}

function showToast(message) {
  const toast = document.getElementById('admin-toast');
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove('visible'), 2800);
}

function showMessage(title, message, secret = '') {
  const dialog = document.getElementById('message-dialog');
  const content = document.getElementById('message-content');
  content.innerHTML = `<p class="eyebrow">اطلاع‌رسانی</p><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p>${secret ? `<div class="temp-secret"><code dir="ltr">${escapeHtml(secret)}</code><button class="button outline" type="button" data-copy-secret>کپی</button></div>` : ''}`;
  dialog.showModal();
}

async function api(path, { method = 'GET', body, formData } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers,
    body: formData ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  let payload;
  try { payload = await response.json(); } catch { payload = {}; }
  if (!response.ok) {
    if (response.status === 401 && !authRoot.hidden) showAuth('login-card');
    throw new Error(payload.error || 'انجام درخواست ناموفق بود.');
  }
  return payload;
}

function showAuth(sectionId) {
  adminShell.hidden = true;
  authRoot.hidden = false;
  authRoot.querySelectorAll(':scope > section').forEach((section) => { section.hidden = section.id !== sectionId; });
}

function closeAuthAndShowAdmin() {
  authRoot.hidden = true;
  adminShell.hidden = false;
}

function roleLabel(role) {
  return ({ super_admin: 'مدیر ارشد', province_admin: 'مدیر استان', city_admin: 'مدیر شهرستان' })[role] || 'مدیر';
}

function regionName(regionId) {
  return state.regions.find((region) => Number(region.id) === Number(regionId))?.name || '';
}

function scopeText() {
  const region = state.regions.find((item) => Number(item.id) === Number(state.user?.region_id));
  if (state.user?.role === 'super_admin') return 'شما برای کل کشور منتشر می‌کنید.';
  if (region?.type === 'province') return `شما برای استان ${region.name} و شهرستان‌های آن منتشر می‌کنید.`;
  return `شما برای شهرستان ${region?.name || 'خود'} منتشر می‌کنید.`;
}

function setScopeBanner() {
  const text = scopeText();
  document.getElementById('scope-banner').textContent = text;
  document.getElementById('desktop-scope').textContent = text;
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return `${dateDisplay.format(date)} — ${dateTimeDisplay.format(date)}`;
}

function statusLabel(status) {
  return ({ draft: 'پیش‌نویس', scheduled: 'زمان‌بندی‌شده', published: 'منتشرشده' })[status] || status;
}

function scopeLabel(targets = []) {
  if (!targets.length) return 'بدون مقصد';
  return targets.map((target) => target.type === 'country' ? 'کشوری' : target.type === 'province' ? `استان ${target.name}` : `شهر ${target.name}`).join('، ');
}

function displayDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  const parts = new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', {
    timeZone: 'Asia/Tehran', year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(date);
  const valueOf = (key) => Number(parts.find((part) => part.type === key)?.value);
  const clock = new Intl.DateTimeFormat('en-US-u-nu-latn', {
    timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date);
  return {
    year: valueOf('year'), month: valueOf('month'), day: valueOf('day'),
    hour: Number(clock.slice(0, 2)), minute: Number(clock.slice(-2)),
  };
}

function currentIranJalali() {
  const parts = new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', {
    timeZone: 'Asia/Tehran', year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(new Date());
  return {
    year: Number(parts.find((part) => part.type === 'year').value),
    month: Number(parts.find((part) => part.type === 'month').value),
    day: Number(parts.find((part) => part.type === 'day').value),
    hour: Number(new Intl.DateTimeFormat('en-US-u-nu-latn', { timeZone: 'Asia/Tehran', hour: '2-digit', hourCycle: 'h23' }).format(new Date())),
    minute: Number(new Intl.DateTimeFormat('en-US-u-nu-latn', { timeZone: 'Asia/Tehran', minute: '2-digit' }).format(new Date())),
  };
}

function showCalendar(target) {
  state.calendar.target = target;
  const selected = displayDateTime(state.newsDates[target]) || currentIranJalali();
  state.calendar = { ...selected, target };
  document.getElementById('jalali-title').textContent = target === 'published_at' ? 'انتخاب زمان انتشار' : 'انتخاب زمان انقضا';
  document.getElementById('jalali-hour').value = String(state.calendar.hour).padStart(2, '0');
  document.getElementById('jalali-minute').value = String(state.calendar.minute).padStart(2, '0');
  renderCalendar();
  document.getElementById('jalali-dialog').showModal();
}

function renderCalendar() {
  const { year, month, day } = state.calendar;
  document.getElementById('jalali-month-label').textContent = `${JALALI_MONTHS[month - 1]} ${faDigits.format(year)}`;
  document.getElementById('jalali-weekdays').innerHTML = weekdayNames.map((name) => `<span class="calendar-weekday">${name}</span>`).join('');
  const firstGregorian = jalaliToGregorian(year, month, 1);
  const weekOffset = (new Date(Date.UTC(firstGregorian.year, firstGregorian.month - 1, firstGregorian.day)).getUTCDay() + 1) % 7;
  const days = [];
  for (let index = 0; index < weekOffset; index += 1) days.push('<span class="calendar-day empty"></span>');
  for (let currentDay = 1; currentDay <= jalaliMonthLength(year, month); currentDay += 1) {
    const weekday = (weekOffset + currentDay - 1) % 7;
    const selected = currentDay === day ? ' selected' : '';
    const friday = weekday === 6 ? ' friday' : '';
    days.push(`<button type="button" class="calendar-day${selected}${friday}" data-calendar-day="${currentDay}" aria-pressed="${currentDay === day}">${faDigits.format(currentDay)}</button>`);
  }
  document.getElementById('jalali-days').innerHTML = days.join('');
}

function updateDateLabel(field) {
  const input = document.querySelector(`[name="${field}_display"]`);
  const value = state.newsDates[field];
  if (!value) {
    input.value = '';
    return;
  }
  const date = new Date(value);
  input.value = `${dateDisplay.format(date)} — ${dateTimeDisplay.format(date)}`;
}

function applyCalendarDate() {
  const { year, month, day, target } = state.calendar;
  const hourText = normalizeDigits(document.getElementById('jalali-hour').value);
  const minuteText = normalizeDigits(document.getElementById('jalali-minute').value);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    showToast('ساعت یا دقیقه معتبر نیست.');
    return;
  }
  const gregorian = jalaliToGregorian(year, month, day);
  const utcMilliseconds = Date.UTC(gregorian.year, gregorian.month - 1, gregorian.day, hour, minute) - 210 * 60_000;
  state.newsDates[target] = new Date(utcMilliseconds).toISOString();
  updateDateLabel(target);
  document.getElementById('jalali-dialog').close();
}

function goToView(view) {
  const mobile = matchMedia('(max-width: 767px)').matches;
  const actualView = mobile && !view.startsWith('mobile-') && view !== 'profile' && view !== 'editor' ? 'mobile-compose' : view;
  document.querySelectorAll('.admin-view').forEach((panel) => { panel.hidden = panel.dataset.panel !== actualView; });
  document.querySelectorAll('#desktop-nav [data-view]').forEach((button) => button.setAttribute('aria-current', String(button.dataset.view === actualView)));
  document.querySelectorAll('#mobile-nav [data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === actualView));
  state.activeView = actualView;
  if (actualView === 'dashboard') loadDashboard();
  else if (actualView === 'news') loadNewsList(true);
  else if (actualView === 'users') loadUsers();
  else if (actualView === 'regions') loadRegions();
  else if (actualView === 'settings') loadSettings();
  else if (actualView === 'audit') loadAudit(true);
  else if (actualView === 'stats') loadStats();
  else if (actualView === 'mobile-recent') loadMobileNews('mine');
  else if (actualView === 'mobile-feed') loadMobileNews('all');
  else if (actualView === 'profile') loadProfile();
  document.querySelector('.admin-content').scrollIntoView({ block: 'start', behavior: 'auto' });
}

async function loadAdmin() {
  try {
    const me = await api('/api/auth/me');
    state.user = me.user;
    if (me.user.must_change_password) {
      showAuth('password-card');
      return;
    }
    closeAuthAndShowAdmin();
    await prepareWorkspace();
  } catch {
    showAuth('login-card');
  }
}

async function prepareWorkspace() {
  const [regions, categories] = await Promise.all([api('/api/admin/regions'), api('/api/admin/categories')]);
  state.regions = regions.regions;
  state.categories = categories.categories;
  const regionNameValue = regionName(state.user.region_id);
  const placeLabel = state.user.role === 'super_admin' ? 'مدیر ارشد' : `${roleLabel(state.user.role)} ${regionNameValue}`;
  document.getElementById('user-chip').textContent = `${state.user.full_name} · ${placeLabel}`;
  setScopeBanner();
  beginQuickCompose();
  document.querySelectorAll('[data-super-only]').forEach((element) => { element.hidden = state.user.role !== 'super_admin'; });
  document.getElementById('new-user-button').hidden = state.user.role === 'city_admin';
  if (matchMedia('(max-width: 767px)').matches) goToView('mobile-compose');
  else goToView('dashboard');
}

async function loadDashboard() {
  try {
    const data = await api('/api/admin/stats');
    const entries = [
      ['همهٔ خبرها', data.counts.total], ['پیش‌نویس', data.counts.draft],
      ['زمان‌بندی‌شده', data.counts.scheduled], ['منتشرشده', data.counts.published],
    ];
    document.getElementById('dashboard-counts').innerHTML = entries.map(([label, value]) => `<article class="stat-card"><span>${label}</span><strong>${faDigits.format(value)}</strong></article>`).join('');
    document.getElementById('dashboard-latest').innerHTML = data.latest.length ? data.latest.map((item) => compactNews(item)).join('') : '<p class="empty-panel">خبری برای نمایش وجود ندارد.</p>';
  } catch (error) { showToast(error.message); }
}

function compactNews(item, action = 'edit-news') {
  const date = item.published_at || item.updated_at || item.created_at;
  return `<article class="compact-item"><div class="compact-item-main"><strong>${escapeHtml(item.title)}</strong><small>${statusLabel(item.status)} · ${formatDate(date)} · ${faDigits.format(item.view_count || 0)} بازدید</small></div><div class="compact-actions"><button class="mini-button" type="button" data-action="${action}" data-id="${Number(item.id)}">مشاهده</button></div></article>`;
}

function renderNewsTable(items) {
  if (!items.length) return '<p class="empty-panel">خبری با این فیلتر پیدا نشد.</p>';
  return `<table class="table"><thead><tr><th>عنوان</th><th>مبدأ و مقصد</th><th>دسته‌بندی</th><th>وضعیت</th><th>بازدید</th><th>آخرین تغییر</th><th></th></tr></thead><tbody>${items.map((item) => `<tr>
    <td><strong>${escapeHtml(item.title)}</strong><br><small>${escapeHtml(item.summary || '')}</small></td>
    <td>${escapeHtml(item.origin_region_name)}<br><small>${escapeHtml(scopeLabel(item.targets))}</small></td>
    <td>${escapeHtml(item.category_name || '—')}</td>
    <td><span class="status-badge ${escapeHtml(item.status)}">${statusLabel(item.status)}</span>${item.is_urgent ? '<span class="urgent-label"> · فوری</span>' : ''}</td>
    <td>${faDigits.format(item.view_count)}</td><td>${formatDate(item.updated_at)}</td>
    <td><button class="mini-button" type="button" data-action="edit-news" data-id="${Number(item.id)}">بازکردن</button></td>
  </tr>`).join('')}</tbody></table>`;
}

async function loadNewsList(reset = false) {
  if (reset) state.newsCursor = null;
  const params = new URLSearchParams({
    status: document.getElementById('news-status').value || 'all',
    scope: document.getElementById('news-scope').value || 'all',
    text: document.getElementById('news-search').value.trim(),
    limit: '20',
  });
  if (state.newsCursor) params.set('cursor', state.newsCursor);
  const container = document.getElementById('news-table');
  if (reset) container.innerHTML = '<p class="empty-panel">در حال دریافت خبرها…</p>';
  try {
    const data = await api(`/api/admin/news?${params}`);
    if (reset) container.innerHTML = renderNewsTable(data.items);
    else {
      const existing = container.querySelector('tbody');
      if (existing && data.items.length) existing.insertAdjacentHTML('beforeend', renderNewsTable(data.items).replace(/^.*?<tbody>|<\/tbody>.*$/gs, ''));
      else container.innerHTML = renderNewsTable(data.items);
    }
    state.newsCursor = data.next_cursor;
    document.getElementById('news-more').hidden = !state.newsCursor;
  } catch (error) { container.innerHTML = `<p class="empty-panel">${escapeHtml(error.message)}</p>`; }
}

function renderTargets(selected = []) {
  const container = document.getElementById('editor-targets');
  container.innerHTML = state.regions.map((region) => {
    const checked = selected.some((id) => Number(id) === Number(region.id));
    const prefix = region.type === 'country' ? 'کشوری' : region.type === 'province' ? 'استان' : 'شهرستان';
    return `<label class="target-option"><input type="checkbox" value="${Number(region.id)}" ${checked ? 'checked' : ''}><span>${prefix} ${escapeHtml(region.name)}</span></label>`;
  }).join('') || '<p class="empty-panel">مقصد مجازی در دسترس نیست.</p>';
}

function selectedTargets() {
  return [...document.querySelectorAll('#editor-targets input:checked')].map((input) => Number(input.value));
}

function setCategoryOptions(value = '') {
  const select = document.querySelector('#news-editor [name="category_id"]');
  select.innerHTML = '<option value="">بدون دسته‌بندی</option>' + state.categories.map((category) => `<option value="${Number(category.id)}">${escapeHtml(category.name)}</option>`).join('');
  select.value = value == null ? '' : String(value);
}

function resetEditor() {
  const form = document.getElementById('news-editor');
  form.reset();
  form.elements.news_id.value = '';
  document.getElementById('editor-body').innerHTML = '';
  document.getElementById('editor-heading').textContent = 'خبر تازه';
  document.getElementById('editor-delete').hidden = true;
  document.getElementById('editor-unpublish').hidden = true;
  document.getElementById('editor-attachments').hidden = true;
  document.getElementById('editor-error').textContent = '';
  state.newsDates = { published_at: null, expires_at: null };
  updateDateLabel('published_at');
  updateDateLabel('expires_at');
  setCategoryOptions();
  renderTargets();
  state.currentNews = null;
  form.querySelectorAll('input,textarea,select,button').forEach((element) => { element.disabled = false; });
  document.getElementById('editor-publish').disabled = false;
  document.getElementById('editor-schedule').disabled = false;
  goToView('editor');
}

async function openEditor(id) {
  resetEditor();
  if (!id) return;
  try {
    const { item } = await api(`/api/admin/news/${id}`);
    state.currentNews = item;
    const form = document.getElementById('news-editor');
    form.elements.news_id.value = String(item.id);
    form.elements.title.value = item.title;
    form.elements.summary.value = item.summary || '';
    form.elements.is_pinned.checked = Boolean(item.is_pinned);
    form.elements.is_urgent.checked = Boolean(item.is_urgent);
    document.getElementById('editor-body').innerHTML = item.body_html || '';
    document.getElementById('editor-heading').textContent = item.can_edit ? 'ویرایش خبر' : 'مشاهدهٔ خبر (فقط خواندنی)';
    setCategoryOptions(item.category_id);
    renderTargets((item.targets || []).map((target) => Number(target.id)));
    state.newsDates = { published_at: item.published_at || null, expires_at: item.expires_at || null };
    updateDateLabel('published_at');
    updateDateLabel('expires_at');
    document.getElementById('editor-delete').hidden = !item.can_edit;
    document.getElementById('editor-unpublish').hidden = !item.can_edit || item.status === 'draft';
    renderAttachments(item.attachments || [], item.can_edit);
    form.querySelectorAll('input,textarea,select,button').forEach((element) => { if (!element.matches('[data-action="back-news"]')) element.disabled = !item.can_edit; });
    document.getElementById('editor-publish').disabled = !item.can_edit;
    document.getElementById('editor-schedule').disabled = !item.can_edit;
    goToView('editor');
  } catch (error) { showToast(error.message); }
}

function renderAttachments(attachments, editable) {
  const panel = document.getElementById('editor-attachments');
  panel.hidden = !attachments.length;
  panel.innerHTML = attachments.length ? `<h2>پیوست‌های ثبت‌شده</h2>${attachments.map((item) => `<div class="attachment-row">${item.kind === 'file' ? `<a href="${escapeHtml(item.url)}">▤ ${escapeHtml(item.original_name)}</a>` : `<a href="${escapeHtml(item.src)}" target="_blank" rel="noopener">تصویر: ${escapeHtml(item.original_name)}</a>`}<span>${faDigits.format(item.size_bytes)} بایت</span>${editable ? `<button class="mini-button danger-text" type="button" data-remove-attachment="${Number(item.id)}">حذف</button>` : ''}</div>`).join('')}` : '';
}

function editorBody() {
  return document.getElementById('editor-body').innerHTML;
}

function editorPayload() {
  const form = document.getElementById('news-editor');
  return {
    title: form.elements.title.value.trim(),
    summary: form.elements.summary.value.trim(),
    body_html: editorBody(),
    category_id: form.elements.category_id.value || null,
    targets: selectedTargets(),
    expires_at: state.newsDates.expires_at,
  };
}

async function uploadEditorFiles(newsId) {
  const form = document.getElementById('news-editor');
  const cover = form.elements.cover.files[0];
  const images = [...form.elements.images.files];
  const files = [...form.elements.files.files];
  if (!cover && !images.length && !files.length) return;
  const formData = new FormData();
  if (cover) formData.append('cover', cover);
  for (const image of images) formData.append('image', image);
  for (const file of files) formData.append('file', file);
  await api(`/api/admin/news/${newsId}/attachments`, { method: 'POST', formData });
  form.elements.cover.value = '';
  form.elements.images.value = '';
  form.elements.files.value = '';
}

async function saveEditor() {
  const form = document.getElementById('news-editor');
  const id = Number(form.elements.news_id.value) || 0;
  const payload = editorPayload();
  let result;
  if (id) {
    result = await api(`/api/admin/news/${id}`, { method: 'PUT', body: payload });
  } else {
    result = await api('/api/admin/news', { method: 'POST', body: payload });
    form.elements.news_id.value = String(result.id);
    state.currentNews = { id: Number(result.id), status: 'draft', can_edit: true };
    if (payload.expires_at) await api(`/api/admin/news/${result.id}`, { method: 'PUT', body: payload });
  }
  const savedId = id || Number(result.id);
  await uploadEditorFiles(savedId);
  const flags = [
    ['is_pinned', 'pin'], ['is_urgent', 'urgent'],
  ];
  for (const [field, endpoint] of flags) {
    const enabled = form.elements[field].checked;
    if (Boolean(state.currentNews?.[field]) !== enabled) {
      await api(`/api/admin/news/${savedId}/${endpoint}`, { method: 'POST', body: { enabled } });
      if (state.currentNews) state.currentNews[field] = enabled;
    }
  }
  return savedId;
}

async function handleEditorSubmit(event) {
  event.preventDefault();
  const error = document.getElementById('editor-error');
  error.textContent = '';
  try {
    const id = await saveEditor();
    showToast('پیش‌نویس ذخیره شد.');
    await openEditor(id);
  } catch (failure) { error.textContent = failure.message; }
}

async function publishEditor(scheduled) {
  const error = document.getElementById('editor-error');
  error.textContent = '';
  try {
    const id = await saveEditor();
    const publishedAt = scheduled ? state.newsDates.published_at : new Date().toISOString();
    if (!publishedAt) throw new Error('برای زمان‌بندی، ابتدا تاریخ و ساعت انتشار را انتخاب کنید.');
    await api(`/api/admin/news/${id}/publish`, {
      method: 'POST', body: { published_at: publishedAt, expires_at: state.newsDates.expires_at },
    });
    showToast(scheduled ? 'انتشار خبر زمان‌بندی شد.' : 'خبر منتشر شد.');
    await openEditor(id);
  } catch (failure) { error.textContent = failure.message; }
}

function beginQuickCompose() {
  const select = document.getElementById('quick-scope');
  const cityList = document.getElementById('quick-cities');
  const options = [];
  const cityTargets = state.regions.filter((region) => region.type === 'city');
  const broadTargets = state.regions.filter((region) => region.type !== 'city');
  for (const target of broadTargets) options.push({ value: String(target.id), label: target.type === 'country' ? 'کل کشور' : `کل استان ${target.name}` });
  if (cityTargets.length > 1) options.push({ value: 'selected-cities', label: 'انتخاب چند شهرستان' });
  if (!options.length && cityTargets.length) options.push({ value: String(cityTargets[0].id), label: `شهرستان ${cityTargets[0].name}` });
  select.innerHTML = `<option value="" selected disabled>انتخاب مقصد</option>` + options.map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join('');
  cityList.innerHTML = cityTargets.map((region) => `<label class="target-option"><input type="checkbox" value="${Number(region.id)}"><span>${escapeHtml(region.name)}</span></label>`).join('');
  cityList.hidden = select.value !== 'selected-cities';
}

function quickTargetIds() {
  const value = document.getElementById('quick-scope').value;
  if (value === 'selected-cities') return [...document.querySelectorAll('#quick-cities input:checked')].map((input) => Number(input.value));
  return value ? [Number(value)] : [];
}

async function submitQuickCompose(event) {
  event.preventDefault();
  const error = document.getElementById('quick-error');
  error.textContent = '';
  const form = event.currentTarget;
  const title = form.elements.title.value.trim();
  const summary = form.elements.summary.value.trim();
  const targets = quickTargetIds();
  if (!targets.length) { error.textContent = 'یک مقصد انتشار انتخاب کنید.'; return; }
  try {
    const created = await api('/api/admin/news', {
      method: 'POST', body: { title, summary, body_html: `<p>${escapeHtml(summary).replace(/\n/g, '<br>')}</p>`, targets },
    });
    const cover = form.elements.cover.files[0];
    if (cover) {
      const formData = new FormData();
      formData.append('cover', cover);
      await api(`/api/admin/news/${created.id}/attachments`, { method: 'POST', formData });
    }
    await api(`/api/admin/news/${created.id}/publish`, { method: 'POST', body: {} });
    form.reset();
    beginQuickCompose();
    showToast('خبر با موفقیت منتشر شد.');
    await loadMobileNews('mine');
  } catch (failure) { error.textContent = failure.message; }
}

async function loadMobileNews(scope) {
  const mine = scope === 'mine';
  const container = document.getElementById(mine ? 'mobile-recent' : 'mobile-feed');
  container.innerHTML = '<p class="empty-panel">در حال دریافت…</p>';
  try {
    const params = new URLSearchParams({ status: mine ? 'all' : 'published', scope: mine ? 'mine' : 'all', limit: '30' });
    const data = await api(`/api/admin/news?${params}`);
    container.innerHTML = data.items.length ? data.items.map((item) => compactNews(item, 'edit-news')).join('') : '<p class="empty-panel">خبری برای نمایش وجود ندارد.</p>';
  } catch (error) { container.innerHTML = `<p class="empty-panel">${escapeHtml(error.message)}</p>`; }
}

async function loadUsers() {
  const panel = document.getElementById('users-tree');
  panel.innerHTML = '<p class="empty-panel">در حال دریافت کاربران…</p>';
  try {
    const { users } = await api('/api/admin/users');
    if (!users.length) { panel.innerHTML = '<p class="empty-panel">کاربری برای نمایش وجود ندارد.</p>'; return; }
    const grouped = new Map();
    for (const user of users) {
      const parentId = user.region_type === 'city' ? Number(user.parent_region_id) : Number(user.region_id);
      if (!grouped.has(parentId)) grouped.set(parentId, []);
      grouped.get(parentId).push(user);
    }
    panel.innerHTML = [...grouped.entries()].map(([parentId, entries]) => {
      const parent = state.regions.find((region) => Number(region.id) === parentId);
      return `<section class="tree-province"><div class="tree-province-heading"><span>${escapeHtml(parent?.name || entries[0].region_name)}</span><span>${faDigits.format(entries.length)} کاربر</span></div>${entries.map((user) => `<div class="tree-city"><div><strong>${escapeHtml(user.full_name)}</strong><small>${roleLabel(user.role)} · ${escapeHtml(user.region_name)} · ${escapeHtml(user.username)}</small></div><div class="compact-actions"><button class="mini-button" data-user-action="reset-password" data-user-id="${Number(user.id)}">بازنشانی گذرواژه</button><button class="mini-button" data-user-action="reset-2fa" data-user-id="${Number(user.id)}">بازنشانی ۲مرحله‌ای</button><button class="mini-button" data-user-action="${user.is_active ? 'deactivate' : 'activate'}" data-user-id="${Number(user.id)}">${user.is_active ? 'غیرفعال‌سازی' : 'فعال‌سازی'}</button></div></div>`).join('')}</section>`;
    }).join('');
  } catch (error) { panel.innerHTML = `<p class="empty-panel">${escapeHtml(error.message)}</p>`; }
}

function openUserForm() {
  const form = document.getElementById('user-form');
  form.hidden = false;
  form.reset();
  const role = form.elements.role;
  const region = form.elements.region_id;
  const isSuper = state.user.role === 'super_admin';
  const roleValue = isSuper ? 'province_admin' : 'city_admin';
  role.innerHTML = `<option value="${roleValue}">${roleLabel(roleValue)}</option>`;
  const allowedType = roleValue === 'province_admin' ? 'province' : 'city';
  region.innerHTML = state.regions.filter((item) => item.type === allowedType)
    .map((item) => `<option value="${Number(item.id)}">${escapeHtml(item.name)}</option>`).join('');
  form.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

async function submitUser(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const message = document.getElementById('user-error');
  message.textContent = '';
  try {
    const result = await api('/api/admin/users', {
      method: 'POST', body: {
        full_name: form.elements.full_name.value,
        username: form.elements.username.value,
        role: form.elements.role.value,
        region_id: Number(form.elements.region_id.value),
      },
    });
    form.hidden = true;
    showMessage('کاربر ساخته شد', 'این گذرواژهٔ موقت فقط همین‌بار نمایش داده می‌شود. آن را از مسیر امن به کاربر تحویل دهید.', result.temporary_password);
    await loadUsers();
  } catch (error) { message.textContent = error.message; }
}

async function handleUserAction(button) {
  const id = Number(button.dataset.userId);
  const action = button.dataset.userAction;
  if (!id || !action) return;
  if (!confirm(`آیا از انجام «${button.textContent.trim()}» مطمئن هستید؟`)) return;
  try {
    const result = await api(`/api/admin/users/${id}/${action}`, { method: 'POST', body: {} });
    if (result.temporary_password) showMessage('گذرواژه بازنشانی شد', 'گذرواژهٔ موقت را فقط یک‌بار به کاربر تحویل دهید.', result.temporary_password);
    else showToast('تغییر انجام شد.');
    await loadUsers();
  } catch (error) { showToast(error.message); }
}

async function loadRegions() {
  const panel = document.getElementById('regions-tree');
  panel.innerHTML = '<p class="empty-panel">در حال دریافت مناطق…</p>';
  try {
    const data = await api('/api/admin/regions');
    state.regions = data.regions;
    const provinces = state.regions.filter((region) => region.type === 'province');
    panel.innerHTML = provinces.map((province) => `<section class="tree-province"><div class="tree-province-heading"><label>استان <input class="region-name" data-region-id="${Number(province.id)}" value="${escapeHtml(province.name)}"></label><button class="mini-button" data-save-region="${Number(province.id)}">ذخیرهٔ نام</button></div>${state.regions.filter((region) => region.type === 'city' && Number(region.parent_id) === Number(province.id)).map((city) => `<div class="tree-city"><label>شهرستان <input class="region-name" data-region-id="${Number(city.id)}" value="${escapeHtml(city.name)}"></label><label class="visibility-control">نمایش<select data-region-visibility="${Number(city.id)}"><option value="auto" ${city.visibility_override === 'auto' ? 'selected' : ''}>خودکار</option><option value="show" ${city.visibility_override === 'show' ? 'selected' : ''}>نمایش</option><option value="hide" ${city.visibility_override === 'hide' ? 'selected' : ''}>پنهان</option></select></label><button class="mini-button" data-save-region="${Number(city.id)}">ذخیرهٔ نام</button></div>`).join('')}</section>`).join('');
    populateRegionParents();
  } catch (error) { panel.innerHTML = `<p class="empty-panel">${escapeHtml(error.message)}</p>`; }
}

function populateRegionParents() {
  const form = document.getElementById('region-form');
  const type = form.elements.type.value;
  const parents = type === 'province' ? state.regions.filter((region) => region.type === 'country') : state.regions.filter((region) => region.type === 'province');
  form.elements.parent_id.innerHTML = parents.map((region) => `<option value="${Number(region.id)}">${escapeHtml(region.name)}</option>`).join('');
}

async function submitRegion(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const message = document.getElementById('region-error');
  message.textContent = '';
  try {
    await api('/api/admin/regions', { method: 'POST', body: {
      type: form.elements.type.value, name: form.elements.name.value, parent_id: Number(form.elements.parent_id.value),
    } });
    form.hidden = true;
    showToast('منطقه ساخته شد.');
    await loadRegions();
  } catch (error) { message.textContent = error.message; }
}

async function saveRegionName(id) {
  const input = document.querySelector(`.region-name[data-region-id="${id}"]`);
  try {
    await api(`/api/admin/regions/${id}`, { method: 'PATCH', body: { name: input.value } });
    showToast('نام منطقه ذخیره شد.');
    await loadRegions();
  } catch (error) { showToast(error.message); }
}

async function saveRegionVisibility(id, value) {
  try {
    await api(`/api/admin/regions/${id}`, { method: 'PATCH', body: { visibility_override: value } });
    showToast('وضعیت نمایش ذخیره شد.');
    await loadRegions();
    setScopeBanner();
  } catch (error) { showToast(error.message); }
}

async function loadSettings() {
  try {
    const { settings } = await api('/api/admin/settings');
    state.settings = settings;
    const form = document.getElementById('settings-form');
    for (const key of ['site_title', 'radio_title', 'radio_stream_url', 'radio_nowplaying_url', 'max_city_admins']) {
      form.elements[key].value = settings[key] ?? '';
    }
    form.elements.radio_enabled.checked = settings.radio_enabled === '1';
    form.elements.byline_show_person.checked = settings.byline_show_person === '1';
    form.elements.peer_edit_enabled.checked = settings.peer_edit_enabled === '1';
    document.getElementById('settings-error').textContent = '';
  } catch (error) { document.getElementById('settings-error').textContent = error.message; }
}

async function saveSettings(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const error = document.getElementById('settings-error');
  error.textContent = '';
  try {
    const result = await api('/api/admin/settings', { method: 'PUT', body: {
      site_title: form.elements.site_title.value,
      radio_enabled: form.elements.radio_enabled.checked ? '1' : '0',
      radio_title: form.elements.radio_title.value,
      radio_stream_url: form.elements.radio_stream_url.value,
      radio_nowplaying_url: form.elements.radio_nowplaying_url.value,
      byline_show_person: form.elements.byline_show_person.checked ? '1' : '0',
      max_city_admins: Number(form.elements.max_city_admins.value),
      peer_edit_enabled: form.elements.peer_edit_enabled.checked ? '1' : '0',
    } });
    state.settings = result.settings;
    showToast('تنظیمات ذخیره شد.');
  } catch (failure) { error.textContent = failure.message; }
}

async function testRadio() {
  const form = document.getElementById('settings-form');
  const audio = document.getElementById('radio-test-audio');
  const url = form.elements.radio_stream_url.value.trim();
  if (!url) { showToast('ابتدا نشانی پخش را وارد کنید.'); return; }
  let parsed;
  try { parsed = new URL(url); } catch { showToast('نشانی پخش معتبر نیست.'); return; }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) { showToast('فقط نشانی HTTP یا HTTPS بدون اطلاعات ورود پذیرفته می‌شود.'); return; }
  if (location.protocol === 'https:' && parsed.protocol === 'http:') { showToast('در سایت امن HTTPS، نشانی HTTP به‌دلیل محتوای ناامن قابل آزمایش نیست.'); return; }
  audio.pause();
  audio.src = url;
  audio.hidden = false;
  audio.preload = 'none';
  try { await audio.play(); } catch { showToast('پخش آغاز نشد؛ نشانی و دسترسی شبکه را بررسی کنید.'); }
}

async function loadAudit(reset = false) {
  if (reset) state.auditCursor = null;
  const panel = document.getElementById('audit-list');
  const params = new URLSearchParams({ limit: '50' });
  if (state.auditCursor) params.set('before', state.auditCursor);
  try {
    const { items, next_cursor: cursor } = await api(`/api/admin/audit?${params}`);
    const markup = items.length ? `<table class="table"><thead><tr><th>زمان</th><th>عامل</th><th>رویداد</th><th>موجودیت</th><th>شناسه</th><th>IP</th></tr></thead><tbody>${items.map((item) => `<tr><td>${formatDate(item.created_at)}</td><td>${escapeHtml(item.actor_username || 'سامانه')}</td><td>${escapeHtml(auditAction(item.action))}</td><td>${escapeHtml(entityLabel(item.entity))}</td><td>${item.entity_id ? faDigits.format(item.entity_id) : '—'}</td><td dir="ltr">${escapeHtml(item.ip || '—')}</td></tr>`).join('')}</tbody></table>` : '<p class="empty-panel">رویدادی ثبت نشده است.</p>';
    if (reset) panel.innerHTML = markup;
    else if (items.length) panel.querySelector('tbody')?.insertAdjacentHTML('beforeend', markup.replace(/^.*?<tbody>|<\/tbody>.*$/gs, ''));
    state.auditCursor = cursor;
    document.getElementById('audit-more').hidden = !cursor;
  } catch (error) { panel.innerHTML = `<p class="empty-panel">${escapeHtml(error.message)}</p>`; }
}

function entityLabel(entity) {
  return ({ news: 'خبر', user: 'کاربر', region: 'منطقه', settings: 'تنظیمات' })[entity] || 'سامانه';
}

function auditAction(action) {
  const labels = {
    'auth.login': 'ورود', 'auth.logout': 'خروج', 'auth.login_failed': 'ورود ناموفق',
    'news.create': 'ساخت خبر', 'news.update': 'ویرایش خبر', 'news.delete': 'حذف خبر',
    'news.publish': 'انتشار خبر', 'news.schedule': 'زمان‌بندی خبر', 'news.unpublish': 'لغو انتشار',
    'user.create': 'ساخت کاربر', 'user.deactivate': 'غیرفعال‌سازی کاربر', 'user.activate': 'فعال‌سازی کاربر',
    'settings.update': 'تغییر تنظیمات', 'region.update': 'ویرایش منطقه', 'region.create': 'ساخت منطقه',
  };
  return labels[action] || 'رویداد دیگر';
}

async function loadStats() {
  try {
    const data = await api('/api/admin/stats');
    const stats = [
      ['بازدید کل', data.counts.views], ['خبر منتشرشده', data.counts.published],
      ['پیش‌نویس', data.counts.draft], ['زمان‌بندی‌شده', data.counts.scheduled],
    ];
    document.getElementById('stats-counts').innerHTML = stats.map(([label, count]) => `<article class="stat-card"><span>${label}</span><strong>${faDigits.format(count)}</strong></article>`).join('');
    document.getElementById('most-viewed').innerHTML = data.most_viewed.length ? data.most_viewed.map((item, index) => `<article class="compact-item"><div class="compact-item-main"><strong>${faDigits.format(index + 1)}. ${escapeHtml(item.title)}</strong><small>${statusLabel(item.status)} · ${faDigits.format(item.view_count)} بازدید</small></div><meter min="0" max="${Math.max(1, data.most_viewed[0]?.view_count || 1)}" value="${Number(item.view_count)}"></meter></article>`).join('') : '<p class="empty-panel">آماری برای نمایش وجود ندارد.</p>';
  } catch (error) { showToast(error.message); }
}

async function loadProfile() {
  try {
    const [me, deviceResponse] = await Promise.all([api('/api/auth/me'), api('/api/auth/devices')]);
    state.user = me.user;
    const profile = document.getElementById('profile-details');
    profile.innerHTML = `<dt>نام</dt><dd>${escapeHtml(me.user.full_name)}</dd><dt>نام کاربری</dt><dd>${escapeHtml(me.user.username)}</dd><dt>نقش</dt><dd>${roleLabel(me.user.role)}</dd><dt>محدوده</dt><dd>${escapeHtml(regionName(me.user.region_id))}</dd>`;
    document.getElementById('device-list').innerHTML = deviceResponse.devices.length ? deviceResponse.devices.map((device) => `<div class="compact-item"><div class="compact-item-main"><strong>${escapeHtml(device.user_agent || 'دستگاه نامشخص')}</strong><small>${formatDate(device.last_used_at || device.created_at)} · پایان ${formatDate(device.expires_at)}</small></div></div>`).join('') : '<p class="muted">دستگاه مورداعتمادی ثبت نشده است.</p>';
  } catch (error) { showToast(error.message); }
}

async function openAdminNews(id) {
  try {
    const { item } = await api(`/api/admin/news/${id}`);
    showMessage(item.title, `${item.publisher_unit || ''} · ${formatDate(item.published_at)} · ${faDigits.format(item.view_count)} بازدید`);
    const content = document.getElementById('message-content');
    content.insertAdjacentHTML('beforeend', `<div class="admin-news-body">${item.body_html}</div>`);
    if (item.can_edit) content.insertAdjacentHTML('beforeend', `<button class="button primary" type="button" data-action="edit-news" data-id="${Number(item.id)}">ویرایش خبر</button>`);
  } catch (error) { showToast(error.message); }
}

async function removeAttachment(button) {
  if (!confirm('این پیوست حذف شود؟')) return;
  try {
    await api(`/api/admin/attachments/${Number(button.dataset.removeAttachment)}`, { method: 'DELETE', body: {} });
    await openEditor(Number(document.querySelector('#news-editor [name="news_id"]').value));
    showToast('پیوست حذف شد.');
  } catch (error) { showToast(error.message); }
}

async function deleteEditorNews() {
  const id = Number(document.querySelector('#news-editor [name="news_id"]').value);
  if (!id || !confirm('خبر به‌صورت نرم حذف شود؟')) return;
  try {
    await api(`/api/admin/news/${id}`, { method: 'DELETE', body: {} });
    showToast('خبر حذف شد.');
    goToView(matchMedia('(max-width: 767px)').matches ? 'mobile-recent' : 'news');
  } catch (error) { showToast(error.message); }
}

async function unpublishEditorNews() {
  const id = Number(document.querySelector('#news-editor [name="news_id"]').value);
  if (!id) return;
  try {
    await api(`/api/admin/news/${id}/unpublish`, { method: 'POST', body: {} });
    showToast('انتشار خبر لغو شد.');
    await openEditor(id);
  } catch (error) { showToast(error.message); }
}

function editorCommand(button) {
  const command = button.dataset.command;
  document.getElementById('editor-body').focus();
  if (command === 'createLink') {
    const url = prompt('نشانی پیوند را وارد کنید:');
    if (!url) return;
    document.execCommand(command, false, url);
  } else document.execCommand(command, false, button.dataset.value || null);
}

function showBackupCodes(codes) {
  document.getElementById('backup-codes').innerHTML = codes.map((code) => `<li>${escapeHtml(code)}</li>`).join('');
  showAuth('backup-card');
}

async function onLogin(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const error = document.getElementById('login-error');
  error.textContent = '';
  try {
    const result = await api('/api/auth/login', { method: 'POST', body: { username: form.elements.username.value, password: form.elements.password.value } });
    if (result.next === 'totp_setup') {
      const setup = await api('/api/auth/totp/setup');
      const svg = new TextEncoder().encode(setup.qr_svg);
      let binary = '';
      for (const byte of svg) binary += String.fromCharCode(byte);
      document.getElementById('totp-qr').src = `data:image/svg+xml;base64,${btoa(binary)}`;
      document.getElementById('totp-secret').textContent = setup.secret;
      document.getElementById('totp-title').textContent = 'ثبت برنامهٔ رمزساز';
      document.getElementById('totp-description').textContent = 'کد QR را با برنامهٔ رمزساز اسکن کنید و کد شش‌رقمی را وارد کنید.';
      document.getElementById('totp-setup').hidden = false;
      document.getElementById('remember-label').hidden = true;
      state.setupRequired = true;
      showAuth('totp-card');
    } else if (result.next === 'totp') {
      document.getElementById('totp-title').textContent = 'تأیید دومرحله‌ای';
      document.getElementById('totp-description').textContent = 'کد شش‌رقمی یا یکی از کدهای بازیابی را وارد کنید.';
      document.getElementById('totp-setup').hidden = true;
      document.getElementById('remember-label').hidden = false;
      state.setupRequired = false;
      showAuth('totp-card');
    } else if (result.ok) await finishAuthenticatedLogin(result);
  } catch (failure) { error.textContent = failure.message; }
}

async function onTotp(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const error = document.getElementById('totp-error');
  error.textContent = '';
  try {
    const code = normalizeDigits(form.elements.code.value.trim());
    const result = state.setupRequired
      ? await api('/api/auth/totp/enable', { method: 'POST', body: { code } })
      : await api('/api/auth/totp', { method: 'POST', body: { code, remember: form.elements.remember.checked } });
    if (result.backup_codes?.length) {
      showBackupCodes(result.backup_codes);
      return;
    }
    await finishAuthenticatedLogin(result);
  } catch (failure) { error.textContent = failure.message; }
}

async function finishAuthenticatedLogin(result) {
  if (result.must_change_password) {
    showAuth('password-card');
    return;
  }
  const me = await api('/api/auth/me');
  state.user = me.user;
  if (me.user.must_change_password) {
    showAuth('password-card');
    return;
  }
  closeAuthAndShowAdmin();
  await prepareWorkspace();
}

async function submitPasswordChange(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const error = document.getElementById('password-error');
  error.textContent = '';
  try {
    await api('/api/auth/change-password', { method: 'POST', body: {
      old_password: form.elements.old_password.value,
      new_password: form.elements.new_password.value,
    } });
    showToast('گذرواژه تغییر کرد؛ دوباره وارد شوید.');
    showAuth('login-card');
  } catch (failure) { error.textContent = failure.message; }
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch {}
  state.user = null;
  showAuth('login-card');
}

function closeMessage(event) {
  if (event.target === document.getElementById('message-dialog') || event.target.closest('[data-close-message]')) {
    document.getElementById('message-dialog').close();
  }
}

function bindEvents() {
  document.getElementById('login-form').addEventListener('submit', onLogin);
  document.getElementById('totp-form').addEventListener('submit', onTotp);
  document.getElementById('password-form').addEventListener('submit', submitPasswordChange);
  document.getElementById('backup-continue').addEventListener('click', async () => {
    const me = await api('/api/auth/me');
    state.user = me.user;
    if (me.user.must_change_password) showAuth('password-card');
    else { closeAuthAndShowAdmin(); await prepareWorkspace(); }
  });
  document.getElementById('logout-button').addEventListener('click', logout);
  document.getElementById('logout-everywhere').addEventListener('click', async () => {
    if (!confirm('نشست‌ها و دستگاه‌های مورداعتماد همه‌جا لغو شوند؟')) return;
    try { await api('/api/auth/devices', { method: 'DELETE', body: {} }); } catch (error) { showToast(error.message); }
    showAuth('login-card');
  });
  document.getElementById('news-editor').addEventListener('submit', handleEditorSubmit);
  document.getElementById('quick-form').addEventListener('submit', submitQuickCompose);
  document.getElementById('user-form').addEventListener('submit', submitUser);
  document.getElementById('region-form').addEventListener('submit', submitRegion);
  document.getElementById('settings-form').addEventListener('submit', saveSettings);
  document.getElementById('radio-test').addEventListener('click', testRadio);
  document.getElementById('news-filter-button').addEventListener('click', () => loadNewsList(true));
  document.getElementById('news-more').addEventListener('click', () => loadNewsList(false));
  document.getElementById('audit-more').addEventListener('click', () => loadAudit(false));
  document.getElementById('editor-publish').addEventListener('click', () => publishEditor(false));
  document.getElementById('editor-schedule').addEventListener('click', () => publishEditor(true));
  document.getElementById('editor-delete').addEventListener('click', deleteEditorNews);
  document.getElementById('editor-unpublish').addEventListener('click', unpublishEditorNews);
  document.getElementById('new-user-button').addEventListener('click', openUserForm);
  document.getElementById('new-region-button').addEventListener('click', () => { document.getElementById('region-form').hidden = false; populateRegionParents(); });
  document.querySelector('#region-form [name="type"]').addEventListener('change', populateRegionParents);
  document.getElementById('quick-scope').addEventListener('change', () => { document.getElementById('quick-cities').hidden = document.getElementById('quick-scope').value !== 'selected-cities'; });
  document.querySelectorAll('[data-command]').forEach((button) => button.addEventListener('click', () => editorCommand(button)));
  document.getElementById('jalali-prev').addEventListener('click', () => {
    state.calendar.month -= 1;
    if (state.calendar.month < 1) { state.calendar.month = 12; state.calendar.year -= 1; }
    state.calendar.day = Math.min(state.calendar.day, jalaliMonthLength(state.calendar.year, state.calendar.month));
    renderCalendar();
  });
  document.getElementById('jalali-next').addEventListener('click', () => {
    state.calendar.month += 1;
    if (state.calendar.month > 12) { state.calendar.month = 1; state.calendar.year += 1; }
    state.calendar.day = Math.min(state.calendar.day, jalaliMonthLength(state.calendar.year, state.calendar.month));
    renderCalendar();
  });
  document.getElementById('jalali-days').addEventListener('click', (event) => {
    const button = event.target.closest('[data-calendar-day]');
    if (!button) return;
    state.calendar.day = Number(button.dataset.calendarDay);
    renderCalendar();
  });
  document.getElementById('jalali-apply').addEventListener('click', applyCalendarDate);
  document.querySelectorAll('[data-close-jalali]').forEach((button) => button.addEventListener('click', () => document.getElementById('jalali-dialog').close()));
  document.querySelectorAll('[data-jalali-for]').forEach((button) => button.addEventListener('click', () => showCalendar(button.dataset.jalaliFor)));
  document.querySelectorAll('[data-clear-date]').forEach((button) => button.addEventListener('click', () => {
    const field = button.dataset.clearDate;
    state.newsDates[field] = null;
    updateDateLabel(field);
  }));
  document.getElementById('message-dialog').addEventListener('click', closeMessage);
  document.getElementById('message-dialog').querySelectorAll('[data-close-message]').forEach((button) => button.addEventListener('click', closeMessage));
  const toggleTheme = () => {
    const current = document.documentElement.dataset.theme || 'auto';
    const next = current === 'auto' ? 'light' : current === 'light' ? 'dark' : 'auto';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('pnu.theme', next); } catch {}
  };
  document.getElementById('admin-theme').addEventListener('click', toggleTheme);
  document.getElementById('auth-theme').addEventListener('click', toggleTheme);
  document.getElementById('desktop-nav').addEventListener('click', (event) => {
    const button = event.target.closest('[data-view]');
    if (button) goToView(button.dataset.view);
  });
  document.getElementById('mobile-nav').addEventListener('click', (event) => {
    const button = event.target.closest('[data-view]');
    if (button) goToView(button.dataset.view);
  });
  document.querySelector('.admin-content').addEventListener('click', (event) => {
    const viewButton = event.target.closest('[data-view-link]');
    if (viewButton) return goToView(viewButton.dataset.viewLink);
    const newButton = event.target.closest('[data-action="new-news"]');
    if (newButton) return resetEditor();
    const backButton = event.target.closest('[data-action="back-news"]');
    if (backButton) return goToView('news');
    const editButton = event.target.closest('[data-action="edit-news"]');
    if (editButton) return openEditor(Number(editButton.dataset.id));
    const removeButton = event.target.closest('[data-remove-attachment]');
    if (removeButton) return removeAttachment(removeButton);
    const userAction = event.target.closest('[data-user-action]');
    if (userAction) return handleUserAction(userAction);
    const saveRegion = event.target.closest('[data-save-region]');
    if (saveRegion) return saveRegionName(Number(saveRegion.dataset.saveRegion));
    if (event.target.closest('[data-action="cancel-user"]')) document.getElementById('user-form').hidden = true;
    if (event.target.closest('[data-action="cancel-region"]')) document.getElementById('region-form').hidden = true;
  });
  document.getElementById('regions-tree').addEventListener('change', (event) => {
    const select = event.target.closest('[data-region-visibility]');
    if (select) saveRegionVisibility(Number(select.dataset.regionVisibility), select.value);
  });

  document.getElementById('message-content').addEventListener('click', async (event) => {
    if (!event.target.closest('[data-copy-secret]')) return;
    const secret = document.querySelector('.temp-secret code')?.textContent || '';
    try { await navigator.clipboard.writeText(secret); showToast('گذرواژه کپی شد.'); } catch { showToast('کپی خودکار در دسترس نیست.'); }
  });
}

bindEvents();
loadAdmin();
