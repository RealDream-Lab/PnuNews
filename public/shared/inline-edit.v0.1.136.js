// Inline news editing on the public reader, WordPress style: a signed-in staff member sees an "edit" button on the
// news they may edit (same rule as the panel: canEditNews on the server) and edits title, summary, text, category,
// type, pin and urgent flags in a dialog without leaving the page. Images, attachments and publishing targets stay
// in the panel ("ویرایش کامل در پنل").
//
// This module is loaded only when /api/auth/viewer reports a signed-in user, so ordinary readers never download it.
// The server is the authority: every save goes through PUT /api/admin/news/:id, which re-checks the permission.
import { fetchOrExplain } from '/shared/network-error.v0.1.136.js';
import { initRichEditor } from '/shared/rich-editor.v0.1.136.js';

const PENCIL = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4Zm9.5-13.5 4 4"/></svg>';

const TOOLS = [
  ['bold', 'درشت', '<b>B</b>'], ['underline', 'زیرخط', '<u>U</u>'], ['italic', 'کج', '<i>I</i>'],
  ['link', 'پیوند', '<svg class="tool-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>'],
  ['unlink', 'حذف پیوند', '<svg class="tool-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1M4 4l16 16"/></svg>'],
  null,
  ['alignRight', 'راست‌چین', '<svg class="tool-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M9 10h12M3 14h18M9 18h12"/></svg>'],
  ['alignCenter', 'وسط‌چین', '<svg class="tool-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M7 10h10M3 14h18M7 18h10"/></svg>'],
  ['alignLeft', 'چپ‌چین', '<svg class="tool-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M3 10h12M3 14h18M3 18h12"/></svg>'],
  ['alignJustify', 'تراز دو طرف', '<svg class="tool-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M3 10h18M3 14h18M3 18h18"/></svg>'],
  null,
  ['bullets', 'فهرست نقطه‌ای', '<svg class="tool-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h.01M4 12h.01M4 18h.01M9 6h12M9 12h12M9 18h12"/></svg>'],
  ['numbers', 'فهرست شماره‌دار (1 2 3)', '<span class="tool-text">1 2 3</span>'],
  ['persian', 'فهرست شماره‌دار با ارقام فارسی (۱ ۲ ۳)', '<span class="tool-text">۱ ۲ ۳</span>'],
];

const toolbarMarkup = () => TOOLS.map((tool) => (tool
  ? `<button type="button" data-command="${tool[0]}" title="${tool[1]}" aria-label="${tool[1]}"${tool[0] === 'unlink' ? ' disabled' : ' aria-pressed="false"'}>${tool[2]}</button>`
  : '<span class="tool-sep" aria-hidden="true"></span>')).join('');

const DIALOG_MARKUP = `
  <form class="info-panel edit-panel" novalidate>
    <div class="info-header"><div><h2 class="info-title" id="edit-dialog-title">ویرایش خبر</h2><p class="info-sub edit-status" aria-live="polite"></p></div><button class="icon-button info-close" type="button" aria-label="بستن" data-edit-cancel><svg class="icon" aria-hidden="true"><use href="#icon-close"/></svg></button></div>
    <fieldset class="edit-fields" disabled>
      <label class="edit-field"><span>عنوان</span><input name="title" type="text" maxlength="240" autocomplete="off" required></label>
      <label class="edit-field"><span>چکیده</span><textarea name="summary" rows="3" maxlength="600"></textarea></label>
      <div class="edit-row">
        <label class="edit-field"><span>دسته‌بندی</span><select name="category_id" required></select></label>
        <label class="edit-field"><span>نوع مطلب</span><select name="news_type"><option value="news">خبر</option><option value="announcement">اطلاعیه</option></select></label>
      </div>
      <div class="edit-field"><div class="edit-label"><span>متن خبر</span><div class="rich-toolbar" role="toolbar" aria-label="قالب‌بندی متن">${toolbarMarkup()}</div></div>
        <div class="rich-editor edit-body" contenteditable="true" role="textbox" aria-multiline="true" aria-label="متن کامل خبر"></div></div>
      <div class="edit-flags">
        <label class="edit-check"><input type="checkbox" name="is_pinned"><span>سنجاق (خبر مهم)</span></label>
        <label class="edit-check"><input type="checkbox" name="is_urgent"><span>خبر فوری</span></label>
      </div>
    </fieldset>
    <p class="edit-error" role="alert" hidden></p>
    <div class="edit-actions">
      <button type="submit" class="button-primary edit-save" disabled>ذخیره تغییرات</button>
      <button type="button" class="edit-cancel" data-edit-cancel>انصراف</button>
      <a class="edit-full" href="/dashboard/" target="_blank" rel="noopener">ویرایش کامل در پنل (تصویر، پیوست، مقصد)</a>
    </div>
  </form>`;

export function initInlineEdit({ roots, showToast = () => {}, onSaved = () => {} }) {
  const editable = new Set();
  const checked = new Set();
  let active = true;
  let timer = 0;
  let dialog = null;
  let current = null; // { id, snapshot, item }

  // ---------- Which news may this user edit? ----------
  const idOf = (node) => Number(node.dataset.newsId ?? node.dataset.newsPageId);

  function decorate(node) {
    const id = idOf(node);
    if (!editable.has(id) || node.querySelector('[data-edit-news]')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.editNews = String(id);
    if (node.dataset.newsPageId) {
      button.className = 'share-button edit-button';
      button.innerHTML = `${PENCIL}ویرایش خبر`;
      node.querySelector('.news-actions')?.append(button);
      return;
    }
    button.setAttribute('aria-label', 'ویرایش خبر');
    button.title = 'ویرایش خبر';
    button.innerHTML = PENCIL;
    const share = node.querySelector('.card-share');
    if (share) {
      button.className = 'card-edit';
      share.before(button);
      node.classList.add('has-edit');
    } else if (node.classList.contains('pinned-card')) {
      button.className = 'card-edit card-edit-pinned';
      node.append(button);
      node.classList.add('has-edit');
    }
  }

  function nodes() {
    return roots.flatMap((root) => [...root.querySelectorAll('[data-news-id], [data-news-page-id]')]);
  }

  async function fetchEditable(ids) {
    for (let start = 0; start < ids.length; start += 100) {
      const chunk = ids.slice(start, start + 100);
      try {
        const response = await fetch(`/api/admin/news/editable?ids=${chunk.join(',')}`, { headers: { accept: 'application/json' } });
        if (!response.ok) continue; // e.g. the session ended: the next viewer check turns the feature off
        const body = await response.json();
        for (const id of chunk) checked.add(id);
        for (const id of body.ids ?? []) editable.add(Number(id));
      } catch { /* offline: tried again on the next scan */ }
    }
  }

  async function scan() {
    timer = 0;
    if (!active) return;
    const all = nodes();
    const unknown = [...new Set(all.map(idOf).filter((id) => Number.isSafeInteger(id) && id > 0 && !checked.has(id)))];
    if (unknown.length) await fetchEditable(unknown);
    if (!active) return;
    for (const node of nodes()) decorate(node);
  }

  const schedule = () => { if (active && !timer) timer = setTimeout(scan, 60); };
  const observer = new MutationObserver(schedule);
  for (const root of roots) observer.observe(root, { childList: true, subtree: true });

  // The edit button sits inside a card that opens the news on click: stop that, and open the editor instead.
  document.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-edit-news]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    openEditor(Number(button.dataset.editNews), button);
  }, true);
  document.addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.closest?.('[data-edit-news]')) event.stopPropagation();
  }, true);

  // ---------- The dialog ----------
  const snapshotOf = (form, body) => JSON.stringify([
    form.elements.title.value.trim(), form.elements.summary.value.trim(), body.innerHTML,
    form.elements.category_id.value, form.elements.news_type.value, form.elements.is_pinned.checked, form.elements.is_urgent.checked,
  ]);

  // ---------- «Close without saving?» is a modal of the site, like the others, not the browser's confirm box ----------
  let confirmDialog = null;
  let confirmPending = null;
  function askDiscard() {
    if (confirmPending) return confirmPending;
    if (!confirmDialog) {
      confirmDialog = document.createElement('dialog');
      confirmDialog.className = 'info-dialog confirm-dialog';
      confirmDialog.setAttribute('role', 'alertdialog');
      confirmDialog.setAttribute('aria-labelledby', 'confirm-dialog-title');
      confirmDialog.setAttribute('aria-describedby', 'confirm-dialog-text');
      confirmDialog.innerHTML = `
        <div class="info-panel confirm-panel">
          <h2 class="info-title" id="confirm-dialog-title">بستن بدون ذخیره؟</h2>
          <p class="confirm-text" id="confirm-dialog-text">تغییرات ذخیره‌نشده از بین می‌رود. بستن پنجره؟</p>
          <div class="confirm-actions">
            <button type="button" class="button-primary" data-confirm="keep" autofocus>ادامه ویرایش</button>
            <button type="button" class="button-danger" data-confirm="discard">بستن بدون ذخیره</button>
          </div>
        </div>`;
      document.body.append(confirmDialog);
      // Only the red button discards; the other button, Escape and anything else keep the editor open.
      confirmDialog.addEventListener('click', (event) => {
        const choice = event.target.closest('[data-confirm]')?.dataset.confirm;
        if (choice) confirmDialog.close(choice);
      });
    }
    confirmPending = new Promise((resolve) => {
      confirmDialog.addEventListener('close', () => {
        confirmPending = null;
        resolve(confirmDialog.returnValue === 'discard');
      }, { once: true });
    });
    confirmDialog.returnValue = '';
    confirmDialog.showModal();
    return confirmPending;
  }

  function build() {
    dialog = document.createElement('dialog');
    dialog.className = 'info-dialog edit-dialog';
    dialog.setAttribute('aria-labelledby', 'edit-dialog-title');
    dialog.innerHTML = DIALOG_MARKUP;
    document.body.append(dialog);
    const form = dialog.querySelector('form');
    const body = dialog.querySelector('.edit-body');
    initRichEditor({
      editor: body,
      toolbar: dialog.querySelector('.rich-toolbar'),
      askLink: async () => window.prompt('نشانی پیوند را وارد کنید', 'https://') ?? '',
    });
    const dirty = () => current && snapshotOf(form, body) !== current.snapshot;
    const requestClose = async () => {
      if (dirty() && !(await askDiscard())) return;
      dialog.close();
    };
    dialog.addEventListener('click', (event) => { if (event.target.closest('[data-edit-cancel]')) requestClose(); });
    // Escape asks first when there is unsaved work (a click on the dark area deliberately does nothing). Handling the
    // key itself (not only the dialog's cancel event) matters: a browser refuses to cancel a second Escape that comes
    // without a click in between, which would close the editor and lose the changes.
    dialog.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      requestClose();
    });
    // The same request from elsewhere (the Android back gesture, for example).
    dialog.addEventListener('cancel', (event) => {
      if (!dirty()) return;
      event.preventDefault();
      requestClose();
    });
    dialog.addEventListener('close', () => { current = null; });
    form.addEventListener('submit', (event) => { event.preventDefault(); save(); });
  }

  const q = (selector) => dialog.querySelector(selector);

  function setError(message) {
    const box = q('.edit-error');
    box.textContent = message ?? '';
    box.hidden = !message;
  }

  async function api(url, options = {}) {
    const response = await fetchOrExplain(url, {
      ...options,
      headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}) },
    });
    let data = {};
    try { data = await response.json(); } catch { /* empty body */ }
    if (!response.ok) {
      const error = new Error(data.error || 'انجام درخواست ممکن نشد.');
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async function openEditor(id, opener) {
    if (!dialog) build();
    const form = q('form');
    const body = q('.edit-body');
    const fields = q('.edit-fields');
    const save = q('.edit-save');
    current = null;
    form.reset();
    body.innerHTML = '';
    setError('');
    fields.disabled = true;
    save.disabled = true;
    q('.edit-status').textContent = 'در حال دریافت خبر…';
    q('.edit-full').href = `/dashboard/?edit=${id}`;
    if (!dialog.open) dialog.showModal();
    try {
      const [{ item }, { categories }] = await Promise.all([api(`/api/admin/news/${id}`), api('/api/admin/categories')]);
      if (!item.can_edit) throw new Error('اجازهٔ ویرایش این خبر را ندارید.');
      const select = form.elements.category_id;
      select.replaceChildren(...categories
        .filter((category) => category.is_active || Number(category.id) === Number(item.category_id))
        .map((category) => {
          const option = document.createElement('option');
          option.value = String(category.id);
          option.textContent = category.is_active ? category.name : `${category.name} (غیرفعال)`;
          return option;
        }));
      select.value = String(item.category_id ?? '');
      form.elements.title.value = item.title ?? '';
      form.elements.summary.value = item.summary ?? '';
      form.elements.news_type.value = item.news_type === 'announcement' ? 'announcement' : 'news';
      form.elements.is_pinned.checked = Boolean(item.is_pinned);
      form.elements.is_urgent.checked = Boolean(item.is_urgent);
      body.innerHTML = item.body_html || '';
      current = { id, item, snapshot: '' };
      current.snapshot = snapshotOf(form, body);
      const draft = item.status !== 'published' ? ' (منتشر نشده)' : '';
      q('.edit-status').textContent = `${item.source_url ? 'خبر خودکار پورتال' : 'خبر'}${draft}`;
      fields.disabled = false;
      save.disabled = false;
      form.elements.title.focus();
    } catch (error) {
      q('.edit-status').textContent = '';
      setError(error.message);
    }
    dialog.addEventListener('close', () => opener?.focus?.(), { once: true });
  }

  async function save() {
    if (!current) return;
    const form = q('form');
    const body = q('.edit-body');
    const saveButton = q('.edit-save');
    const { id, item } = current;
    const title = form.elements.title.value.trim();
    if (!title) { setError('عنوان خبر را بنویسید.'); form.elements.title.focus(); return; }
    if (!form.elements.category_id.value) { setError('دسته‌بندی خبر را انتخاب کنید.'); return; }
    setError('');
    saveButton.disabled = true;
    saveButton.textContent = 'در حال ذخیره…';
    try {
      await api(`/api/admin/news/${id}`, {
        method: 'PUT',
        body: JSON.stringify({
          title,
          summary: form.elements.summary.value.trim(),
          body_html: body.innerHTML,
          category_id: Number(form.elements.category_id.value),
          news_type: form.elements.news_type.value === 'announcement' ? 'announcement' : 'news',
        }),
      });
      for (const [flag, field] of [['pin', 'is_pinned'], ['urgent', 'is_urgent']]) {
        const wanted = form.elements[field].checked;
        if (wanted !== Boolean(item[field])) await api(`/api/admin/news/${id}/${flag}`, { method: 'POST', body: JSON.stringify({ enabled: wanted }) });
      }
      current = null; // saved: closing needs no confirmation
      dialog.close();
      showToast('تغییرات خبر ذخیره شد.');
      onSaved({ id });
    } catch (error) {
      setError(error.message);
      if (error.status === 401) active = false;
    } finally {
      saveButton.disabled = false;
      saveButton.textContent = 'ذخیره تغییرات';
    }
  }

  // ---------- Switching on and off (the viewer can sign in or out in another tab) ----------
  function clear() {
    for (const button of document.querySelectorAll('[data-edit-news]')) button.remove();
    for (const node of document.querySelectorAll('.has-edit')) node.classList.remove('has-edit');
    editable.clear();
    checked.clear();
  }

  return {
    refresh() { active = true; schedule(); },
    // A new session may have other rights than the old one: forget what was learned and ask again.
    reset() { clear(); active = true; schedule(); },
    disable() { active = false; clear(); if (confirmDialog?.open) confirmDialog.close(); if (dialog?.open) { current = null; dialog.close(); } },
    scanNow: scan,
  };
}
