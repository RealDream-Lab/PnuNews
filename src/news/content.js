import sanitizeHtml from 'sanitize-html';
import { buildSearchText, cleanFaText, normalizeBrandName } from '../lib/fa.js';

const UPLOADED_IMAGE_PATH = /^\/media\/img\/\d{4}\/(0[1-9]|1[0-2])\/[a-f\d]{32}-(400|800|1280)\.webp$/i;
const allowedTags = ['p', 'br', 'strong', 'em', 'u', 'h2', 'h3', 'ul', 'ol', 'li', 'blockquote', 'a', 'img'];

// Formatting that survives: alignment as a class (the CSP forbids inline style attributes) and Persian numbering on <ol>.
const ALIGN_CLASSES = ['ta-right', 'ta-left', 'ta-center', 'ta-justify'];
const ALIGN_IN_STYLE = /(?:^|;)\s*text-align\s*:\s*(right|left|center|justify)\b/i;

// Pasted or older content may carry text-align in a style attribute: turn it into the class and drop the style.
function keepAlignment(tagName, attributes) {
  const { style, class: classAttribute, ...rest } = attributes;
  const classes = new Set(String(classAttribute ?? '').split(/\s+/).filter(Boolean));
  const fromStyle = ALIGN_IN_STYLE.exec(String(style ?? ''));
  if (fromStyle) {
    for (const name of ALIGN_CLASSES) classes.delete(name);
    classes.add(`ta-${fromStyle[1].toLowerCase()}`);
  }
  return { tagName, attribs: { ...rest, ...(classes.size ? { class: [...classes].join(' ') } : {}) } };
}
const alignable = (tagName, attributes) => keepAlignment(tagName, attributes);
const sanitizerOptions = {
  allowedTags,
  allowedAttributes: {
    a: ['href', 'target', 'rel'],
    img: ['src', 'alt', 'width', 'height'],
  },
  allowedClasses: { '*': ALIGN_CLASSES, ol: ['fa-num'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: [] },
  allowProtocolRelative: false,
  transformTags: {
    // The browser's editor makes <b>, <i> and sometimes <div>; they are stored as the tags the site styles.
    b: 'strong',
    i: 'em',
    div: (tagName, attributes) => keepAlignment('p', attributes),
    p: alignable,
    h2: alignable,
    h3: alignable,
    li: alignable,
    ul: alignable,
    ol: alignable,
    blockquote: alignable,
    // Every link is opened without access to the opener and without leaking the referrer;
    // only the _blank target is kept.
    a: (tagName, attributes) => {
      const { target, ...rest } = attributes;
      return {
        tagName,
        attribs: {
          ...rest,
          ...(target === '_blank' ? { target: '_blank' } : {}),
          rel: 'noopener noreferrer nofollow',
        },
      };
    },
  },
  // Body images may only point at the processed upload variants served by /media/img/...
  exclusiveFilter: (frame) => frame.tag === 'img' && (
    typeof frame.attribs.src !== 'string' || !UPLOADED_IMAGE_PATH.test(frame.attribs.src)
  ),
};

// Output-only variant: the university name gets its half-space in text nodes (never in attributes or URLs).
const outputSanitizerOptions = { ...sanitizerOptions, textFilter: (text) => normalizeBrandName(text) };

// brand: true is for responses; what is saved in the database is sanitized without it and stays as written.
export function sanitizeBodyHtml(value, { brand = false } = {}) {
  return sanitizeHtml(String(value ?? ''), brand ? outputSanitizerOptions : sanitizerOptions);
}

function decodeCodePoint(value, radix) {
  const codePoint = Number.parseInt(value, radix);
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return '';
  return String.fromCodePoint(codePoint);
}

export function plainTextFromHtml(value) {
  return sanitizeHtml(String(value ?? ''), { allowedTags, allowedAttributes: {} })
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#x([\da-f]+);/gi, (_, hex) => decodeCodePoint(hex, 16))
    .replace(/&#(\d+);/g, (_, decimal) => decodeCodePoint(decimal, 10))
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

export function normalizeNewsInput({ title, summary = '', body_html = '' }) {
  const normalizedTitle = cleanFaText(title);
  const normalizedSummary = cleanFaText(summary);
  const bodyHtml = sanitizeBodyHtml(body_html);
  const searchText = buildSearchText(normalizedTitle, normalizedSummary, plainTextFromHtml(bodyHtml));
  return { title: normalizedTitle, summary: normalizedSummary, body_html: bodyHtml, search_text: searchText };
}
