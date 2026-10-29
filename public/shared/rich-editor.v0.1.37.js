// The news editor's formatting toolbar: bold, underline, italic, link, four alignments, bullets, numbers
// and numbers with Persian digits. It is a shared module so it can be tested on its own in a browser.
//
// The site's CSP forbids inline style attributes, so alignment is stored as a class (ta-right, ta-left,
// ta-center, ta-justify) and Persian numbering as ol.fa-num. The server keeps only those classes.

const ALIGN_CLASSES = ['ta-right', 'ta-left', 'ta-center', 'ta-justify'];
const ALIGN_BY_COMMAND = { alignRight: 'ta-right', alignLeft: 'ta-left', alignCenter: 'ta-center', alignJustify: 'ta-justify' };
const BLOCK_SELECTOR = 'p,h2,h3,li,blockquote,div';

const escapeAttr = (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function normalizeLinkUrl(raw) {
  let value = String(raw ?? '').trim();
  if (!value) return '';
  if (!/^[a-z][a-z\d+.-]*:/i.test(value)) value = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? `mailto:${value}` : `https://${value}`;
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

export function initRichEditor({ editor, toolbar, askLink = async () => '' }) {
  if (!editor || !toolbar) return { refresh() {} };

  const elementOf = (node) => (node?.nodeType === 1 ? node : node?.parentElement ?? null);
  const selectionInside = () => {
    const selection = getSelection();
    return selection?.rangeCount && editor.contains(selection.anchorNode) ? selection : null;
  };

  function closestBlock(node) {
    let element = elementOf(node);
    while (element && element !== editor) {
      if (element.matches(BLOCK_SELECTOR)) return element;
      element = element.parentElement;
    }
    return editor;
  }

  function currentList() {
    const selection = selectionInside();
    if (!selection) return null;
    const list = elementOf(selection.anchorNode)?.closest('li')?.closest('ol,ul');
    return list && editor.contains(list) ? list : null;
  }

  function prepare() {
    editor.focus();
    // Enter creates <p> (not <div>), and bold/italic are produced as tags, not as inline styles.
    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch {}
    try { document.execCommand('styleWithCSS', false, false); } catch {}
  }

  function applyAlignment(className) {
    const selection = selectionInside();
    if (!selection) return;
    let range = selection.getRangeAt(0);
    // Text typed straight into the empty editor has no block around it yet: give it one first.
    if (closestBlock(range.startContainer) === editor || closestBlock(range.endContainer) === editor) {
      document.execCommand('formatBlock', false, 'p');
      range = getSelection().getRangeAt(0);
    }
    const touched = [...editor.querySelectorAll(BLOCK_SELECTOR)].filter((element) => range.intersectsNode(element));
    // Only the innermost blocks: a <li> that holds a nested list, or a quote that holds paragraphs, is not itself aligned.
    const blocks = touched.filter((element) => !touched.some((other) => other !== element && element.contains(other)));
    for (const block of blocks) {
      block.classList.remove(...ALIGN_CLASSES);
      block.classList.add(className);
    }
  }

  function applyList(kind) {
    const wantedTag = kind === 'bullets' ? 'UL' : 'OL';
    const persian = kind === 'persian';
    const existing = currentList();
    if (existing && existing.tagName === wantedTag) {
      // Switching between 1 2 3 and ۱ ۲ ۳ only changes the list's numbering; the same kind again removes the list.
      if (wantedTag === 'OL' && existing.classList.contains('fa-num') !== persian) {
        existing.classList.toggle('fa-num', persian);
        if (!existing.classList.length) existing.removeAttribute('class');
        return;
      }
      document.execCommand(wantedTag === 'UL' ? 'insertUnorderedList' : 'insertOrderedList');
      return;
    }
    document.execCommand(wantedTag === 'UL' ? 'insertUnorderedList' : 'insertOrderedList');
    if (wantedTag === 'OL') {
      const created = currentList();
      if (created?.tagName === 'OL' && persian) created.classList.add('fa-num');
    }
  }

  async function applyLink() {
    const selection = getSelection();
    const saved = selection?.rangeCount && editor.contains(selection.anchorNode) ? selection.getRangeAt(0).cloneRange() : null;
    const url = normalizeLinkUrl(await askLink());
    if (!url) return;
    editor.focus();
    if (saved) { selection.removeAllRanges(); selection.addRange(saved); }
    if (saved && saved.collapsed) {
      document.execCommand('insertHTML', false, `<a href="${escapeAttr(url)}">${escapeAttr(url)}</a>`);
    } else {
      document.execCommand('createLink', false, url);
    }
  }

  async function run(command) {
    prepare();
    if (command === 'bold' || command === 'italic' || command === 'underline') document.execCommand(command);
    else if (command === 'link') await applyLink();
    else if (ALIGN_BY_COMMAND[command]) applyAlignment(ALIGN_BY_COMMAND[command]);
    else if (command === 'bullets' || command === 'numbers' || command === 'persian') applyList(command);
    refresh();
  }

  function refresh() {
    const selection = selectionInside();
    for (const button of toolbar.querySelectorAll('[data-command]')) {
      const command = button.dataset.command;
      let pressed = false;
      if (selection) {
        try {
          if (command === 'bold' || command === 'italic' || command === 'underline') pressed = document.queryCommandState(command);
          else if (ALIGN_BY_COMMAND[command]) pressed = closestBlock(selection.anchorNode).classList?.contains(ALIGN_BY_COMMAND[command]) ?? false;
          else if (command === 'bullets') pressed = currentList()?.tagName === 'UL';
          else if (command === 'numbers') { const list = currentList(); pressed = list?.tagName === 'OL' && !list.classList.contains('fa-num'); }
          else if (command === 'persian') { const list = currentList(); pressed = list?.tagName === 'OL' && list.classList.contains('fa-num'); }
        } catch {}
      }
      button.setAttribute('aria-pressed', String(Boolean(pressed)));
    }
  }

  // Clicking a button must not take the selection away from the text.
  toolbar.addEventListener('mousedown', (event) => { if (event.target.closest('button')) event.preventDefault(); });
  toolbar.addEventListener('click', (event) => {
    const button = event.target.closest('[data-command]');
    if (button) run(button.dataset.command);
  });
  editor.addEventListener('focus', prepare);
  document.addEventListener('selectionchange', () => { if (selectionInside()) refresh(); });

  return { refresh, run };
}
