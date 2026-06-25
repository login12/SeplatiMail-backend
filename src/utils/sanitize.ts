import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';

const window = new JSDOM('').window;
const DOMPurify = createDOMPurify(window);

/**
 * Sanitizes HTML content from email bodies to prevent XSS attacks.
 * Allows safe HTML tags (formatting, links, images) while removing
 * dangerous elements (script, onerror, etc.)
 */
export function sanitizeEmailHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'a', 'b', 'blockquote', 'br', 'caption', 'cite', 'code',
      'col', 'colgroup', 'dd', 'div', 'dl', 'dt', 'em', 'figcaption',
      'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i',
      'img', 'li', 'ol', 'p', 'pre', 'q', 's', 'small', 'span',
      'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot',
      'th', 'thead', 'tr', 'u', 'ul',
    ],
    ALLOWED_ATTR: [
      'href', 'src', 'alt', 'title', 'style', 'class',
      'width', 'height', 'align', 'border', 'cellpadding', 'cellspacing',
      'colspan', 'rowspan', 'target', 'rel',
    ],
    ALLOW_DATA_ATTR: false,
    FORCE_BODY: true,
  });
}

/**
 * Strips all HTML tags from a string, returning plain text.
 */
export function htmlToPlainText(html: string): string {
  const dom = new JSDOM(html);
  return dom.window.document.body.textContent ?? '';
}
