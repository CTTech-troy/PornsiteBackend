import React, { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeft, CheckCircle2, XCircle, AlertCircle, FileText,
  User, MapPin, Shield, Video, Link as LinkIcon, RefreshCwIcon,
  ExternalLink, BadgeCheck, CalendarDays, RotateCcw, Ban, Trash2, ShieldOff,
  Copy, Check, ChevronDown, Search, Database, ClipboardList, Globe2,
  BriefcaseBusiness, Eye,
} from 'lucide-react';
import { StatusBadge, type StatusColor } from '../components/shared/StatusBadge';
import { ActionButton } from '../components/shared/ActionButton';
import {
  fetchCreatorMainApplicationById,
  approveCreatorMainApplication,
  rejectCreatorMainApplication,
  reconsiderCreatorMainApplication,
  banCreatorMainApplication,
  deleteCreatorMainApplication,
  removeCreatorAccessFromApplication,
  updateCreatorStatus,
  type CreatorMainApplication,
} from '../api/usersApi';

const statusColor: Record<string, StatusColor> = {
  pending: 'yellow',
  approved: 'green',
  rejected: 'red',
  banned: 'red',
  info_requested: 'blue',
};

const payloadLabels: Record<string, string> = {
  fullName: 'Full name',
  firstName: 'First name',
  lastName: 'Last name',
  displayName: 'Creator / stage name',
  stageName: 'Stage name',
  creator_type: 'Creator type',
  dateOfBirth: 'Date of birth',
  dob: 'Date of birth',
  ageAtSubmission: 'Age at submission',
  minimumCreatorAge: 'Minimum creator age',
  email: 'Email',
  phone: 'Phone',
  country: 'Country',
  state: 'State',
  city: 'City',
  streetAddress: 'Street address',
  addressLine2: 'Address line 2',
  postalCode: 'Postal code',
  address: 'Full address',
  idType: 'Form of identification',
  idNumber: 'Identification number',
  creatorCategory: 'Creator category',
  contentType: 'Type of content',
  content_type: 'Type of content',
  mainOrientationCategory: 'Content orientation',
  creatorMode: 'Creator mode',
  experienceLevel: 'Experience level',
  bio: 'Bio / about work',
  content: 'Bio / about work',
  privacyAccepted: 'Privacy accepted',
  dataProcessingAccepted: 'Data processing accepted',
  ageConfirmed: 'Age confirmed',
  termsAccepted: 'Terms accepted',
  submittedFrom: 'Submitted from',
  attachments: 'Attachments',
};

type PayloadRecord = Record<string, unknown>;

function isEmpty(value: unknown) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function titleFromKey(key: string) {
  return payloadLabels[key] || key
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatDate(value: unknown, withTime = false) {
  if (!value) return '';
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  const options: Intl.DateTimeFormatOptions = withTime
    ? { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: 'numeric' }
    : { year: 'numeric', month: 'short', day: 'numeric' };
  return date.toLocaleString(undefined, options);
}

function calculateAge(value: unknown) {
  if (!value) return '';
  const dob = new Date(String(value));
  if (Number.isNaN(dob.getTime())) return '';
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const monthDiff = today.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) age -= 1;
  return age >= 0 ? String(age) : '';
}

function isUrl(value: unknown) {
  if (typeof value !== 'string') return false;
  return /^https?:\/\//i.test(value.trim());
}

function valueToText(value: unknown) {
  if (isEmpty(value)) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function renderJsonScalar(rest: string) {
  const trimmed = rest.trim();
  const leadingSpace = rest.slice(0, rest.length - rest.trimStart().length);
  if (!trimmed) return null;
  if (/^"/.test(trimmed)) return <><span>{leadingSpace}</span><span className="text-emerald-300">{trimmed}</span></>;
  if (/^-?\d/.test(trimmed)) return <><span>{leadingSpace}</span><span className="text-amber-300">{trimmed}</span></>;
  if (/^(true|false)/.test(trimmed)) return <><span>{leadingSpace}</span><span className="text-violet-300">{trimmed}</span></>;
  if (/^null/.test(trimmed)) return <><span>{leadingSpace}</span><span className="text-rose-300">{trimmed}</span></>;
  return <><span>{leadingSpace}</span><span className="text-slate-300">{trimmed}</span></>;
}

function JsonSyntaxBlock({ data, compact = false }: { data: unknown; compact?: boolean }) {
  const json = valueToText(data) || '{}';
  return (
    <pre className={`${compact ? 'max-h-44' : 'max-h-[420px]'} custom-scrollbar overflow-auto rounded-xl border border-slate-800 bg-slate-950 p-4 text-xs leading-5 text-slate-300 shadow-inner`}>
      {json.split('\n').map((line, index) => {
        const keyMatch = line.match(/^(\s*)"([^"]+)"(:\s*)(.*)$/);
        return (
          <span key={`${line}-${index}`} className="block whitespace-pre-wrap break-words">
            {keyMatch ? (
              <>
                <span>{keyMatch[1]}</span>
                <span className="text-sky-300">"{keyMatch[2]}"</span>
                <span className="text-slate-500">{keyMatch[3]}</span>
                {renderJsonScalar(keyMatch[4])}
              </>
            ) : (
              <span className="text-slate-400">{line}</span>
            )}
          </span>
        );
      })}
    </pre>
  );
}

function renderValue(value: unknown) {
  if (isEmpty(value)) return <span className="text-slate-400">-</span>;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (isUrl(value)) {
    const url = String(value);
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex min-w-0 items-center gap-1 text-brand-600 hover:text-brand-700 dark:text-brand-400 dark:hover:text-brand-300">
        <span className="truncate">{url}</span>
        <ExternalLink className="h-3.5 w-3.5 flex-shrink-0" />
      </a>
    );
  }
  if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
    return <JsonSyntaxBlock data={value} compact />;
  }
  return String(value);
}

function Field({ label, value }: { label: string; value?: unknown }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
      <div className="mt-0.5 break-words text-sm font-medium text-slate-900 dark:text-white">
        {renderValue(value)}
      </div>
    </div>
  );
}

function PayloadField({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-950/60">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{label}</div>
      <div className="mt-1 break-words text-sm text-slate-800 dark:text-slate-200">{renderValue(value)}</div>
    </div>
  );
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="card p-6">
      <div className="mb-5 flex items-center gap-2">
        <span className="text-brand-500">{icon}</span>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-white">{title}</h2>
      </div>
      {children}
    </div>
  );
}

function normalizeCreatorType(value: unknown) {
  if (value === 'channel') return 'Channel';
  if (value === 'pstar') return 'Porn star';
  return value ? String(value) : '';
}

function attachmentLabel(file: PayloadRecord, index: number) {
  return String(file.name || file.filename || file.path || `Attachment ${index + 1}`);
}

type PayloadDetailItem = {
  key: string;
  label: string;
  value: unknown;
  copyValue?: unknown;
  render?: React.ReactNode;
  wide?: boolean;
  helper?: string;
};

type PayloadGroup = {
  id: string;
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  items: PayloadDetailItem[];
  extra?: React.ReactNode;
  extraSearch?: unknown;
  emptyText?: string;
};

function PayloadValue({ value }: { value: unknown }) {
  if (isEmpty(value)) return <span className="text-sm text-text-tertiary">Not provided</span>;

  if (typeof value === 'boolean') {
    return (
      <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold ${value ? 'border-success/20 bg-success/10 text-success' : 'border-border-default bg-bg-elevated text-text-secondary'}`}>
        {value ? 'Yes' : 'No'}
      </span>
    );
  }

  if (isUrl(value)) {
    const url = String(value).trim();
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex min-w-0 items-center gap-1.5 text-sm font-medium text-brand-600 hover:text-brand-700 dark:text-brand-400 dark:hover:text-brand-300">
        <span className="truncate break-all">{url}</span>
        <ExternalLink className="h-3.5 w-3.5 flex-shrink-0" />
      </a>
    );
  }

  if (typeof value === 'string') {
    const text = value.trim();
    if (text.length > 220) {
      return (
        <details className="group">
          <summary className="cursor-pointer list-none text-sm leading-6 text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
            <span className="break-words">{text.slice(0, 220)}...</span>
            <span className="ml-2 inline-flex items-center gap-1 text-xs font-semibold text-brand-600 group-open:hidden dark:text-brand-400">
              Show more <ChevronDown className="h-3 w-3" />
            </span>
          </summary>
          <p className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-bg-elevated p-3 text-sm leading-6 text-text-secondary">
            {text}
          </p>
        </details>
      );
    }
    return <span className="break-words text-sm text-text-primary">{text}</span>;
  }

  if (typeof value === 'number') return <span className="text-sm text-text-primary">{value}</span>;

  if (Array.isArray(value)) {
    const simple = value.every((item) => ['string', 'number', 'boolean'].includes(typeof item) || item === null);
    if (simple) {
      return (
        <div className="flex flex-wrap gap-2">
          {value.map((item, index) => (
            <span key={`${String(item)}-${index}`} className="max-w-full break-words rounded-full border border-border-default bg-bg-elevated px-2.5 py-1 text-xs font-medium text-text-secondary">
              {valueToText(item) || 'Empty'}
            </span>
          ))}
        </div>
      );
    }
    return <JsonSyntaxBlock data={value} compact />;
  }

  if (typeof value === 'object' && value !== null) return <JsonSyntaxBlock data={value} compact />;

  return <span className="break-words text-sm text-text-primary">{String(value)}</span>;
}

function PayloadDetailCard({
  item,
  copiedKey,
  onCopy,
}: {
  item: PayloadDetailItem;
  copiedKey: string;
  onCopy: (key: string, value: unknown) => void;
}) {
  const copySource = item.copyValue ?? item.value;
  const canCopy = valueToText(copySource).length > 0;

  return (
    <div className={`group min-w-0 rounded-xl border border-border-default bg-bg-surface p-4 shadow-sm transition-all duration-200 hover:border-brand-300 hover:shadow-md dark:hover:border-brand-700/70 ${item.wide ? 'md:col-span-2' : ''}`}>
      <div className="mb-2 flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">{item.label}</p>
          {item.helper && <p className="mt-0.5 text-xs text-text-tertiary">{item.helper}</p>}
        </div>
        {canCopy && (
          <button
            type="button"
            onClick={() => onCopy(item.key, copySource)}
            className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md border border-border-default text-text-tertiary transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 dark:hover:bg-brand-950/40 dark:hover:text-brand-300"
            aria-label={`Copy ${item.label}`}
            title={`Copy ${item.label}`}
          >
            {copiedKey === item.key ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>
      <div className="min-w-0">{item.render ?? <PayloadValue value={item.value} />}</div>
    </div>
  );
}

function PayloadGroupCard({
  group,
  open,
  onToggle,
  copiedKey,
  onCopy,
}: {
  group: PayloadGroup;
  open: boolean;
  onToggle: () => void;
  copiedKey: string;
  onCopy: (key: string, value: unknown) => void;
}) {
  const Icon = group.icon;

  return (
    <section className="overflow-hidden rounded-2xl border border-border-default bg-bg-surface shadow-sm">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-4 border-b border-border-default bg-gradient-to-r from-brand-50/80 to-bg-surface px-4 py-4 text-left transition hover:from-brand-100/70 dark:from-brand-950/20 dark:to-bg-surface dark:hover:from-brand-950/35 sm:px-5"
        aria-expanded={open}
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-brand-600 text-white shadow-sm">
            <Icon className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span className="block text-base font-semibold text-text-primary">{group.title}</span>
            <span className="block text-sm text-text-tertiary">{group.description}</span>
          </span>
        </span>
        <span className="flex flex-shrink-0 items-center gap-2">
          <span className="rounded-full border border-border-default bg-bg-surface px-2 py-0.5 text-xs font-semibold text-text-secondary">
            {group.items.length}
          </span>
          <ChevronDown className={`h-4 w-4 text-text-tertiary transition-transform ${open ? 'rotate-180' : ''}`} />
        </span>
      </button>

      {open && (
        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="p-4 sm:p-5">
          {group.items.length > 0 ? (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {group.items.map((item) => (
                <PayloadDetailCard key={item.key} item={item} copiedKey={copiedKey} onCopy={onCopy} />
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-border-default bg-bg-elevated/50 p-5 text-center text-sm text-text-tertiary">
              {group.emptyText || 'No matching submitted fields in this section.'}
            </div>
          )}
          {group.extra && <div className="mt-4">{group.extra}</div>}
        </motion.div>
      )}
    </section>
  );
}

function PayloadMediaPreview({
  attachments,
  uploadedPhotos,
  uploadedVideos,
}: {
  attachments: PayloadRecord[];
  uploadedPhotos: string[];
  uploadedVideos: string[];
}) {
  const hasMedia = attachments.length > 0 || uploadedPhotos.length > 0 || uploadedVideos.length > 0;
  if (!hasMedia) {
    return (
      <div className="rounded-xl border border-dashed border-border-default bg-bg-elevated/50 p-5 text-center text-sm text-text-tertiary">
        No portfolio files or uploaded media were submitted.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {attachments.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {attachments.map((file, index) => {
            const url = String(file.url || '');
            const contentType = String(file.contentType || file.type || '');
            return (
              <article key={`${url || file.path || index}`} className="min-w-0 overflow-hidden rounded-xl border border-border-default bg-bg-surface shadow-sm">
                {url && contentType.startsWith('image/') && <img src={url} alt={attachmentLabel(file, index)} className="h-44 w-full object-cover" loading="lazy" />}
                {url && contentType.startsWith('video/') && <video src={url} controls className="h-44 w-full bg-black object-contain" />}
                {!contentType.startsWith('image/') && !contentType.startsWith('video/') && (
                  <div className="flex h-28 items-center justify-center bg-bg-elevated text-text-tertiary">
                    <FileText className="h-8 w-8" />
                  </div>
                )}
                <div className="space-y-1.5 p-3">
                  <p className="break-words text-sm font-semibold text-text-primary">{attachmentLabel(file, index)}</p>
                  <p className="text-xs text-text-tertiary">{contentType || 'Uploaded file'}</p>
                  {url && (
                    <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm font-semibold text-brand-600 hover:text-brand-700 dark:text-brand-400">
                      Preview file <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {uploadedPhotos.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-tertiary">Uploaded photos</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {uploadedPhotos.map((url, index) => (
              <a key={url || index} href={url} target="_blank" rel="noopener noreferrer" className="group overflow-hidden rounded-xl border border-border-default bg-bg-elevated">
                <img src={url} alt={`Uploaded photo ${index + 1}`} className="aspect-square w-full object-cover transition group-hover:scale-[1.02]" loading="lazy" />
              </a>
            ))}
          </div>
        </div>
      )}

      {uploadedVideos.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-tertiary">Uploaded videos</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {uploadedVideos.map((url, index) => (
              <div key={url || index} className="overflow-hidden rounded-xl border border-border-default bg-bg-surface">
                <video src={url} controls className="max-h-56 w-full bg-black object-contain" />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ApplicationDetailsSkeleton() {
  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center gap-4">
        <div className="h-10 w-10 animate-pulse rounded-lg bg-bg-elevated" />
        <div className="space-y-2">
          <div className="h-7 w-56 animate-pulse rounded bg-bg-elevated" />
          <div className="h-4 w-72 animate-pulse rounded bg-bg-elevated" />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {[0, 1, 2].map((item) => (
            <div key={item} className="card p-5">
              <div className="mb-5 h-6 w-52 animate-pulse rounded bg-bg-elevated" />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {[0, 1, 2, 3].map((field) => (
                  <div key={field} className="h-24 animate-pulse rounded-xl bg-bg-elevated" />
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="card h-80 animate-pulse p-6" />
      </div>
    </div>
  );
}

function PremiumPayloadViewer({
  app,
  rawData,
  valueOf,
  fullName,
  stageName,
  dob,
  age,
  creatorType,
  category,
  contentType,
  attachments,
  uploadedPhotos,
  uploadedVideos,
  socialLinks,
  copiedKey,
  onCopy,
}: {
  app: CreatorMainApplication;
  rawData: PayloadRecord;
  valueOf: (...keys: string[]) => unknown;
  fullName: string;
  stageName: unknown;
  dob: unknown;
  age: unknown;
  creatorType: string;
  category: unknown;
  contentType: unknown;
  attachments: PayloadRecord[];
  uploadedPhotos: string[];
  uploadedVideos: string[];
  socialLinks: [string, unknown][];
  copiedKey: string;
  onCopy: (key: string, value: unknown) => void;
}) {
  const [payloadSearch, setPayloadSearch] = useState('');
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    applicant: true,
    creator: true,
    social: true,
    application: true,
    moderation: true,
    raw: false,
  });

  const toggleSection = (section: string) => {
    setOpenSections((prev) => ({ ...prev, [section]: !prev[section] }));
  };

  const username = app.users?.username || app.username || valueOf('username', 'userName');
  const mediaSearchText = [attachments, uploadedPhotos, uploadedVideos].map(valueToText).join(' ');
  const socialItems: PayloadDetailItem[] = socialLinks.map(([label, url], index) => ({
    key: `social-${label}-${index}`,
    label,
    value: url,
    wide: true,
  }));

  const groups: PayloadGroup[] = [
    {
      id: 'applicant',
      title: 'Applicant Information',
      description: 'Identity, contact, and account details for review.',
      icon: User,
      items: [
        { key: 'fullName', label: 'Full name', value: fullName },
        { key: 'username', label: 'Username', value: username ? `@${username}` : '' },
        { key: 'email', label: 'Email', value: valueOf('email') || app.email },
        { key: 'phone', label: 'Phone number', value: valueOf('phone') },
        { key: 'dob', label: 'Date of birth', value: dob ? formatDate(dob) : '' },
        { key: 'age', label: 'Age at submission', value: age, helper: 'Creators must be 18 or older.' },
        { key: 'userId', label: 'User ID', value: app.user_id, wide: true },
      ],
    },
    {
      id: 'creator',
      title: 'Creator Information',
      description: 'Creator profile positioning and content review details.',
      icon: BriefcaseBusiness,
      items: [
        { key: 'stageName', label: 'Creator / stage name', value: stageName },
        { key: 'creatorType', label: 'Creator type', value: creatorType },
        { key: 'category', label: 'Creator category', value: category },
        { key: 'contentType', label: 'Type of content', value: contentType },
        { key: 'niche', label: 'Niche', value: valueOf('niche', 'creatorNiche', 'contentNiche') },
        { key: 'experience', label: 'Experience level', value: valueOf('experienceLevel', 'creatorMode', 'experience') },
      ],
    },
    {
      id: 'social',
      title: 'Social Media',
      description: 'Public social links, websites, and external profiles.',
      icon: Globe2,
      items: socialItems,
      emptyText: 'No social or portfolio links were submitted.',
    },
    {
      id: 'application',
      title: 'Application Details',
      description: 'Narrative answers, goals, portfolio, and uploaded media.',
      icon: ClipboardList,
      items: [
        { key: 'bio', label: 'Bio / about', value: valueOf('bio', 'content', 'application_message'), wide: true },
        { key: 'goals', label: 'Creator goals', value: valueOf('goals', 'creatorGoals', 'applicationGoals'), wide: true },
        { key: 'portfolio', label: 'Portfolio links', value: valueOf('portfolioUrl', 'portfolio', 'portfolioLinks', 'portfolio_links'), wide: true },
        { key: 'submittedFrom', label: 'Submitted from', value: valueOf('submittedFrom') },
        { key: 'termsAccepted', label: 'Terms accepted', value: valueOf('termsAccepted') },
        { key: 'privacyAccepted', label: 'Privacy accepted', value: valueOf('privacyAccepted') },
        { key: 'mediaCount', label: 'Uploaded media count', value: attachments.length + uploadedPhotos.length + uploadedVideos.length },
      ],
      extra: (
        <PayloadMediaPreview
          attachments={attachments}
          uploadedPhotos={uploadedPhotos}
          uploadedVideos={uploadedVideos}
        />
      ),
      extraSearch: mediaSearchText,
    },
    {
      id: 'moderation',
      title: 'Moderation Information',
      description: 'Current review state, decision notes, and audit context.',
      icon: Shield,
      items: [
        {
          key: 'status',
          label: 'Status',
          value: app.status,
          render: <StatusBadge status={app.status} color={statusColor[app.status] || 'gray'} dot />,
        },
        { key: 'submittedAt', label: 'Submitted date', value: formatDate(app.created_at, true) },
        { key: 'reviewedAt', label: 'Reviewed date', value: app.reviewed_at ? formatDate(app.reviewed_at, true) : '' },
        { key: 'reviewedBy', label: 'Reviewed by', value: (app as PayloadRecord).reviewed_by || valueOf('reviewedBy', 'reviewed_by') },
        { key: 'reviewReason', label: 'Review note', value: app.review_reason || valueOf('reviewReason', 'review_reason'), wide: true },
        { key: 'rejectionReason', label: 'Rejection reason', value: app.rejection_reason || valueOf('rejectionReason', 'rejection_reason'), wide: true },
        { key: 'moderationHistory', label: 'Moderation history', value: valueOf('moderationHistory', 'moderation_history'), wide: true },
      ],
    },
  ];

  const query = payloadSearch.trim().toLowerCase();
  const filteredGroups = groups
    .map((group) => {
      const items = query
        ? group.items.filter((item) => {
            const haystack = [group.title, group.description, item.label, valueToText(item.copyValue ?? item.value)]
              .join(' ')
              .toLowerCase();
            return haystack.includes(query);
          })
        : group.items;
      const extraMatches = query && valueToText(group.extraSearch).toLowerCase().includes(query);
      return { ...group, items: extraMatches ? group.items : items };
    })
    .filter((group) => !query || group.items.length > 0 || valueToText(group.extraSearch).toLowerCase().includes(query));

  const totalStructuredFields = groups.reduce((count, group) => count + group.items.length, 0);
  const rawPayloadMatches = !query || valueToText(rawData).toLowerCase().includes(query);

  return (
    <div className="overflow-hidden rounded-2xl border border-brand-200/70 bg-gradient-to-b from-white to-brand-50/30 shadow-sm dark:border-brand-900/50 dark:from-bg-surface dark:to-brand-950/10">
      <div className="border-b border-border-default p-4 sm:p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-brand-600 text-white shadow-sm">
                <Database className="h-5 w-5" />
              </span>
              <div>
                <h2 className="text-lg font-semibold text-text-primary">Full Submitted Payload</h2>
                <p className="text-sm text-text-tertiary">
                  {totalStructuredFields} structured review fields from the original submission.
                </p>
              </div>
            </div>
          </div>
          <div className="relative w-full lg:max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-tertiary" />
            <input
              type="search"
              value={payloadSearch}
              onChange={(event) => setPayloadSearch(event.target.value)}
              className="input-field h-10 pl-9"
              placeholder="Search payload fields"
              aria-label="Search submitted payload"
            />
          </div>
        </div>
      </div>

      <div className="space-y-4 p-4 sm:p-5">
        {filteredGroups.length > 0 ? (
          filteredGroups.map((group) => (
            <PayloadGroupCard
              key={group.id}
              group={group}
              open={openSections[group.id] ?? true}
              onToggle={() => toggleSection(group.id)}
              copiedKey={copiedKey}
              onCopy={onCopy}
            />
          ))
        ) : (
          <div className="rounded-xl border border-dashed border-border-default bg-bg-surface p-8 text-center">
            <Search className="mx-auto mb-3 h-8 w-8 text-text-tertiary" />
            <p className="text-sm font-semibold text-text-primary">No payload fields matched your search.</p>
            <p className="mt-1 text-sm text-text-tertiary">Try a name, social platform, status, or media filename.</p>
          </div>
        )}

        {rawPayloadMatches && (
          <section className="overflow-hidden rounded-2xl border border-border-default bg-bg-surface shadow-sm">
            <div className="flex items-center justify-between gap-3 px-4 py-4 transition hover:bg-bg-elevated sm:px-5">
              <button
                type="button"
                onClick={() => toggleSection('raw')}
                className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                aria-expanded={openSections.raw}
              >
                <span className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-slate-950 text-white dark:bg-slate-800">
                  <Eye className="h-5 w-5" />
                </span>
                <span className="min-w-0">
                  <span className="block text-base font-semibold text-text-primary">Raw Payload Viewer</span>
                  <span className="block text-sm text-text-tertiary">Expandable syntax-highlighted source data for audit checks.</span>
                </span>
                <ChevronDown className={`ml-auto h-4 w-4 flex-shrink-0 text-text-tertiary transition-transform ${openSections.raw ? 'rotate-180' : ''}`} />
              </button>
              <span className="flex flex-shrink-0 items-center">
                <button
                  type="button"
                  onClick={(event) => { event.stopPropagation(); onCopy('raw-payload', rawData); }}
                  className="inline-flex h-8 items-center gap-1 rounded-md border border-border-default px-2 text-xs font-semibold text-text-secondary hover:border-brand-300 hover:text-brand-700 dark:hover:text-brand-300"
                >
                  {copiedKey === 'raw-payload' ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
                  Copy
                </button>
              </span>
            </div>
            {openSections.raw && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="border-t border-border-default p-4 sm:p-5">
                <JsonSyntaxBlock data={rawData} />
              </motion.div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

export function ApplicationDetails() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [app, setApp] = useState<CreatorMainApplication | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [adminNote, setAdminNote] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [noteError, setNoteError] = useState('');
  const [toast, setToast] = useState('');
  const [copiedKey, setCopiedKey] = useState('');

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(''), 3500); };

  const copyToClipboard = async (key: string, value: unknown) => {
    const text = valueToText(value);
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        throw new Error('Clipboard API unavailable');
      }
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
    setCopiedKey(key);
    showToast('Copied to clipboard.');
    setTimeout(() => setCopiedKey(''), 1800);
  };

  const loadApplication = () => {
    if (!id) return;
    setLoading(true);
    setError('');
    fetchCreatorMainApplicationById(id)
      .then((res) => setApp(res.application))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadApplication();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const handleAction = async (action: string) => {
    if (!id) return;
    if (['rejected', 'banned', 'delete', 'remove_access'].includes(action) && !adminNote.trim()) {
      setNoteError('Please provide a reason for this action.');
      return;
    }
    setNoteError('');
    try {
      setActionLoading(true);
      if (action === 'approved') {
        await approveCreatorMainApplication(id, adminNote || undefined);
      } else if (action === 'rejected') {
        await rejectCreatorMainApplication(id, adminNote);
      } else if (action === 'pending') {
        await reconsiderCreatorMainApplication(id, adminNote || undefined);
      } else if (action === 'banned') {
        await banCreatorMainApplication(id, adminNote);
      } else if (action === 'delete') {
        await deleteCreatorMainApplication(id, adminNote);
        showToast('Application deleted.');
        navigate('/creator-applications');
        return;
      } else if (action === 'remove_access') {
        await removeCreatorAccessFromApplication(id, adminNote);
      } else if (action === 'suspended') {
        await updateCreatorStatus(app?.creator_id || app?.user_id || id, 'suspended', adminNote || 'Suspended by admin.');
      }
      showToast(action === 'approved' ? 'Creator approved to Xstream.' : 'Application updated successfully.');
      const nextStatus = action === 'remove_access' ? 'rejected' : action === 'suspended' ? app?.status : action;
      setApp((prev) => prev ? {
        ...prev,
        status: (nextStatus || prev.status) as any,
        approved: nextStatus === 'approved',
        rejected: nextStatus === 'rejected',
        rejection_reason: nextStatus === 'rejected' ? adminNote : prev.rejection_reason,
        review_reason: adminNote || prev.review_reason,
        reviewed_at: new Date().toISOString(),
      } : prev);
      loadApplication();
    } catch (e: any) {
      showToast(`Error: ${e.message}`);
    } finally {
      setActionLoading(false);
    }
  };

  const rawData = useMemo(() => {
    const raw = (app?.raw_data || app?.data || {}) as PayloadRecord;
    return raw && typeof raw === 'object' ? raw : {};
  }, [app]);

  const valueOf = (...keys: string[]) => {
    for (const key of keys) {
      const fromRaw = rawData[key];
      if (!isEmpty(fromRaw)) return fromRaw;
      const fromApp = app ? (app as PayloadRecord)[key] : undefined;
      if (!isEmpty(fromApp)) return fromApp;
    }
    return '';
  };

  if (loading) {
    return <ApplicationDetailsSkeleton />;
  }

  if (error || !app) {
    return (
      <div className="p-6">
        <button onClick={() => navigate('/creator-applications')} className="mb-4 flex items-center gap-2 text-slate-500 hover:text-slate-700">
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700 dark:bg-red-900/20 dark:text-red-400">
          {error || 'Application not found.'}
        </div>
      </div>
    );
  }

  const fullName = String(valueOf('fullName', 'full_name') || app.full_name || app.users?.username || app.user_id);
  const stageName = valueOf('displayName', 'stageName');
  const dob = valueOf('dateOfBirth', 'dob');
  const age = valueOf('ageAtSubmission') || calculateAge(dob);
  const creatorType = normalizeCreatorType(valueOf('creator_type'));
  const category = valueOf('creatorCategory', 'category');
  const contentType = valueOf('contentType', 'content_type', 'mainOrientationCategory');
  const attachments = Array.isArray(valueOf('attachments')) ? valueOf('attachments') as PayloadRecord[] : [];
  const uploadedPhotos = app.uploaded_photos || [];
  const uploadedVideos = app.uploaded_videos || [];
  const socialLinks = [
    ['Instagram', valueOf('instagramUrl')],
    ['X / Twitter', valueOf('xUrl')],
    ['TikTok', valueOf('tiktokUrl')],
    ['YouTube', valueOf('youtubeUrl')],
    ['Website', valueOf('websiteUrl')],
    ...Object.entries(app.social_links || {}).map(([key, url]) => [titleFromKey(key), url] as [string, unknown]),
  ].filter(([, url]) => !isEmpty(url));

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-6 p-4 pb-40 sm:p-6 sm:pb-40 lg:pb-6">
      {toast && <div className="fixed right-4 top-4 z-50 rounded-lg bg-gray-900 px-4 py-2 text-sm text-white shadow-lg">{toast}</div>}

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <button onClick={() => navigate('/creator-applications')}
          className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 dark:hover:bg-slate-800">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Creator Application</h1>
            <StatusBadge status={app.status} color={statusColor[app.status] || 'gray'} />
          </div>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Submitted by <strong>{fullName}</strong> - {formatDate(app.created_at)}
          </p>
        </div>
        {(app.status === 'pending' || app.status === 'info_requested') && (
          <ActionButton
            variant="primary"
            icon={BadgeCheck}
            isLoading={actionLoading}
            label="Approve to Xstream"
            onClick={() => handleAction('approved')}
            className="h-10 bg-emerald-600 px-4 text-white hover:bg-emerald-700"
          />
        )}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Section icon={<User className="h-5 w-5" />} title="Personal and Account">
            <div className="flex flex-col gap-6 sm:flex-row">
              <img
                src={app.profile_picture || app.users?.avatar_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(fullName)}&size=96&background=random`}
                className="h-20 w-20 flex-shrink-0 rounded-full border-2 border-slate-200 object-cover dark:border-slate-700"
                alt={fullName}
              />
              <div className="grid flex-1 grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
                <Field label="Full Name" value={fullName} />
                <Field label="Creator / Stage Name" value={stageName} />
                <Field label="First Name" value={valueOf('firstName')} />
                <Field label="Last Name" value={valueOf('lastName')} />
                <Field label="Email" value={valueOf('email') || app.email} />
                <Field label="Phone" value={valueOf('phone')} />
                <Field label="Username" value={`@${app.users?.username || app.username || app.user_id}`} />
                <Field label="User ID" value={app.user_id} />
              </div>
            </div>
          </Section>

          <Section icon={<MapPin className="h-5 w-5" />} title="Contact and Address">
            <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
              <Field label="Country" value={valueOf('country')} />
              <Field label="State" value={valueOf('state')} />
              <Field label="City" value={valueOf('city', 'lga')} />
              <Field label="Street Address" value={valueOf('streetAddress')} />
              <Field label="Address Line 2" value={valueOf('addressLine2', 'houseDetails')} />
              <Field label="Postal Code" value={valueOf('postalCode')} />
              <div className="sm:col-span-2">
                <Field label="Full Address" value={valueOf('address')} />
              </div>
            </div>
          </Section>

          <Section icon={<FileText className="h-5 w-5" />} title="Creator Review Details">
            <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
              <Field label="Creator Type" value={creatorType} />
              <Field label="Creator Category" value={category} />
              <Field label="Type of Content" value={contentType} />
              <Field label="Experience Level" value={valueOf('experienceLevel', 'creatorMode', 'experience')} />
              <div className="sm:col-span-2">
                <Field label="Bio / About Work" value={valueOf('bio', 'content', 'application_message')} />
              </div>
            </div>
          </Section>

          <Section icon={<Shield className="h-5 w-5" />} title="Private Review and Identification">
            <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
              <Field label="Date of Birth" value={dob ? formatDate(dob) : ''} />
              <Field label="Age at Submission" value={age} />
              <Field label="Form of Identification" value={valueOf('idType')} />
              <Field label="Identification Number" value={valueOf('idNumber')} />
              <Field label="Age Confirmed" value={valueOf('ageConfirmed')} />
              <Field label="Terms Accepted" value={valueOf('termsAccepted')} />
              <Field label="Privacy Accepted" value={valueOf('privacyAccepted')} />
              <Field label="Data Processing Accepted" value={valueOf('dataProcessingAccepted')} />
            </div>
          </Section>

          {socialLinks.length > 0 && (
            <Section icon={<LinkIcon className="h-5 w-5" />} title="Social Links">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {socialLinks.map(([label, url]) => (
                  <PayloadField key={`${label}-${String(url)}`} label={String(label)} value={url} />
                ))}
              </div>
            </Section>
          )}

          {(attachments.length > 0 || uploadedPhotos.length > 0 || uploadedVideos.length > 0) && (
            <Section icon={<Video className="h-5 w-5" />} title="Files and Attachments">
              {attachments.length > 0 && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {attachments.map((file, index) => {
                    const url = String(file.url || '');
                    const contentType = String(file.contentType || '');
                    return (
                      <div key={`${url || file.path || index}`} className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950/60">
                        {url && contentType.startsWith('image/') && <img src={url} alt={attachmentLabel(file, index)} className="h-48 w-full object-cover" />}
                        {url && contentType.startsWith('video/') && <video src={url} controls className="h-48 w-full bg-black object-contain" />}
                        <div className="space-y-1 p-3">
                          <p className="break-words text-sm font-semibold text-slate-900 dark:text-white">{attachmentLabel(file, index)}</p>
                          <p className="text-xs text-slate-500 dark:text-slate-400">{contentType || 'Uploaded file'}</p>
                          {url && (
                            <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm font-medium text-brand-600 hover:text-brand-700 dark:text-brand-400">
                              Open file <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {uploadedPhotos.length > 0 && (
                <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
                  {uploadedPhotos.map((url, i) => (
                    <a key={url || i} href={url} target="_blank" rel="noopener noreferrer">
                      <img src={url} alt={`Photo ${i + 1}`} className="aspect-square w-full rounded-lg border border-slate-200 object-cover dark:border-slate-700" />
                    </a>
                  ))}
                </div>
              )}

              {uploadedVideos.length > 0 && (
                <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {uploadedVideos.map((url, i) => (
                    <div key={url || i} className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700">
                      <video src={url} controls className="max-h-48 w-full" />
                    </div>
                  ))}
                </div>
              )}
            </Section>
          )}

          <PremiumPayloadViewer
            app={app}
            rawData={rawData}
            valueOf={valueOf}
            fullName={fullName}
            stageName={stageName}
            dob={dob}
            age={age}
            creatorType={creatorType}
            category={category}
            contentType={contentType}
            attachments={attachments}
            uploadedPhotos={uploadedPhotos}
            uploadedVideos={uploadedVideos}
            socialLinks={socialLinks as [string, unknown][]}
            copiedKey={copiedKey}
            onCopy={copyToClipboard}
          />
        </div>

        <div className="space-y-6">
          <div className="card border-2 border-brand-500/20 p-6 dark:border-brand-500/30 lg:sticky lg:top-24">
            <h2 className="mb-4 text-lg font-semibold text-slate-900 dark:text-white">Admin Decision</h2>
            <div className="mb-4 space-y-3 rounded-xl bg-slate-50 p-4 text-sm dark:bg-slate-950/60">
              <div className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
                <CalendarDays className="h-4 w-4 text-brand-500" />
                Submitted {formatDate(app.created_at, true)}
              </div>
              {app.reviewed_at && (
                <div className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  Reviewed {formatDate(app.reviewed_at, true)}
                </div>
              )}
              {app.review_reason && <Field label="Last Review Note" value={app.review_reason} />}
            </div>
            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
                  Notes / Reason
                </label>
                <textarea
                  value={adminNote}
                  onChange={(e) => { setAdminNote(e.target.value); if (noteError && e.target.value.trim()) setNoteError(''); }}
                  className={`input-field min-h-[96px] w-full resize-none ${noteError ? 'border-red-500 ring-1 ring-red-500' : ''}`}
                  placeholder="Optional for approval. Required for rejection."
                />
                {noteError && (
                  <p className="mt-1 flex items-center gap-1 text-xs text-red-500">
                    <AlertCircle className="h-3 w-3 flex-shrink-0" /> {noteError}
                  </p>
                )}
              </div>
              <div className="flex flex-col gap-2">
                {(app.status === 'pending' || app.status === 'info_requested') && (
                  <>
                    <ActionButton
                      variant="primary"
                      icon={CheckCircle2}
                      isLoading={actionLoading}
                      label="Approve to Xstream"
                      onClick={() => handleAction('approved')}
                      className="w-full justify-center bg-emerald-600 text-white hover:bg-emerald-700"
                    />
                    <ActionButton
                      variant="danger"
                      icon={XCircle}
                      isLoading={actionLoading}
                      label="Reject"
                      onClick={() => handleAction('rejected')}
                      className="w-full justify-center"
                    />
                  </>
                )}
                {app.status === 'approved' && (
                  <>
                    <ActionButton
                      variant="secondary"
                      icon={User}
                      label="View Creator"
                      onClick={() => navigate('/creators')}
                      className="w-full justify-center"
                    />
                    <ActionButton
                      variant="warning"
                      icon={ShieldOff}
                      isLoading={actionLoading}
                      label="Suspend Creator"
                      onClick={() => handleAction('suspended')}
                      className="w-full justify-center"
                    />
                    <ActionButton
                      variant="danger"
                      icon={XCircle}
                      isLoading={actionLoading}
                      label="Remove Creator Access"
                      onClick={() => handleAction('remove_access')}
                      className="w-full justify-center"
                    />
                  </>
                )}
                {(app.status === 'rejected' || app.status === 'banned') && (
                  <>
                    <ActionButton
                      variant="primary"
                      icon={RotateCcw}
                      isLoading={actionLoading}
                      label="Reconsider Application"
                      onClick={() => handleAction('pending')}
                      className="w-full justify-center"
                    />
                    <ActionButton
                      variant="danger"
                      icon={Ban}
                      isLoading={actionLoading}
                      label="Ban From Applying"
                      onClick={() => handleAction('banned')}
                      className="w-full justify-center"
                    />
                    <ActionButton
                      variant="danger"
                      icon={Trash2}
                      isLoading={actionLoading}
                      label="Delete Application"
                      onClick={() => handleAction('delete')}
                      className="w-full justify-center"
                    />
                  </>
                )}
                <ActionButton
                  variant="secondary"
                  icon={RefreshCwIcon}
                  label="Refresh"
                  onClick={loadApplication}
                  className="w-full justify-center"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border-default bg-bg-surface/95 p-3 shadow-2xl backdrop-blur lg:hidden">
        <div className="mx-auto max-w-3xl">
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">Admin actions</span>
            <StatusBadge status={app.status} color={statusColor[app.status] || 'gray'} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            {(app.status === 'pending' || app.status === 'info_requested') && (
              <>
                <ActionButton
                  size="sm"
                  variant="primary"
                  icon={CheckCircle2}
                  isLoading={actionLoading}
                  label="Approve"
                  onClick={() => handleAction('approved')}
                  className="w-full justify-center bg-emerald-600 text-white hover:bg-emerald-700"
                />
                <ActionButton
                  size="sm"
                  variant="danger"
                  icon={XCircle}
                  isLoading={actionLoading}
                  label="Reject"
                  onClick={() => handleAction('rejected')}
                  className="w-full justify-center"
                />
              </>
            )}
            {app.status === 'approved' && (
              <>
                <ActionButton
                  size="sm"
                  variant="secondary"
                  icon={User}
                  label="Creator"
                  onClick={() => navigate('/creators')}
                  className="w-full justify-center"
                />
                <ActionButton
                  size="sm"
                  variant="warning"
                  icon={ShieldOff}
                  isLoading={actionLoading}
                  label="Suspend"
                  onClick={() => handleAction('suspended')}
                  className="w-full justify-center"
                />
                <ActionButton
                  size="sm"
                  variant="danger"
                  icon={XCircle}
                  isLoading={actionLoading}
                  label="Remove Access"
                  onClick={() => handleAction('remove_access')}
                  className="w-full justify-center"
                />
              </>
            )}
            {(app.status === 'rejected' || app.status === 'banned') && (
              <>
                <ActionButton
                  size="sm"
                  variant="primary"
                  icon={RotateCcw}
                  isLoading={actionLoading}
                  label="Reconsider"
                  onClick={() => handleAction('pending')}
                  className="w-full justify-center"
                />
                <ActionButton
                  size="sm"
                  variant="danger"
                  icon={Ban}
                  isLoading={actionLoading}
                  label="Ban"
                  onClick={() => handleAction('banned')}
                  className="w-full justify-center"
                />
                <ActionButton
                  size="sm"
                  variant="danger"
                  icon={Trash2}
                  isLoading={actionLoading}
                  label="Delete"
                  onClick={() => handleAction('delete')}
                  className="w-full justify-center"
                />
              </>
            )}
            <ActionButton
              size="sm"
              variant="secondary"
              icon={RefreshCwIcon}
              label="Refresh"
              onClick={loadApplication}
              className="w-full justify-center"
            />
          </div>
        </div>
      </div>
    </motion.div>
  );
}
