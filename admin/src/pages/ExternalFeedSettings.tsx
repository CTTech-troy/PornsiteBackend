import React, { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { RefreshCwIcon, SaveIcon, ZapIcon, GlobeIcon } from 'lucide-react';
import { ActionButton } from '../components/shared/ActionButton';
import {
  fetchExternalFeedConfig,
  saveExternalFeedConfig,
  testExternalFeed,
  type ExternalFeedConfig,
  type PeriodMode,
} from '../api/externalFeedApi';

const PERIOD_MODES: { value: PeriodMode; label: string }[] = [
  { value: 'current_month', label: 'Current month (auto)' },
  { value: 'fixed', label: 'Fixed (YYYY-MM)' },
  { value: 'none', label: 'No period param' },
];

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <div className="flex items-center justify-between p-3 bg-bg-elevated rounded-lg border border-border-subtle">
      <span className="text-[13px] font-medium text-text-secondary">{label}</span>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`relative w-10 h-5 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-border-strong'}`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : ''}`}
        />
      </button>
    </div>
  );
}

export function ExternalFeedSettings() {
  const [config, setConfig] = useState<ExternalFeedConfig | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testPage, setTestPage] = useState(1);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [testResult, setTestResult] = useState('');

  const provider = config?.providers?.[config.activeProvider || 'xnxx-api'];

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const c = await fetchExternalFeedConfig();
      setConfig(c);
      setApiKeyInput('');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3500);
  };

  const patchProvider = (patch: Partial<NonNullable<typeof provider>>) => {
    if (!config) return;
    const id = config.activeProvider || 'xnxx-api';
    setConfig({
      ...config,
      providers: {
        ...config.providers,
        [id]: { ...config.providers[id], ...patch },
      },
    });
  };

  const handleSave = async () => {
    if (!config || !provider) return;
    setSaving(true);
    try {
      const payload: ExternalFeedConfig = {
        ...config,
        providers: {
          ...config.providers,
          [config.activeProvider]: {
            ...provider,
            apiKey: apiKeyInput.trim(),
          },
        },
      };
      const saved = await saveExternalFeedConfig(payload);
      setConfig(saved);
      setApiKeyInput('');
      showToast('External feed settings saved.');
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult('');
    try {
      const res = await testExternalFeed(testPage);
      setTestResult(res.message || (res.success ? 'OK' : 'Failed'));
    } catch (e: unknown) {
      setTestResult(e instanceof Error ? e.message : 'Test failed');
    } finally {
      setTesting(false);
    }
  };

  const currentPeriod =
    config?.resolvedPeriod ??
    (provider?.periodMode === 'fixed' ? provider.fixedPeriod : `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`);

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="max-w-3xl mx-auto space-y-5">
      <motion.div layout className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text-primary flex items-center gap-2">
            <GlobeIcon className="w-5 h-5 text-accent" />
            External Home Feed
          </h1>
          <p className="text-[13px] text-text-tertiary mt-0.5">
            Configure RapidAPI sources for the public home feed (pagination + period).
          </p>
        </div>
        <div className="flex gap-2">
          <ActionButton icon={RefreshCwIcon} onClick={load} variant="secondary">
            Refresh
          </ActionButton>
          <ActionButton icon={SaveIcon} onClick={handleSave} isLoading={saving} variant="primary">
            Save
          </ActionButton>
        </div>
      </motion.div>

      {toast && (
        <div className="text-[13px] px-4 py-2 rounded-lg bg-accent/10 border border-accent/20 text-accent">{toast}</div>
      )}
      {error && (
        <div className="text-[13px] px-4 py-3 rounded-lg bg-warning/10 border border-warning/20 text-warning">{error}</div>
      )}

      {loading || !config || !provider ? (
        <div className="flex justify-center py-20">
          <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="card p-5 space-y-3">
            <h2 className="text-[13px] font-semibold text-text-primary">Feed behavior</h2>
            <Toggle
              label="Enable external API feed"
              checked={config.enabled}
              onChange={(enabled) => setConfig({ ...config, enabled })}
            />
            <Toggle
              label="Mix creator videos first"
              checked={config.mixCreatorsFirst}
              onChange={(mixCreatorsFirst) => setConfig({ ...config, mixCreatorsFirst })}
            />
            <div>
              <label className="block text-[12px] font-medium text-text-secondary mb-1.5">
                Pages per home-feed request (1–5)
              </label>
              <input
                type="number"
                min={1}
                max={5}
                value={config.pagesPerRequest}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    pagesPerRequest: Math.min(5, Math.max(1, parseInt(e.target.value, 10) || 1)),
                  })
                }
                className="input-field w-full max-w-[120px]"
              />
            </div>
          </div>

          <div className="card p-5 space-y-4">
            <h2 className="text-[13px] font-semibold text-text-primary">XNXX RapidAPI provider</h2>
            <motion.div layout>
              <label className="block text-[12px] font-medium text-text-secondary mb-1.5">Active provider</label>
              <select
                value={config.activeProvider}
                onChange={(e) => setConfig({ ...config, activeProvider: e.target.value })}
                className="input-field w-full"
              >
                {Object.entries(config.providers).map(([id, p]) => (
                  <option key={id} value={id}>
                    {p.label || id}
                  </option>
                ))}
              </select>
            </motion.div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-[12px] font-medium text-text-secondary mb-1.5">API host</label>
                <input
                  type="text"
                  value={provider.host}
                  onChange={(e) => patchProvider({ host: e.target.value })}
                  className="input-field w-full font-mono text-[12px]"
                  placeholder="xnxx-api.p.rapidapi.com"
                />
              </div>
              <div>
                <label className="block text-[12px] font-medium text-text-secondary mb-1.5">Best path</label>
                <input
                  type="text"
                  value={provider.bestPath}
                  onChange={(e) => patchProvider({ bestPath: e.target.value })}
                  className="input-field w-full font-mono text-[12px]"
                  placeholder="/xn/best"
                />
              </div>
            </div>
            <div>
              <label className="block text-[12px] font-medium text-text-secondary mb-1.5">
                X-RapidAPI-Key
                {provider.hasApiKey && !apiKeyInput && (
                  <span className="ml-2 text-text-tertiary font-normal">(saved — enter new key to replace)</span>
                )}
              </label>
              <input
                type="password"
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                className="input-field w-full font-mono text-[12px]"
                placeholder={provider.hasApiKey ? '••••••••••••' : 'Paste RapidAPI key'}
                autoComplete="off"
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-[12px] font-medium text-text-secondary mb-1.5">Period mode</label>
                <select
                  value={provider.periodMode}
                  onChange={(e) => patchProvider({ periodMode: e.target.value as PeriodMode })}
                  className="input-field w-full"
                >
                  {PERIOD_MODES.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
              {provider.periodMode === 'fixed' && (
                <div>
                  <label className="block text-[12px] font-medium text-text-secondary mb-1.5">Fixed period</label>
                  <input
                    type="text"
                    value={provider.fixedPeriod}
                    onChange={(e) => patchProvider({ fixedPeriod: e.target.value })}
                    className="input-field w-full font-mono text-[12px]"
                    placeholder="2025-12"
                  />
                </div>
              )}
            </div>
            <p className="text-[12px] text-text-tertiary">
              Resolved period: <span className="font-mono text-text-secondary">{provider.periodMode === 'none' ? 'none' : currentPeriod}</span>
            </p>
            <p className="text-[11px] text-text-tertiary leading-relaxed">
              Example: <span className="font-mono">GET /xn/best?page=2&amp;period=2025-12</span>. Home feed pagination uses{' '}
              <span className="font-mono">?page=</span> on <span className="font-mono">/api/videos/home-feed</span>.
            </p>
          </div>

          <div className="card p-5 space-y-3">
            <h2 className="text-[13px] font-semibold text-text-primary">Test connection</h2>
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="block text-[12px] font-medium text-text-secondary mb-1.5">Test page</label>
                <input
                  type="number"
                  min={1}
                  value={testPage}
                  onChange={(e) => setTestPage(Math.max(1, parseInt(e.target.value, 10) || 1))}
                  className="input-field w-24"
                />
              </div>
              <ActionButton icon={ZapIcon} onClick={handleTest} isLoading={testing} variant="secondary">
                Run test fetch
              </ActionButton>
            </div>
            {testResult && <p className="text-[13px] text-text-secondary">{testResult}</p>}
          </div>
        </div>
      )}
    </motion.div>
  );
}
