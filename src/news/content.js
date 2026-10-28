import sanitizeHtml from 'sanitize-html';
import { buildSearchText, cleanFaText } from '../lib/fa.js';

const UPLOADED_IMAGE_PATH = /^\/media\/img\/\d{4}\/(0[1-9]|1[0-2])\/[a-f\d]{32}-(400|800|1280)\.webp$/i;
const allowedTags = ['p', 'br', 'strong', 'em', 'h2', 'h3', 'ul', 'ol', 'li', 'blockquote', 'a', 'img'];
const sanitizerOptions = {
  allowedTags,
  allowedAttributes: {
    a: ['href', 'target', 'rel'],
    img: ['src', 'alt', 'width', 'height'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: [] },
  allowProtocolRelative: false,
  transformTags: {
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

export function sanitizeBodyHtml(value) {
  return sanitizeHtml(String(value ?? ''), sanitizerOptions);
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
