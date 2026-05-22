import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  ActivityIcon,
  AlertTriangleIcon,
  ArrowDownIcon,
  CheckCircleIcon,
  ClockIcon,
  DatabaseIcon,
  GaugeIcon,
  LineChartIcon,
  RefreshCwIcon,
  SearchIcon,
  ServerIcon,
  ShieldAlertIcon,
  XCircleIcon,
  ZapIcon,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ActionButton } from '../components/shared/ActionButton';
import {
  fetchObservedApiDetail,
  fetchObservabilityOverview,
  triggerObservabilityAggregation,
  type ApiHeatmapPoint,
  type ApiLogEntry,
  type ApiMonitorStatus,
  type ObservabilityOverview,
  type ObservedApi,
  type ObservedApiDetail,
} from '../api/systemApi';

const RANGES = ['1h', '6h', '24h', '7d'] as const;

const statusCopy: Record<ApiMonitorStatus, { label: string; dot: string; badge: string; text: string }> = {
  healthy: {
    label: 'Healthy',
    dot: 'bg-emerald-500',
    badge: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/30',
    text: 'text-emerald-600 dark:text-emerald-300',
  },
  warning: {
    label: 'Warning',
    dot: 'bg-amber-500',
    badge: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/30',
    text: 'text-amber-600 dark:text-amber-300',
  },
  critical: {
    label: 'Critical',
    dot: 'bg-red-500',
    badge: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-300 dark:border-red-500/30',
    text: 'text-red-600 dark:text-red-300',
  },
  offline: {
    label: 'Offline',
    dot: 'bg-slate-500',
    badge: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-700/40 dark:text-slate-200 dark:border-slate-600',
    text: 'text-slate-500 dark:text-slate-300',
  },
};

function formatNumber(value: number) {
  return Intl.NumberFormat('en', { notation: value >= 1000000 ? 'compact' : 'standard' }).format(value || 0);
}

function formatMs(value: number) {
  return `${Math.round(value || 0)}ms`;
}

function formatPercent(value: number) {
  return `${Number(value || 0).toFixed(value >= 99.95 ? 2 : 1)}%`;
}

function formatBytes(value: number) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(value: string | null) {
  if (!value) return 'Never';
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDateTime(value: string | null) {
  if (!value) return 'Never';
  return new Date(value).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function chartTime(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function HealthRing({ value, status }: { value: number; status: ApiMonitorStatus }) {
  const color = status === 'healthy' ? '#10b981' : status === 'warning' ? '#f59e0b' : status === 'critical' ? '#ef4444' : '#64748b';
  return (
    <div
      className="w-24 h-24 rounded-full grid place-items-center"
      style={{ background: `conic-gradient(${color} ${Math.max(0, Math.min(100, value))}%, rgba(148,163,184,.18) 0)` }}
    >
      <div className="w-[4.6rem] h-[4.6rem] rounded-full bg-white dark:bg-dark-card grid place-items-center border border-gray-100 dark:border-slate-800">
        <span className="text-xl font-bold text-gray-900 dark:text-white">{Math.round(value)}</span>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: ApiMonitorStatus }) {
  const copy = statusCopy[status] || statusCopy.offline;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${copy.badge}`}>
      <span className={`h-2 w-2 rounded-full ${copy.dot}`} />
      {copy.label}
    </span>
  );
}

function MetricPanel({ label, value, detail, icon }: { label: string; value: string; detail?: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-dark-border dark:bg-dark-card">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{label}</span>
        <span className="text-gray-400">{icon}</span>
      </div>
      <div className="mt-2 text-2xl font-bold text-gray-900 dark:text-white">{value}</div>
      {detail && <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{detail}</div>}
    </div>
  );
}

function ProgressBar({ value, tone = 'emerald' }: { value: number; tone?: 'emerald' | 'amber' | 'red' | 'blue' }) {
  const color = {
    emerald: 'bg-emerald-500',
    amber: 'bg-amber-500',
    red: 'bg-red-500',
    blue: 'bg-blue-500',
  }[tone];
  return (
    <div className="h-2 w-24 overflow-hidden rounded-full bg-gray-100 dark:bg-slate-800">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

function EmptyPanel({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-dashed border-gray-200 bg-white p-8 text-center text-sm text-gray-500 dark:border-dark-border dark:bg-dark-card dark:text-gray-400">
      {label}
    </div>
  );
}

function ActivityHeatmap({ points }: { points: ApiHeatmapPoint[] }) {
  const byKey = new Map(points.map((point) => [`${point.dayIndex}-${point.hour}`, point]));
  const max = Math.max(1, ...points.map((point) => point.requests));
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const hours = [0, 4, 8, 12, 16, 20];

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-dark-border dark:bg-dark-card">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Request Activity Heatmap</h3>
        <span className="text-xs text-gray-400">by hour</span>
      </div>
      <div className="space-y-1">
        {days.map((day, dayIndex) => (
          <div key={day} className="grid grid-cols-[2.5rem_repeat(6,minmax(0,1fr))] items-center gap-1">
            <span className="text-[11px] text-gray-400">{day}</span>
            {hours.map((hour) => {
              const total = [0, 1, 2, 3].reduce((sum, offset) => sum + (byKey.get(`${dayIndex}-${hour + offset}`)?.requests || 0), 0);
              const intensity = total / max;
              return (
                <div
                  key={`${day}-${hour}`}
                  title={`${day} ${hour}:00 - ${total} requests`}
                  className="h-6 rounded"
                  style={{ backgroundColor: `rgba(37, 99, 235, ${0.08 + intensity * 0.82})` }}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div className="mt-2 grid grid-cols-[2.5rem_repeat(6,minmax(0,1fr))] gap-1 text-[10px] text-gray-400">
        <span />
        {hours.map((hour) => <span key={hour}>{String(hour).padStart(2, '0')}</span>)}
      </div>
    </div>
  );
}

function ApiTable({
  apis,
  selectedRouteKey,
  onSelect,
}: {
  apis: ObservedApi[];
  selectedRouteKey: string | null;
  onSelect: (api: ObservedApi) => void;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-dark-border dark:bg-dark-card">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1040px] text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50 text-left text-[11px] uppercase tracking-wide text-gray-500 dark:border-slate-800 dark:bg-slate-900/60">
              <th className="px-4 py-3">API name</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Uptime %</th>
              <th className="px-4 py-3">Latency</th>
              <th className="px-4 py-3">Avg response time</th>
              <th className="px-4 py-3">Total requests</th>
              <th className="px-4 py-3">Reads</th>
              <th className="px-4 py-3">Writes</th>
              <th className="px-4 py-3">Failed requests</th>
              <th className="px-4 py-3">Last checked</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
            {apis.map((api) => {
              const selected = api.routeKey === selectedRouteKey;
              const latencyTone = api.avgResponseTimeMs >= 1200 ? 'red' : api.avgResponseTimeMs >= 600 ? 'amber' : 'emerald';
              return (
                <tr
                  key={api.routeKey}
                  onClick={() => onSelect(api)}
                  className={`cursor-pointer transition-colors hover:bg-gray-50 dark:hover:bg-slate-900/50 ${selected ? 'bg-blue-50/70 dark:bg-blue-500/10' : ''}`}
                >
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900 dark:text-white">{api.apiName}</div>
                    <div className="mt-0.5 font-mono text-[11px] text-gray-400">{api.routeGroup}</div>
                  </td>
                  <td className="px-4 py-3"><StatusBadge status={api.status} /></td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="w-12 tabular-nums text-gray-700 dark:text-gray-200">{formatPercent(api.uptimePct)}</span>
                      <ProgressBar value={api.uptimePct} tone={api.uptimePct >= 99 ? 'emerald' : api.uptimePct >= 95 ? 'amber' : 'red'} />
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="w-14 tabular-nums font-semibold text-gray-900 dark:text-white">{formatMs(api.latencyMs)}</span>
                      <ProgressBar value={Math.min(100, (api.latencyMs / 2000) * 100)} tone={latencyTone} />
                    </div>
                  </td>
                  <td className="px-4 py-3 tabular-nums text-gray-700 dark:text-gray-200">{formatMs(api.avgResponseTimeMs)}</td>
                  <td className="px-4 py-3 tabular-nums text-gray-700 dark:text-gray-200">{formatNumber(api.totalRequests)}</td>
                  <td className="px-4 py-3 tabular-nums text-gray-700 dark:text-gray-200">{formatNumber(api.reads)}</td>
                  <td className="px-4 py-3 tabular-nums text-gray-700 dark:text-gray-200">{formatNumber(api.writes)}</td>
                  <td className={`px-4 py-3 tabular-nums font-medium ${api.failedRequests ? 'text-red-600 dark:text-red-300' : 'text-gray-500'}`}>
                    {formatNumber(api.failedRequests)}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">{formatTime(api.lastCheckedAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {apis.length === 0 && <div className="p-8 text-center text-sm text-gray-500">No API traffic has been captured yet.</div>}
    </div>
  );
}

function LogsTable({ logs }: { logs: ApiLogEntry[] }) {
  if (!logs.length) return <EmptyPanel label="No request logs for this API in the selected range." />;

  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-dark-border dark:bg-dark-card">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50 text-left text-[11px] uppercase tracking-wide text-gray-500 dark:border-slate-800 dark:bg-slate-900/60">
              <th className="px-4 py-3">Time</th>
              <th className="px-4 py-3">Method</th>
              <th className="px-4 py-3">Endpoint</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Latency</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Size</th>
              <th className="px-4 py-3">IP hash</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
            {logs.map((log) => (
              <tr key={log.requestId}>
                <td className="px-4 py-3 text-xs text-gray-500">{formatDateTime(log.timestamp)}</td>
                <td className="px-4 py-3 font-mono text-xs text-gray-700 dark:text-gray-200">{log.method}</td>
                <td className="px-4 py-3 font-mono text-xs text-gray-700 dark:text-gray-200">{log.endpoint}</td>
                <td className={`px-4 py-3 font-semibold ${log.statusCode >= 400 ? 'text-red-600 dark:text-red-300' : 'text-emerald-600 dark:text-emerald-300'}`}>
                  {log.statusCode}
                </td>
                <td className="px-4 py-3 tabular-nums">{formatMs(log.latencyMs)}</td>
                <td className="px-4 py-3 capitalize text-gray-600 dark:text-gray-300">{log.operationType}</td>
                <td className="px-4 py-3 text-xs text-gray-500">{formatBytes(log.responseBytes)}</td>
                <td className="px-4 py-3 font-mono text-[11px] text-gray-400">{log.ipHash}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DetailCharts({ detail }: { detail: ObservedApiDetail }) {
  const series = detail.series;
  if (!detail.api) return null;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-dark-border dark:bg-dark-card xl:col-span-2">
          <h3 className="mb-3 text-sm font-semibold text-gray-900 dark:text-white">Latency Graph</h3>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={series}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="timestamp" tickFormatter={chartTime} tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} width={44} />
                <Tooltip labelFormatter={(value) => formatDateTime(String(value))} formatter={(value) => [`${value}ms`, '']} />
                <Line type="monotone" dataKey="avgLatencyMs" name="Avg latency" stroke="#2563eb" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="p95LatencyMs" name="P95 latency" stroke="#f59e0b" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-dark-border dark:bg-dark-card">
          <h3 className="mb-3 text-sm font-semibold text-gray-900 dark:text-white">Health Score</h3>
          <div className="flex items-center justify-center py-4">
            <HealthRing value={detail.api.healthScore} status={detail.api.status} />
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <div className="text-xs text-gray-500">Uptime</div>
              <div className="font-semibold text-gray-900 dark:text-white">{formatPercent(detail.api.uptimePct)}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500">Error rate</div>
              <div className="font-semibold text-gray-900 dark:text-white">{formatPercent(detail.api.errorRatePct)}</div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-dark-border dark:bg-dark-card">
          <h3 className="mb-3 text-sm font-semibold text-gray-900 dark:text-white">Request Volume</h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={series}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="timestamp" tickFormatter={chartTime} tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} width={44} />
                <Tooltip labelFormatter={(value) => formatDateTime(String(value))} />
                <Area type="monotone" dataKey="requests" name="Requests" stroke="#2563eb" fill="#93c5fd" fillOpacity={0.35} />
                <Area type="monotone" dataKey="failures" name="Failures" stroke="#ef4444" fill="#fecaca" fillOpacity={0.45} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-dark-border dark:bg-dark-card">
          <h3 className="mb-3 text-sm font-semibold text-gray-900 dark:text-white">Read / Write Operations</h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={series}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="timestamp" tickFormatter={chartTime} tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} width={44} />
                <Tooltip labelFormatter={(value) => formatDateTime(String(value))} />
                <Bar dataKey="reads" name="Reads" fill="#10b981" radius={[4, 4, 0, 0]} />
                <Bar dataKey="writes" name="Writes" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-dark-border dark:bg-dark-card">
          <h3 className="mb-3 text-sm font-semibold text-gray-900 dark:text-white">Response Time Distribution</h3>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={detail.responseDistribution}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 11 }} width={36} />
                <Tooltip />
                <Bar dataKey="count" name="Requests" fill="#0ea5e9" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-dark-border dark:bg-dark-card">
          <h3 className="mb-3 text-sm font-semibold text-gray-900 dark:text-white">Success Rate</h3>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={series}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="timestamp" tickFormatter={chartTime} tick={{ fontSize: 11 }} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} width={36} />
                <Tooltip formatter={(value) => [`${Number(value).toFixed(1)}%`, 'Success']} labelFormatter={(value) => formatDateTime(String(value))} />
                <Line type="monotone" dataKey="successRatePct" stroke="#10b981" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
        <ActivityHeatmap points={detail.activityHeatmap} />
      </div>
    </div>
  );
}

export function ITOperations() {
  const [overview, setOverview] = useState<ObservabilityOverview | null>(null);
  const [detail, setDetail] = useState<ObservedApiDetail | null>(null);
  const [selectedRouteKey, setSelectedRouteKey] = useState<string | null>(null);
  const [range, setRange] = useState<(typeof RANGES)[number]>('24h');
  const [query, setQuery] = useState('');
  const [logPage, setLogPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [workflowLoading, setWorkflowLoading] = useState(false);
  const [error, setError] = useState('');

  const loadOverview = useCallback(async () => {
    try {
      const data = await fetchObservabilityOverview(range);
      setOverview(data);
      setError('');
      setSelectedRouteKey((current) => current || data.apis[0]?.routeKey || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load API monitoring data.');
    } finally {
      setLoading(false);
    }
  }, [range]);

  const loadDetail = useCallback(async () => {
    if (!selectedRouteKey) return;
    setDetailLoading(true);
    try {
      const data = await fetchObservedApiDetail(selectedRouteKey, range, logPage, 25);
      setDetail(data);
    } catch {
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, [selectedRouteKey, range, logPage]);

  useEffect(() => {
    setLoading(true);
    loadOverview();
    const timer = window.setInterval(loadOverview, 10000);
    return () => window.clearInterval(timer);
  }, [loadOverview]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  useEffect(() => {
    setLogPage(1);
  }, [selectedRouteKey, range]);

  const filteredApis = useMemo(() => {
    const text = query.trim().toLowerCase();
    const rows = overview?.apis || [];
    if (!text) return rows;
    return rows.filter((api) => `${api.apiName} ${api.routeKey} ${api.routeGroup}`.toLowerCase().includes(text));
  }, [overview?.apis, query]);

  const selectedApi = useMemo(() => {
    return overview?.apis.find((api) => api.routeKey === selectedRouteKey) || detail?.api || null;
  }, [overview?.apis, selectedRouteKey, detail?.api]);

  const peakTimes = useMemo(() => {
    const rows = detail?.activityHeatmap || [];
    return [...rows].sort((a, b) => b.requests - a.requests).slice(0, 4);
  }, [detail?.activityHeatmap]);

  async function handleRefresh() {
    setLoading(true);
    await loadOverview();
    await loadDetail();
  }

  async function handleRunWorkflow() {
    setWorkflowLoading(true);
    try {
      await triggerObservabilityAggregation();
      await handleRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Aggregation workflow failed.');
    } finally {
      setWorkflowLoading(false);
    }
  }

  const summary = overview?.summary;
  const heapPct = overview?.systemLoad?.memory.heapTotal
    ? (overview.systemLoad.memory.heapUsed / overview.systemLoad.memory.heapTotal) * 100
    : 0;

  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-lg bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-300">
            <LineChartIcon className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">API Observability</h1>
            <p className="text-xs text-gray-500">
              {overview ? `Updated ${formatTime(overview.timestamp)} from ${overview.source}` : 'Loading live metrics'}
            </p>
          </div>
          {summary && <StatusBadge status={summary.status} />}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-md border border-gray-200 bg-white p-0.5 dark:border-dark-border dark:bg-dark-card">
            {RANGES.map((item) => (
              <button
                key={item}
                onClick={() => setRange(item)}
                className={`rounded px-3 py-1.5 text-xs font-semibold ${range === item ? 'bg-gray-900 text-white dark:bg-white dark:text-gray-900' : 'text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white'}`}
              >
                {item}
              </button>
            ))}
          </div>
          <ActionButton
            label="Run workflow"
            icon={<ZapIcon className="h-4 w-4" />}
            variant="secondary"
            isLoading={workflowLoading}
            onClick={handleRunWorkflow}
          />
          <ActionButton
            label="Refresh"
            icon={<RefreshCwIcon className="h-4 w-4" />}
            variant="secondary"
            isLoading={loading}
            onClick={handleRefresh}
          />
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          <AlertTriangleIcon className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricPanel label="Health score" value={summary ? `${Math.round(summary.healthScore)}/100` : '--'} detail={summary ? statusCopy[summary.status].label : 'Waiting'} icon={<GaugeIcon className="h-4 w-4" />} />
        <MetricPanel label="Uptime" value={summary ? formatPercent(summary.uptimePct) : '--'} detail={`${formatNumber(summary?.failedRequests || 0)} failed requests`} icon={<CheckCircleIcon className="h-4 w-4" />} />
        <MetricPanel label="Avg response" value={summary ? formatMs(summary.avgResponseTimeMs) : '--'} detail={`${formatPercent(summary?.errorRatePct || 0)} error rate`} icon={<ClockIcon className="h-4 w-4" />} />
        <MetricPanel label="Request volume" value={summary ? formatNumber(summary.totalRequests) : '--'} detail={`${formatNumber(summary?.reads || 0)} reads / ${formatNumber(summary?.writes || 0)} writes`} icon={<ActivityIcon className="h-4 w-4" />} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-dark-border dark:bg-dark-card">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Heap usage</span>
            <DatabaseIcon className="h-4 w-4 text-gray-400" />
          </div>
          <div className="flex items-center gap-3">
            <ProgressBar value={heapPct} tone={heapPct >= 85 ? 'red' : heapPct >= 70 ? 'amber' : 'blue'} />
            <span className="text-sm font-semibold text-gray-900 dark:text-white">{heapPct.toFixed(1)}%</span>
          </div>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-dark-border dark:bg-dark-card">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">RSS memory</span>
            <ServerIcon className="h-4 w-4 text-gray-400" />
          </div>
          <div className="text-sm font-semibold text-gray-900 dark:text-white">{formatBytes(overview?.systemLoad.memory.rss || 0)}</div>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-dark-border dark:bg-dark-card">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Process uptime</span>
            <ClockIcon className="h-4 w-4 text-gray-400" />
          </div>
          <div className="text-sm font-semibold text-gray-900 dark:text-white">{Math.floor((overview?.systemLoad.uptimeSeconds || 0) / 3600)}h {Math.floor(((overview?.systemLoad.uptimeSeconds || 0) % 3600) / 60)}m</div>
        </div>
      </div>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Observed APIs</h2>
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search APIs"
              className="h-9 w-72 rounded-md border border-gray-200 bg-white pl-9 pr-3 text-sm text-gray-900 outline-none focus:border-blue-500 dark:border-dark-border dark:bg-dark-card dark:text-white"
            />
          </div>
        </div>
        {loading && !overview ? (
          <EmptyPanel label="Loading observability data." />
        ) : (
          <ApiTable apis={filteredApis} selectedRouteKey={selectedRouteKey} onSelect={(api) => setSelectedRouteKey(api.routeKey)} />
        )}
      </section>

      {selectedApi && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{selectedApi.apiName}</h2>
                <StatusBadge status={selectedApi.status} />
              </div>
              <div className="mt-1 font-mono text-xs text-gray-400">{selectedApi.routeKey}</div>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="rounded-md border border-gray-200 px-3 py-2 text-xs dark:border-dark-border">
                <div className="text-gray-500">P95</div>
                <div className="font-semibold text-gray-900 dark:text-white">{formatMs(selectedApi.p95LatencyMs)}</div>
              </div>
              <div className="rounded-md border border-gray-200 px-3 py-2 text-xs dark:border-dark-border">
                <div className="text-gray-500">P99</div>
                <div className="font-semibold text-gray-900 dark:text-white">{formatMs(selectedApi.p99LatencyMs)}</div>
              </div>
              <div className="rounded-md border border-gray-200 px-3 py-2 text-xs dark:border-dark-border">
                <div className="text-gray-500">Max</div>
                <div className="font-semibold text-gray-900 dark:text-white">{formatMs(selectedApi.maxLatencyMs)}</div>
              </div>
              <div className="rounded-md border border-gray-200 px-3 py-2 text-xs dark:border-dark-border">
                <div className="text-gray-500">Status code</div>
                <div className="font-semibold text-gray-900 dark:text-white">{selectedApi.lastStatusCode || '--'}</div>
              </div>
            </div>
          </div>

          {detailLoading && !detail ? <EmptyPanel label="Loading detailed API analytics." /> : detail ? <DetailCharts detail={detail} /> : null}

          {detail && (
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
              <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-dark-border dark:bg-dark-card">
                <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
                  <ArrowDownIcon className="h-4 w-4 text-blue-500" /> Peak Usage Times
                </h3>
                <div className="space-y-2">
                  {peakTimes.map((point) => (
                    <div key={`${point.day}-${point.hour}`} className="flex items-center justify-between text-sm">
                      <span className="text-gray-600 dark:text-gray-300">{point.day} {String(point.hour).padStart(2, '0')}:00</span>
                      <span className="font-semibold text-gray-900 dark:text-white">{formatNumber(point.requests)}</span>
                    </div>
                  ))}
                  {peakTimes.length === 0 && <span className="text-sm text-gray-500">No traffic yet.</span>}
                </div>
              </div>
              <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-dark-border dark:bg-dark-card">
                <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
                  <ShieldAlertIcon className="h-4 w-4 text-red-500" /> Recent Failures
                </h3>
                <div className="space-y-2">
                  {detail.recentFailures.slice(0, 5).map((failure) => (
                    <div key={failure.requestId} className="flex items-center justify-between gap-3 text-sm">
                      <span className="truncate font-mono text-xs text-gray-600 dark:text-gray-300">{failure.endpoint}</span>
                      <span className="font-semibold text-red-600 dark:text-red-300">{failure.statusCode}</span>
                    </div>
                  ))}
                  {detail.recentFailures.length === 0 && <span className="text-sm text-gray-500">No failures in range.</span>}
                </div>
              </div>
              <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-dark-border dark:bg-dark-card">
                <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
                  <AlertTriangleIcon className="h-4 w-4 text-amber-500" /> Incident Timeline
                </h3>
                <div className="space-y-2">
                  {detail.incidents.slice(0, 5).map((incident) => (
                    <div key={incident.id} className="text-sm">
                      <div className="flex items-center justify-between">
                        <span className="font-medium capitalize text-gray-900 dark:text-white">{incident.severity}</span>
                        <span className="text-xs text-gray-400">{formatDateTime(incident.started_at)}</span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-gray-500">{incident.reason}</p>
                    </div>
                  ))}
                  {detail.incidents.length === 0 && <span className="text-sm text-gray-500">No incidents recorded.</span>}
                </div>
              </div>
            </div>
          )}

          {detail && (
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <div>
                <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
                  <XCircleIcon className="h-4 w-4 text-red-500" /> Slowest Endpoints
                </h3>
                <LogsTable logs={detail.slowestEndpoints.slice(0, 8)} />
              </div>
              <div>
                <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
                  <ActivityIcon className="h-4 w-4 text-blue-500" /> API Activity Timeline
                </h3>
                <LogsTable logs={detail.requestLogs.logs} />
                <div className="mt-3 flex items-center justify-between text-xs text-gray-500">
                  <span>Page {detail.requestLogs.page} of {detail.requestLogs.totalPages}</span>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setLogPage((page) => Math.max(1, page - 1))}
                      disabled={logPage <= 1}
                      className="rounded border border-gray-200 px-3 py-1 disabled:opacity-40 dark:border-dark-border"
                    >
                      Previous
                    </button>
                    <button
                      onClick={() => setLogPage((page) => Math.min(detail.requestLogs.totalPages, page + 1))}
                      disabled={logPage >= detail.requestLogs.totalPages}
                      className="rounded border border-gray-200 px-3 py-1 disabled:opacity-40 dark:border-dark-border"
                    >
                      Next
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>
      )}
    </motion.div>
  );
}
