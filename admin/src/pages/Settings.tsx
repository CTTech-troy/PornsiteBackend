import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  AlertTriangleIcon,
  CheckCircleIcon,
  EyeIcon,
  LockIcon,
  RefreshCwIcon,
  SaveIcon,
  SearchIcon,
} from 'lucide-react';
import { ActionButton } from '../components/shared/ActionButton';
import { fetchSettings, saveSettings, type PlatformSetting } from '../api/systemApi';

const SECTION_ORDER = [
  'Brand',
  'Legal',
  'Localization',
  'Moderation',
  'Creator Payouts',
  'Monetization',
  'Payments',
  'Notifications',
  'Access',
  'Uploads',
  'Verification',
  'System',
];

function grouped(settings: PlatformSetting[]) {
  const groups = new Map<string, PlatformSetting[]>();
  for (const setting of settings) {
    const section = setting.section || 'General';
    if (!groups.has(section)) groups.set(section, []);
    groups.get(section)!.push(setting);
  }
  return Array.from(groups.entries()).sort(([a], [b]) => {
    const ai = SECTION_ORDER.indexOf(a);
    const bi = SECTION_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

function isTruthy(value: string) {
  return ['true', '1', 'yes', 'on', 'enabled'].includes(String(value || '').toLowerCase());
}

function prettyJson(value: string) {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value || '';
  }
}

function validateSetting(setting: PlatformSetting, value: string) {
  if (setting.sensitive) return '';
  const label = setting.label || setting.key;
  const raw = String(value ?? '').trim();
  if (setting.required && !raw) return `${label} is required.`;
  if (!raw) return '';
  if (setting.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) && !/^[^<>]+<[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+>$/.test(raw)) {
    return `${label} must be a valid email.`;
  }
  if (setting.type === 'url') {
    if (raw.startsWith('/')) return '';
    try {
      new URL(raw);
    } catch {
      return `${label} must be a valid URL or an absolute path beginning with /.`;
    }
  }
  if (setting.type === 'number' && !Number.isFinite(Number(raw))) return `${label} must be a number.`;
  if (setting.type === 'json') {
    try {
      JSON.parse(raw);
    } catch {
      return `${label} must be valid JSON.`;
    }
  }
  return '';
}

function Field({
  setting,
  value,
  error,
  onChange,
}: {
  setting: PlatformSetting;
  value: string;
  error?: string;
  onChange: (value: string) => void;
}) {
  const type = setting.type || 'text';
  const label = setting.label || setting.key;

  if (setting.sensitive || type === 'secret') {
    return (
      <div className="rounded-lg border border-border-subtle bg-bg-elevated p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <LockIcon className="h-3.5 w-3.5 text-text-tertiary" />
              <span className="text-[13px] font-medium text-text-secondary">{label}</span>
            </div>
            <p className="mt-1 text-[11px] text-text-tertiary">
              Stored in environment variable: <span className="font-mono">{setting.envKey || setting.key}</span>
            </p>
          </div>
          <span
            className={`rounded-full px-2 py-1 text-[11px] font-semibold ${
              setting.envConfigured
                ? 'bg-success/10 text-success'
                : 'bg-warning/10 text-warning'
            }`}
          >
            {setting.envConfigured ? 'Configured' : 'Missing'}
          </span>
        </div>
      </div>
    );
  }

  if (type === 'toggle') {
    const checked = isTruthy(value);
    return (
      <div className="flex items-center justify-between gap-4 rounded-lg border border-border-subtle bg-bg-elevated p-3">
        <div>
          <span className="text-[13px] font-medium text-text-secondary">{label}</span>
          {setting.public && (
            <span className="ml-2 inline-flex items-center gap-1 text-[10px] text-accent">
              <EyeIcon className="h-3 w-3" /> Public
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => onChange(checked ? 'false' : 'true')}
          className={`relative h-6 w-11 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-border-strong'}`}
          aria-label={`Toggle ${label}`}
        >
          <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : ''}`} />
        </button>
      </div>
    );
  }

  const commonClass = `input-field w-full ${error ? 'border-danger ring-1 ring-danger' : ''}`;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <label className="text-[12px] font-medium text-text-secondary">
          {label}
          {setting.required && <span className="text-danger"> *</span>}
        </label>
        {setting.public && (
          <span className="inline-flex items-center gap-1 text-[10px] text-accent">
            <EyeIcon className="h-3 w-3" /> Public
          </span>
        )}
      </div>

      {type === 'select' ? (
        <select className={commonClass} value={value} onChange={(event) => onChange(event.target.value)}>
          {(setting.options || []).map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      ) : type === 'textarea' || type === 'json' ? (
        <textarea
          className={`${commonClass} min-h-[96px] resize-y ${type === 'json' ? 'font-mono' : 'font-sans'}`}
          value={type === 'json' ? prettyJson(value) : value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          className={commonClass}
          type={type === 'number' ? 'number' : type === 'email' ? 'email' : 'text'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}

      {error ? (
        <p className="text-[11px] text-danger">{error}</p>
      ) : setting.description ? (
        <p className="text-[11px] text-text-tertiary">{setting.description}</p>
      ) : null}
    </div>
  );
}

export function Settings() {
  const [settings, setSettings] = useState<PlatformSetting[]>([]);
  const [settingsMap, setSettingsMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [search, setSearch] = useState('');
  const [activeSection, setActiveSection] = useState('All');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetchSettings();
      const map: Record<string, string> = {};
      res.settings.forEach((setting) => {
        map[setting.key] = setting.type === 'json' ? prettyJson(setting.value || setting.defaultValue || '') : String(setting.value ?? setting.defaultValue ?? '');
      });
      setSettings(res.settings);
      setSettingsMap(map);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const validationErrors = useMemo(() => {
    const next: Record<string, string> = {};
    for (const setting of settings) {
      const message = validateSetting(setting, settingsMap[setting.key] ?? '');
      if (message) next[setting.key] = message;
    }
    return next;
  }, [settings, settingsMap]);

  const visibleGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = settings.filter((setting) => {
      const matchesSection = activeSection === 'All' || setting.section === activeSection;
      const matchesSearch = !q ||
        setting.key.toLowerCase().includes(q) ||
        (setting.label || '').toLowerCase().includes(q) ||
        (setting.section || '').toLowerCase().includes(q);
      return matchesSection && matchesSearch;
    });
    return grouped(filtered);
  }, [settings, search, activeSection]);

  const sections = useMemo(() => ['All', ...grouped(settings).map(([section]) => section)], [settings]);

  const showToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(''), 3200);
  };

  const handleSave = async () => {
    if (Object.keys(validationErrors).length > 0) {
      showToast('Fix validation errors before saving.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const payload = settings
        .filter((setting) => !setting.sensitive && setting.type !== 'secret')
        .map((setting) => ({ key: setting.key, value: settingsMap[setting.key] ?? '' }));
      await saveSettings(payload);
      showToast('Settings saved and synced system-wide.');
      await load();
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      showToast(`Error: ${message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Platform Settings</h1>
          <p className="mt-0.5 text-[13px] text-text-tertiary">
            Configure global branding, compliance, monetization, payouts, security, and system defaults.
          </p>
        </div>
        <div className="flex gap-2">
          <ActionButton icon={RefreshCwIcon} onClick={load} variant="secondary" isLoading={loading}>Refresh</ActionButton>
          <ActionButton icon={SaveIcon} onClick={handleSave} isLoading={saving} variant="primary">Save Settings</ActionButton>
        </div>
      </div>

      {toast && (
        <div className="fixed right-5 top-5 z-50 flex items-center gap-2 rounded-lg border border-success/20 bg-success/10 px-4 py-3 text-[13px] font-medium text-success shadow-lg">
          <CheckCircleIcon className="h-4 w-4" />
          {toast}
        </div>
      )}

      {error && (
        <div className="flex items-start gap-3 rounded-lg border border-warning/20 bg-warning/10 p-4 text-[13px] text-warning">
          <AlertTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error.includes('platform_settings') ? 'Run the platform settings Supabase migration, then refresh this page.' : error}</span>
        </div>
      )}

      <div className="card p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="relative w-full lg:max-w-sm">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-tertiary" />
            <input
              className="input-field w-full pl-9"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search settings..."
            />
          </div>
          <div className="flex flex-wrap gap-2">
            {sections.map((section) => (
              <button
                key={section}
                type="button"
                onClick={() => setActiveSection(section)}
                className={`rounded-lg border px-3 py-1.5 text-[12px] font-medium transition ${
                  activeSection === section
                    ? 'border-accent bg-accent text-white'
                    : 'border-border-default bg-bg-elevated text-text-secondary hover:border-accent/50'
                }`}
              >
                {section}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        </div>
      ) : (
        <div className="space-y-4">
          {visibleGroups.map(([section, sectionSettings]) => (
            <div key={section} className="card overflow-hidden">
              <div className="border-b border-border-default bg-bg-base px-5 py-4">
                <h2 className="text-[13px] font-semibold text-text-primary">{section}</h2>
                <p className="mt-0.5 text-[11px] text-text-tertiary">{sectionSettings.length} settings</p>
              </div>
              <div className="grid grid-cols-1 gap-4 p-5 xl:grid-cols-2">
                {sectionSettings.map((setting) => (
                  <Field
                    key={setting.key}
                    setting={setting}
                    value={settingsMap[setting.key] ?? ''}
                    error={validationErrors[setting.key]}
                    onChange={(value) => setSettingsMap((prev) => ({ ...prev, [setting.key]: value }))}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </motion.div>
  );
}
