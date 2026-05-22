import React, { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { LockIcon, RefreshCwIcon, ServerIcon } from 'lucide-react';
import { ActionButton } from '../components/shared/ActionButton';
import { fetchEnvOverview, type EnvVar } from '../api/systemApi';

function EnvRow({ envVar }: { envVar: EnvVar }) {
  const value = String(envVar.value || '');
  const isOk = value === 'Configured' || value === 'Set (hidden)' || value === 'production' || value === 'non-production' || value === 'Default';
  const isMissing = value === 'Missing';
  const valueColor = isOk ? 'text-green-600 dark:text-green-400'
    : isMissing ? 'text-red-500 dark:text-red-400'
      : 'text-gray-800 dark:text-gray-200';

  return (
    <div className="flex items-center justify-between gap-4 rounded-lg px-4 py-3 transition-colors hover:bg-gray-50 dark:hover:bg-slate-800/50">
      <div className="flex min-w-0 items-center gap-2">
        {envVar.sensitive && <LockIcon className="h-3.5 w-3.5 flex-shrink-0 text-gray-400" />}
        <span className="truncate font-mono text-sm font-medium text-gray-700 dark:text-gray-300">{envVar.key}</span>
      </div>
      <span className={`ml-4 max-w-[240px] truncate font-mono text-sm ${valueColor}`}>{value}</span>
    </div>
  );
}

export function EnvSettings() {
  const [envVars, setEnvVars] = useState<EnvVar[]>([]);
  const [nodeVersion, setNodeVersion] = useState('');
  const [platform, setPlatform] = useState('');
  const [uptime, setUptime] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetchEnvOverview();
      setEnvVars(res.env);
      setNodeVersion(res.nodeVersion);
      setPlatform(res.platform);
      setUptime(res.uptime);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const formatUptime = (secs: number) => {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return `${h}h ${m}m`;
  };

  const missing = envVars.filter((item) => item.value === 'Missing').length;

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="mx-auto max-w-4xl space-y-8 p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Environment Settings</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Read-only server configuration status. Secret values are never displayed.</p>
        </div>
        <ActionButton label="Refresh" icon={<RefreshCwIcon className="h-4 w-4" />} onClick={load} variant="secondary" />
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-400">{error}</div>}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-dark-border dark:bg-dark-card">
          <p className="mb-1 text-xs text-gray-500">Node.js</p>
          <p className="font-mono font-semibold text-gray-900 dark:text-white">{nodeVersion || '-'}</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-dark-border dark:bg-dark-card">
          <p className="mb-1 text-xs text-gray-500">Platform</p>
          <p className="font-mono font-semibold capitalize text-gray-900 dark:text-white">{platform || '-'}</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-dark-border dark:bg-dark-card">
          <p className="mb-1 text-xs text-gray-500">Uptime</p>
          <p className="font-mono font-semibold text-gray-900 dark:text-white">{uptime ? formatUptime(uptime) : '-'}</p>
        </div>
      </div>

      {missing > 0 && (
        <div className="w-max rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-900/20">
          <span className="font-medium">{missing}</span> missing variable{missing > 1 ? 's' : ''}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-primary border-t-transparent" />
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-dark-border dark:bg-dark-card">
          <div className="flex items-center gap-2 border-b border-gray-200 p-4 dark:border-dark-border">
            <ServerIcon className="h-4 w-4 text-gray-500" />
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">Environment Variables</h2>
            <span className="ml-auto text-xs text-gray-500">{envVars.length} variables</span>
          </div>
          <div className="divide-y divide-gray-100 px-2 py-1 dark:divide-dark-border/50">
            {envVars.map((ev) => <EnvRow key={ev.key} envVar={ev} />)}
          </div>
        </div>
      )}

      <p className="text-center text-xs text-gray-400">
        Sensitive values are hidden at the API level. Set secrets only in your server environment.
      </p>
    </motion.div>
  );
}
