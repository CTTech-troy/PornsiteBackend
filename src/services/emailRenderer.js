import sanitizeHtml from 'sanitize-html';

const DEFAULT_SUPPORT_EMAIL = 'support@xstreamvideos.site';
const DEFAULT_FRONTEND_URL = 'https://xstreamvideos.site';

const FONT_STACK = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const COLORS = {
  background: '#F6F7FB',
  surface: '#FFFFFF',
  text: '#101828',
  muted: '#667085',
  subtle: '#98A2B3',
  border: '#EAECF0',
  elevated: '#F9FAFB',
  brand: '#FF4654',
  brandDark: '#E0313F',
  brandSoft: '#FFF1F3',
  success: '#047857',
  successBg: '#ECFDF5',
  warning: '#B54708',
  warningBg: '#FFFBEB',
  danger: '#B42318',
  dangerBg: '#FEF2F2',
  info: '#175CD3',
  infoBg: '#EFF6FF',
  dark: '#0B1020',
  navy: '#111827',
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
      allowedTags: [
        'h1', 'h2', 'h3', 'h4', 'p', 'br', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'u',
        'a', 'code', 'pre', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img',
      ],
      allowedAttributes: {
        a: ['href', 'title', 'target', 'rel', 'style'],
        img: ['src', 'alt', 'width', 'height', 'style'],
        p: ['style'],
        h1: ['style'],
        h2: ['style'],
        h3: ['style'],
        h4: ['style'],
        ul: ['style'],
        ol: ['style'],
        li: ['style'],
        code: ['style'],
        pre: ['style'],
        blockquote: ['style'],
        table: ['style', 'width', 'cellpadding', 'cellspacing', 'role'],
        th: ['style', 'align', 'width'],
        td: ['style', 'align', 'width', 'colspan'],
      },
      allowedSchemes: ['http', 'https', 'mailto'],
      transformTags: {
        h1: () => ({
          tagName: 'h2',
          attribs: { style: `margin:0 0 14px;font-size:22px;line-height:1.25;font-weight:900;color:${COLORS.text};` },
        }),
        h2: () => ({
          tagName: 'h2',
          attribs: { style: `margin:22px 0 12px;font-size:19px;line-height:1.3;font-weight:900;color:${COLORS.text};` },
        }),
        h3: () => ({
          tagName: 'h3',
          attribs: { style: `margin:20px 0 10px;font-size:16px;line-height:1.35;font-weight:800;color:${COLORS.text};` },
        }),
        h4: () => ({
          tagName: 'h4',
          attribs: { style: `margin:18px 0 8px;font-size:14px;line-height:1.4;font-weight:800;color:${COLORS.text};` },
        }),
        p: () => ({
          tagName: 'p',
          attribs: { style: `margin:0 0 16px;font-size:16px;line-height:1.65;color:${COLORS.text};` },
        }),
        ul: () => ({
          tagName: 'ul',
          attribs: { style: `margin:0 0 18px 0;padding:0 0 0 22px;font-size:16px;line-height:1.65;color:${COLORS.text};` },
        }),
        ol: () => ({
          tagName: 'ol',
          attribs: { style: `margin:0 0 18px 0;padding:0 0 0 22px;font-size:16px;line-height:1.65;color:${COLORS.text};` },
        }),
        li: () => ({
          tagName: 'li',
          attribs: { style: `margin:0 0 8px;font-size:16px;line-height:1.65;color:${COLORS.text};` },
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
        pre: () => ({
          tagName: 'pre',
          attribs: { style: 'margin:0 0 18px;padding:14px 16px;background:#111827;color:#F9FAFB;border-radius:12px;font-family:Menlo,Consolas,monospace;font-size:13px;line-height:1.55;overflow:auto;' },
        }),
        blockquote: () => ({
          tagName: 'blockquote',
          attribs: { style: `margin:18px 0;padding:14px 18px;border-left:4px solid ${COLORS.brand};background:${COLORS.brandSoft};border-radius:10px;color:${COLORS.text};font-size:15px;line-height:1.65;` },
        }),
        table: () => ({
          tagName: 'table',
          attribs: { width: '100%', cellpadding: '0', cellspacing: '0', role: 'presentation', style: `margin:18px 0;border:1px solid ${COLORS.border};border-radius:12px;border-collapse:separate;background:${COLORS.surface};` },
        }),
        th: () => ({
          tagName: 'th',
          attribs: { style: `padding:10px 12px;border-bottom:1px solid ${COLORS.border};font-size:12px;line-height:1.4;font-weight:800;color:${COLORS.muted};text-align:left;` },
        }),
        td: () => ({
          tagName: 'td',
          attribs: { style: `padding:10px 12px;border-bottom:1px solid ${COLORS.border};font-size:13px;line-height:1.5;color:${COLORS.text};` },
        }),
        img: (_tagName, attribs) => ({
          tagName: 'img',
          attribs: {
            src: safeUrl(attribs.src, ''),
            alt: escapeAttr(attribs.alt || ''),
            width: attribs.width || undefined,
            height: attribs.height || undefined,
            style: 'display:block;max-width:100%;height:auto;border:0;border-radius:12px;',
          },
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
    parts.push(`<p style="margin:0 0 16px;font-size:16px;line-height:1.65;color:${COLORS.text};">${inner}</p>`);
    paragraph = [];
  }

  function flushList() {
    if (!list.length) return;
    const tag = listType === 'ol' ? 'ol' : 'ul';
    parts.push(`<${tag} style="margin:0 0 18px 0;padding:0 0 0 22px;font-size:16px;line-height:1.65;color:${COLORS.text};">${list.map((item) => `<li style="margin:0 0 8px;font-size:16px;line-height:1.65;color:${COLORS.text};">${markdownLinkToHtml(item)}</li>`).join('')}</${tag}>`);
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
  return `<p style="margin:0 0 16px;font-size:16px;line-height:1.65;color:${color};">${escapeHtml(text)}</p>`;
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
  return `<table cellpadding="0" cellspacing="0" role="presentation" style="margin:30px auto 10px;" class="email-button-wrap"><tr><td align="center" bgcolor="${bg}" style="border-radius:14px;background:${bg};box-shadow:0 10px 22px rgba(255,70,84,0.20);mso-padding-alt:16px 28px;">
    <a class="email-button" href="${href}" target="_blank" rel="noopener noreferrer" style="display:inline-block;min-width:220px;border-radius:14px;color:#FFFFFF;font-size:16px;font-weight:900;line-height:1.2;text-align:center;text-decoration:none;padding:16px 28px;">${escapeHtml(label)}</a>
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
  return `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:22px 0;border:1px solid ${COLORS.border};border-radius:14px;border-collapse:separate;background:${COLORS.elevated};">
    <tr><td style="padding:18px 20px;">
      <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
        ${title}
        ${visibleRows.map((row, index) => `<tr>
          <td style="padding:${index === 0 ? '0' : '11px'} 12px ${index === visibleRows.length - 1 ? '0' : '11px'} 0;border-top:${index === 0 ? '0' : `1px solid ${COLORS.border}`};font-size:13px;line-height:1.5;color:${COLORS.muted};">${escapeHtml(row.label)}</td>
          <td align="right" style="padding:${index === 0 ? '0' : '11px'} 0 ${index === visibleRows.length - 1 ? '0' : '11px'} 12px;border-top:${index === 0 ? '0' : `1px solid ${COLORS.border}`};font-size:13px;line-height:1.5;color:${COLORS.text};font-weight:800;word-break:break-word;">${escapeHtml(row.value)}</td>
        </tr>`).join('')}
      </table>
    </td></tr>
  </table>`;
}

export function noticeCard({ title, body, variant = 'neutral' }) {
  const tone = VARIANT[variant] || VARIANT.neutral;
  return `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:22px 0;border:1px solid ${tone.border};border-left:4px solid ${tone.color};border-radius:14px;border-collapse:separate;background:${tone.bg};">
    <tr><td style="padding:17px 19px;">
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
    body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { -ms-interpolation-mode: bicubic; }
    @media only screen and (max-width: 620px) {
      .email-shell { width: 100% !important; }
      .email-pad { padding-left: 22px !important; padding-right: 22px !important; }
      .email-hero { padding-top: 26px !important; padding-bottom: 22px !important; }
      .email-title { font-size: 24px !important; line-height: 1.2 !important; }
      .email-wrap { padding: 18px 10px !important; }
      .email-button-wrap { width: 100% !important; }
      .email-button { box-sizing: border-box !important; min-width: 0 !important; width: 100% !important; }
      .email-brand-text { text-align: left !important; padding-left: 12px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:${COLORS.background};font-family:${FONT_STACK};-webkit-font-smoothing:antialiased;">
  ${hiddenPreheader(preheader)}
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:${COLORS.background};margin:0;padding:0;">
    <tr>
      <td align="center" class="email-wrap" style="padding:36px 14px;">
        <table width="640" cellpadding="0" cellspacing="0" role="presentation" class="email-shell" style="width:640px;max-width:640px;border-collapse:separate;">
          <tr>
            <td style="padding:0 0 14px;text-align:center;">
              <a href="${safeUrl(theme.frontUrl, DEFAULT_FRONTEND_URL)}" target="_blank" rel="noopener noreferrer" style="color:${COLORS.brand};font-size:12px;font-weight:800;letter-spacing:0.10em;text-decoration:none;text-transform:uppercase;">${escapeHtml(theme.brandName)}</a>
            </td>
          </tr>
          <tr>
            <td style="background:${COLORS.surface};border:1px solid ${COLORS.border};border-radius:22px;box-shadow:0 22px 60px rgba(16,24,40,0.08);overflow:hidden;">
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:separate;">
          <tr>
            <td class="email-pad email-hero" style="background:${COLORS.dark};padding:30px 38px;text-align:left;">
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                <tr>
                  <td width="52" style="width:52px;vertical-align:middle;">
                    ${logoUrl ? `<img src="${logoUrl}" width="52" height="52" alt="${escapeAttr(theme.brandName)}" style="display:block;border:0;outline:none;text-decoration:none;border-radius:14px;max-width:52px;max-height:52px;">` : `<div style="width:52px;height:52px;border-radius:14px;background:${COLORS.brand};color:#FFFFFF;font-size:24px;font-weight:900;line-height:52px;text-align:center;">${escapeHtml(theme.brandName.slice(0, 1))}</div>`}
                  </td>
                  <td align="right" class="email-brand-text" style="vertical-align:middle;">
                    <div style="font-size:22px;line-height:1.18;font-weight:900;letter-spacing:-0.3px;color:#FFFFFF;">${escapeHtml(theme.brandName)}</div>
                    ${eyebrow ? `<div style="margin-top:7px;font-size:11px;line-height:1.4;font-weight:900;letter-spacing:0.14em;text-transform:uppercase;color:#FEE2E2;">${escapeHtml(eyebrow)}</div>` : ''}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td class="email-pad" style="padding:38px 38px 8px;background:${COLORS.surface};">
              ${badge?.label ? `<div style="margin:0 0 18px;">${statusBadge(badge.label, badge.variant)}</div>` : ''}
              <h1 class="email-title" style="margin:0 0 14px;font-size:30px;line-height:1.15;font-weight:900;letter-spacing:-0.4px;color:${COLORS.text};">${escapeHtml(heading || title || '')}</h1>
              ${intro ? `<div style="margin:0 0 22px;">${renderRichText(intro)}</div>` : ''}
              ${bodyHtml}
              ${ctaHtml}
              ${secondaryCtaHtml}
              ${fallbackHtml}
            </td>
          </tr>
          <tr>
            <td class="email-pad" style="padding:18px 38px 38px;background:${COLORS.surface};">
              ${noticeCard({
                title: 'Need help?',
                body: `Reply to this email or contact [${theme.supportEmail}](${supportHref}). We will never ask for your password or payment details by email.`,
                variant: 'neutral',
              })}
              ${footerNote ? `<p style="margin:0 0 12px;font-size:12px;line-height:1.6;color:${COLORS.subtle};">${escapeHtml(footerNote)}</p>` : ''}
            </td>
          </tr>
          <tr>
            <td class="email-pad" style="background:${COLORS.elevated};border-top:1px solid ${COLORS.border};padding:24px 38px;text-align:center;">
              <p style="margin:0 0 6px;font-size:12px;line-height:1.6;color:${COLORS.muted};font-weight:700;">${escapeHtml(theme.brandName)}</p>
              <p style="margin:0;font-size:12px;line-height:1.6;color:${COLORS.subtle};">&copy; ${year} ${escapeHtml(theme.brandName)}. All rights reserved.${theme.address ? ` ${escapeHtml(theme.address)}` : ''}</p>
              ${templateKey ? `<p style="margin:8px 0 0;font-size:10px;line-height:1.4;color:#CBD5E1;">${escapeHtml(templateKey)}</p>` : ''}
            </td>
          </tr>
        </table>
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
