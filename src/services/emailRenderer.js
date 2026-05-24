import sanitizeHtml from 'sanitize-html';

const DEFAULT_SUPPORT_EMAIL = 'support@xstreamvideos.site';
const DEFAULT_FRONTEND_URL = 'https://xstreamvideos.site';

const FONT_STACK = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const COLORS = {
  background: '#F3F4F6',
  surface: '#FFFFFF',
  text: '#111827',
  muted: '#6B7280',
  subtle: '#9CA3AF',
  border: '#E5E7EB',
  elevated: '#F9FAFB',
  brand: '#FF4654',
  brandDark: '#D92D3B',
  success: '#059669',
  successBg: '#ECFDF5',
  warning: '#B45309',
  warningBg: '#FFFBEB',
  danger: '#DC2626',
  dangerBg: '#FEF2F2',
  info: '#2563EB',
  infoBg: '#EFF6FF',
  dark: '#111827',
};

const VARIANT = {
  success: { color: COLORS.success, bg: COLORS.successBg, border: '#A7F3D0' },
  warning: { color: COLORS.warning, bg: COLORS.warningBg, border: '#FDE68A' },
  danger: { color: COLORS.danger, bg: COLORS.dangerBg, border: '#FECACA' },
  info: { color: COLORS.info, bg: COLORS.infoBg, border: '#BFDBFE' },
  neutral: { color: COLORS.muted, bg: COLORS.elevated, border: COLORS.border },
  brand: { color: COLORS.brandDark, bg: '#FFF1F2', border: '#FECDD3' },
};

export function escapeHtml(value) {
  return String(value ?? '').replace(/[<>&"]/g, (c) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    '"': '&quot;',
  }[c]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, '&#39;');
}

export function getEmailTheme(overrides = {}) {
  const frontUrl = String(process.env.FRONTEND_URL || DEFAULT_FRONTEND_URL).replace(/\/$/, '');
  return {
    brandName: process.env.EMAIL_BRAND_NAME || 'XstreamVideos',
    brandShortName: process.env.EMAIL_BRAND_SHORT_NAME || 'Xstream',
    logoUrl: process.env.COMPANY_LOGO_URL || '',
    supportEmail: process.env.SUPPORT_EMAIL || process.env.SUPPORT_NOTIFICATIONS_EMAIL || DEFAULT_SUPPORT_EMAIL,
    frontUrl,
    address: process.env.COMPANY_ADDRESS || '',
    colors: COLORS,
    ...overrides,
  };
}

export function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

export function safeUrl(value, fallback = '') {
  const raw = String(value || '').trim();
  if (!raw) return fallback;

  try {
    const base = getEmailTheme().frontUrl || DEFAULT_FRONTEND_URL;
    const url = new URL(raw, `${base}/`);
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return fallback;
    return url.href.replace(/"/g, '%22');
  } catch {
    return fallback;
  }
}

export function formatUsd(value) {
  return `$${Number(value || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatNgn(value) {
  if (value === null || value === undefined || value === '') return '';
  return `NGN ${Number(value || 0).toLocaleString('en-NG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatDateTime(value, timeZone = process.env.EMAIL_TIMEZONE || process.env.FINANCE_TZ || 'UTC') {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return escapeHtml(value);
  return date.toLocaleString('en-US', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function hiddenPreheader(preheader) {
  if (!preheader) return '';
  return `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;line-height:1px;font-size:1px;mso-hide:all;">${escapeHtml(preheader)}</div>`;
}

function inlineMarkdown(value) {
  let html = escapeHtml(value);
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/`([^`]+)`/g, '<code style="font-family:Menlo,Consolas,monospace;background:#F3F4F6;border-radius:4px;padding:1px 4px;">$1</code>');
  return html;
}

function markdownLinkToHtml(value) {
  return inlineMarkdown(value).replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/g, (_m, label, url) => {
    const href = safeUrl(url, '');
    if (!href) return escapeHtml(label);
    return `<a href="${href}" style="color:${COLORS.brand};text-decoration:none;">${escapeHtml(label)}</a>`;
  });
}

export function renderRichText(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  if (/<\/?[a-z][\s\S]*>/i.test(raw)) {
    return sanitizeHtml(raw, {
      allowedTags: ['p', 'br', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'a', 'code'],
      allowedAttributes: {
        a: ['href', 'title', 'target', 'rel', 'style'],
        p: ['style'],
        ul: ['style'],
        ol: ['style'],
        li: ['style'],
        code: ['style'],
      },
      allowedSchemes: ['http', 'https', 'mailto'],
      transformTags: {
        p: () => ({
          tagName: 'p',
          attribs: { style: `margin:0 0 16px;font-size:15px;line-height:1.7;color:${COLORS.text};` },
        }),
        ul: () => ({
          tagName: 'ul',
          attribs: { style: `margin:0 0 18px 0;padding:0 0 0 22px;font-size:15px;line-height:1.7;color:${COLORS.text};` },
        }),
        ol: () => ({
          tagName: 'ol',
          attribs: { style: `margin:0 0 18px 0;padding:0 0 0 22px;font-size:15px;line-height:1.7;color:${COLORS.text};` },
        }),
        li: () => ({
          tagName: 'li',
          attribs: { style: `margin:0 0 8px;font-size:15px;line-height:1.7;color:${COLORS.text};` },
        }),
        a: (_tagName, attribs) => ({
          tagName: 'a',
          attribs: {
            href: safeUrl(attribs.href, '#'),
            target: '_blank',
            rel: 'noopener noreferrer',
            style: `color:${COLORS.brand};text-decoration:none;`,
          },
        }),
        code: () => ({
          tagName: 'code',
          attribs: { style: 'font-family:Menlo,Consolas,monospace;background:#F3F4F6;border-radius:4px;padding:1px 4px;' },
        }),
      },
    });
  }

  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const parts = [];
  let paragraph = [];
  let list = [];
  let listType = 'ul';

  function flushParagraph() {
    if (!paragraph.length) return;
    const inner = paragraph
      .map((line) => markdownLinkToHtml(line))
      .join('<br>');
    parts.push(`<p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:${COLORS.text};">${inner}</p>`);
    paragraph = [];
  }

  function flushList() {
    if (!list.length) return;
    const tag = listType === 'ol' ? 'ol' : 'ul';
    parts.push(`<${tag} style="margin:0 0 18px 0;padding:0 0 0 22px;font-size:15px;line-height:1.7;color:${COLORS.text};">${list.map((item) => `<li style="margin:0 0 8px;font-size:15px;line-height:1.7;color:${COLORS.text};">${markdownLinkToHtml(item)}</li>`).join('')}</${tag}>`);
    list = [];
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    const bullet = trimmed.match(/^(?:[-*•]|\u2022)\s+(.+)$/);
    const number = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (bullet || number) {
      flushParagraph();
      const nextType = number ? 'ol' : 'ul';
      if (list.length && listType !== nextType) flushList();
      listType = nextType;
      list.push((bullet?.[1] || number?.[1] || '').trim());
      continue;
    }

    flushList();
    paragraph.push(trimmed);
  }

  flushParagraph();
  flushList();
  return parts.join('');
}

export function paragraph(text, color = COLORS.text) {
  return `<p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:${color};">${escapeHtml(text)}</p>`;
}

export function divider() {
  return `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:24px 0;"><tr><td style="border-top:1px solid ${COLORS.border};font-size:1px;line-height:1px;">&nbsp;</td></tr></table>`;
}

export function statusBadge(label, variant = 'neutral') {
  const tone = VARIANT[variant] || VARIANT.neutral;
  return `<span style="display:inline-block;background:${tone.bg};border:1px solid ${tone.border};border-radius:999px;color:${tone.color};font-size:11px;font-weight:800;letter-spacing:0.08em;line-height:1;text-transform:uppercase;padding:8px 12px;">${escapeHtml(label)}</span>`;
}

export function button({ label, url, variant = 'brand' }) {
  const href = safeUrl(url, '');
  if (!href) return '';
  const bg = variant === 'dark' ? COLORS.dark : COLORS.brand;
  return `<table cellpadding="0" cellspacing="0" role="presentation" style="margin:24px auto 8px;"><tr><td align="center" bgcolor="${bg}" style="border-radius:10px;background:${bg};mso-padding-alt:14px 24px;">
    <a href="${href}" target="_blank" rel="noopener noreferrer" style="display:inline-block;border-radius:10px;color:#FFFFFF;font-size:15px;font-weight:800;line-height:1.2;text-decoration:none;padding:14px 24px;">${escapeHtml(label)}</a>
  </td></tr></table>`;
}

export function fallbackLink(url, label = 'If the button does not work, copy and paste this link into your browser:') {
  const href = safeUrl(url, '');
  if (!href) return '';
  return `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-top:18px;"><tr><td style="border-top:1px solid ${COLORS.border};padding-top:18px;">
    <p style="margin:0 0 8px;font-size:12px;line-height:1.6;color:${COLORS.subtle};">${escapeHtml(label)}</p>
    <p style="margin:0;font-size:12px;line-height:1.5;word-break:break-all;"><a href="${href}" target="_blank" rel="noopener noreferrer" style="color:${COLORS.brand};text-decoration:none;">${escapeHtml(href)}</a></p>
  </td></tr></table>`;
}

export function keyValueTable(rows = [], options = {}) {
  const visibleRows = rows.filter((row) => row && row.value !== undefined && row.value !== null && row.value !== '');
  if (!visibleRows.length) return '';
  const title = options.title
    ? `<tr><td colspan="2" style="padding:0 0 12px;font-size:12px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:${COLORS.muted};">${escapeHtml(options.title)}</td></tr>`
    : '';
  return `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:20px 0;border:1px solid ${COLORS.border};border-radius:12px;border-collapse:separate;background:${COLORS.elevated};">
    <tr><td style="padding:18px 20px;">
      <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
        ${title}
        ${visibleRows.map((row, index) => `<tr>
          <td style="padding:${index === 0 ? '0' : '10px'} 12px ${index === visibleRows.length - 1 ? '0' : '10px'} 0;border-top:${index === 0 ? '0' : `1px solid ${COLORS.border}`};font-size:13px;line-height:1.5;color:${COLORS.muted};">${escapeHtml(row.label)}</td>
          <td align="right" style="padding:${index === 0 ? '0' : '10px'} 0 ${index === visibleRows.length - 1 ? '0' : '10px'} 12px;border-top:${index === 0 ? '0' : `1px solid ${COLORS.border}`};font-size:13px;line-height:1.5;color:${COLORS.text};font-weight:700;word-break:break-word;">${escapeHtml(row.value)}</td>
        </tr>`).join('')}
      </table>
    </td></tr>
  </table>`;
}

export function noticeCard({ title, body, variant = 'neutral' }) {
  const tone = VARIANT[variant] || VARIANT.neutral;
  return `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:20px 0;border:1px solid ${tone.border};border-left:4px solid ${tone.color};border-radius:12px;border-collapse:separate;background:${tone.bg};">
    <tr><td style="padding:16px 18px;">
      ${title ? `<p style="margin:0 0 8px;font-size:12px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:${tone.color};">${escapeHtml(title)}</p>` : ''}
      <div style="font-size:14px;line-height:1.7;color:${COLORS.text};">${renderRichText(body)}</div>
    </td></tr>
  </table>`;
}

export function analyticsBlocks(items = []) {
  const visible = items.filter((item) => item && item.value !== undefined && item.value !== null);
  if (!visible.length) return '';
  return `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:22px 0;">
    <tr>
      ${visible.slice(0, 3).map((item) => `<td width="${Math.floor(100 / Math.min(visible.length, 3))}%" style="padding:0 6px 12px;">
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="border:1px solid ${COLORS.border};border-radius:12px;background:${COLORS.surface};">
          <tr><td style="padding:16px 14px;text-align:center;">
            <p style="margin:0 0 6px;font-size:11px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:${COLORS.muted};">${escapeHtml(item.label)}</p>
            <p style="margin:0;font-size:20px;line-height:1.2;font-weight:900;color:${COLORS.text};">${escapeHtml(item.value)}</p>
          </td></tr>
        </table>
      </td>`).join('')}
    </tr>
  </table>`;
}

function renderSection(section) {
  if (!section) return '';
  if (section.type === 'paragraph') return paragraph(section.text, section.color || COLORS.text);
  if (section.type === 'richText') return renderRichText(section.value || section.html || section.text);
  if (section.type === 'list') {
    const items = Array.isArray(section.items) ? section.items : [];
    return renderRichText(items.map((item) => `- ${item}`).join('\n'));
  }
  if (section.type === 'keyValue') return keyValueTable(section.rows, { title: section.title });
  if (section.type === 'notice') return noticeCard(section);
  if (section.type === 'analytics') return analyticsBlocks(section.items);
  if (section.type === 'divider') return divider();
  if (section.type === 'html') return sanitizeHtml(String(section.html || ''), {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['table', 'tbody', 'tr', 'td', 'th']),
    allowedAttributes: {
      '*': ['style', 'align', 'width', 'height', 'cellpadding', 'cellspacing', 'role', 'colspan'],
      a: ['href', 'target', 'rel', 'style'],
      img: ['src', 'alt', 'width', 'height', 'style'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
  });
  return '';
}

export function renderEmailLayout({
  title,
  preheader,
  eyebrow,
  heading,
  intro,
  badge,
  sections = [],
  cta,
  secondaryCta,
  fallbackUrl,
  footerNote,
  templateKey,
  theme: themeOverrides = {},
}) {
  const theme = getEmailTheme(themeOverrides);
  const logoUrl = safeUrl(theme.logoUrl, '');
  const supportHref = `mailto:${theme.supportEmail}`;
  const year = new Date().getFullYear();
  const bodyHtml = sections.map(renderSection).join('');
  const ctaHtml = cta?.label && cta?.url ? button(cta) : '';
  const secondaryCtaHtml = secondaryCta?.label && secondaryCta?.url
    ? `<p style="margin:10px 0 0;text-align:center;font-size:13px;line-height:1.6;"><a href="${safeUrl(secondaryCta.url, '#')}" style="color:${COLORS.brand};text-decoration:none;font-weight:700;">${escapeHtml(secondaryCta.label)}</a></p>`
    : '';
  const fallbackHtml = fallbackUrl ? fallbackLink(fallbackUrl) : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>${escapeHtml(title || heading || theme.brandName)}</title>
  <style>
    @media only screen and (max-width: 620px) {
      .email-shell { width: 100% !important; }
      .email-pad { padding-left: 22px !important; padding-right: 22px !important; }
      .email-title { font-size: 24px !important; line-height: 1.2 !important; }
      .email-wrap { padding: 20px 10px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:${COLORS.background};font-family:${FONT_STACK};-webkit-font-smoothing:antialiased;">
  ${hiddenPreheader(preheader)}
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:${COLORS.background};margin:0;padding:0;">
    <tr>
      <td align="center" class="email-wrap" style="padding:36px 14px;">
        <table width="600" cellpadding="0" cellspacing="0" role="presentation" class="email-shell" style="width:600px;max-width:600px;background:${COLORS.surface};border:1px solid ${COLORS.border};border-radius:16px;border-collapse:separate;overflow:hidden;">
          <tr>
            <td class="email-pad" style="background:${COLORS.dark};padding:28px 34px;text-align:left;">
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                <tr>
                  <td style="vertical-align:middle;">
                    ${logoUrl ? `<img src="${logoUrl}" width="40" height="40" alt="${escapeAttr(theme.brandName)}" style="display:block;border:0;outline:none;text-decoration:none;border-radius:10px;max-width:40px;max-height:40px;">` : `<div style="width:40px;height:40px;border-radius:10px;background:${COLORS.brand};color:#FFFFFF;font-size:18px;font-weight:900;line-height:40px;text-align:center;">${escapeHtml(theme.brandName.slice(0, 1))}</div>`}
                  </td>
                  <td align="right" style="vertical-align:middle;">
                    <div style="font-size:20px;line-height:1.2;font-weight:900;letter-spacing:-0.3px;color:#FFFFFF;">${escapeHtml(theme.brandName)}</div>
                    ${eyebrow ? `<div style="margin-top:6px;font-size:11px;line-height:1.4;font-weight:800;letter-spacing:0.14em;text-transform:uppercase;color:#D1D5DB;">${escapeHtml(eyebrow)}</div>` : ''}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td class="email-pad" style="padding:34px 34px 8px;background:${COLORS.surface};">
              ${badge?.label ? `<div style="margin:0 0 18px;">${statusBadge(badge.label, badge.variant)}</div>` : ''}
              <h1 class="email-title" style="margin:0 0 14px;font-size:28px;line-height:1.18;font-weight:900;letter-spacing:-0.4px;color:${COLORS.text};">${escapeHtml(heading || title || '')}</h1>
              ${intro ? `<div style="margin:0 0 20px;">${renderRichText(intro)}</div>` : ''}
              ${bodyHtml}
              ${ctaHtml}
              ${secondaryCtaHtml}
              ${fallbackHtml}
            </td>
          </tr>
          <tr>
            <td class="email-pad" style="padding:18px 34px 34px;background:${COLORS.surface};">
              ${noticeCard({
                title: 'Support',
                body: `Questions? Reply to this email or contact [${theme.supportEmail}](${supportHref}).`,
                variant: 'neutral',
              })}
              ${footerNote ? `<p style="margin:0 0 12px;font-size:12px;line-height:1.6;color:${COLORS.subtle};">${escapeHtml(footerNote)}</p>` : ''}
            </td>
          </tr>
          <tr>
            <td class="email-pad" style="background:${COLORS.elevated};border-top:1px solid ${COLORS.border};padding:22px 34px;text-align:center;">
              <p style="margin:0 0 6px;font-size:12px;line-height:1.6;color:${COLORS.muted};font-weight:700;">${escapeHtml(theme.brandName)}</p>
              <p style="margin:0;font-size:12px;line-height:1.6;color:${COLORS.subtle};">&copy; ${year} ${escapeHtml(theme.brandName)}. All rights reserved.${theme.address ? ` ${escapeHtml(theme.address)}` : ''}</p>
              ${templateKey ? `<p style="margin:8px 0 0;font-size:10px;line-height:1.4;color:#CBD5E1;">${escapeHtml(templateKey)}</p>` : ''}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function richTextToPlainText(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/<\/?[a-z][\s\S]*>/i.test(raw)) {
    return htmlToText(raw);
  }
  return raw.replace(/\r\n/g, '\n');
}

export function htmlToText(html) {
  let text = String(html || '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/p>/gi, '\n\n');
  text = text.replace(/<\/h[1-6]>/gi, '\n\n');
  text = text.replace(/<\/li>/gi, '\n');
  text = text.replace(/<li[^>]*>/gi, '- ');
  text = text.replace(/<\/tr>/gi, '\n');
  text = text.replace(/<\/td>/gi, ' ');
  text = sanitizeHtml(text, {
    allowedTags: [],
    allowedAttributes: {},
  });
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function normalizeAdminMessage(value, max = 8000) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .slice(0, max);
}
