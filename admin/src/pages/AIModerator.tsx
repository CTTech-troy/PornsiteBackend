import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ActivityIcon,
  AlertTriangleIcon,
  BotIcon,
  BrainCircuitIcon,
  CheckCircleIcon,
  CpuIcon,
  DatabaseIcon,
  GaugeIcon,
  GraduationCapIcon,
  LineChartIcon,
  RefreshCwIcon,
  SearchIcon,
  ShieldAlertIcon,
  SirenIcon,
  SlidersHorizontalIcon,
  WalletCardsIcon,
  WifiIcon,
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
import { StatusBadge, type StatusColor } from '../components/shared/StatusBadge';
import {
  fetchAiAnalytics,
  fetchAiFraud,
  fetchAiIncidents,
  fetchAiInfrastructure,
  fetchAiLiveMonitoring,
  fetchAiOverview,
  fetchAiTraining,
  reviewAiAlert,
  subscribeAiModerationSocket,
  triggerAiRetraining,
  type AiAlert,
  type AiAnalytics,
  type AiFraudPayload,
  type AiOverview,
  type AiRule,
  type AiSession,
  type AiTrainingLog,
  type AiWorkerHealth,
  type ModerationEvent,
} from '../api/moderationApi';
import { useToast } from '../contexts/ToastContext';

const tabs = [
  { key: 'overview', label: 'AI Overview', icon: BotIcon },
  { key: 'live', label: 'Live Monitoring', icon: WifiIcon },
  { key: 'incidents', label: 'Moderation Incidents', icon: SirenIcon },
  { key: 'analytics', label: 'AI Analytics', icon: LineChartIcon },
  { key: 'fraud', label: 'Fraud Detection', icon: WalletCardsIcon },
  { key: 'training', label: 'AI Training Center', icon: GraduationCapIcon },
  { key: 'infra', label: 'AI Infrastructure', icon: CpuIcon },
] as const;

type TabKey = typeof tabs[number]['key'];

const severityColors: Record<string, StatusColor> = {
  info: 'gray',
  low: 'yellow',
  medium: 'yellow',
  high: 'red',
  critical: 'red',
};

const statusColors: Record<string, StatusColor> = {
  active: 'green',
  healthy: 'green',
  open: 'red',
  reviewing: 'yellow',
  acknowledged: 'blue',
  resolved: 'green',
  dismissed: 'gray',
  degraded: 'yellow',
  offline: 'red',
  unknown: 'gray',
};

function fmtNumber(value: number) {
  return Intl.NumberFormat('en', { notation: value >= 100000 ? 'compact' : 'standard' }).format(value || 0);
}

function fmtDate(value?: string | null) {
  return value ? new Date(value).toLocaleString() : '-';
}

function riskTone(score: number) {
  if (score >= 85) return 'text-red-500';
  if (score >= 65) return 'text-orange-500';
  if (score >= 45) return 'text-amber-500';
  return 'text-emerald-500';
}

function MetricCard({ label, value, detail, icon }: { label: string; value: string | number; detail?: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-dark-border dark:bg-dark-card">
      <div className="flex items-start justify-between gap-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{label}</span>
        <span className="text-gray-400">{icon}</span>
      </div>
      <div className="mt-2 text-2xl font-bold text-gray-900 dark:text-white">{value}</div>
      {detail ? <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{detail}</div> : null}
    </div>
  );
}

function RiskBar({ score }: { score: number }) {
  const color = score >= 85 ? 'bg-red-500' : score >= 65 ? 'bg-orange-500' : score >= 45 ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-24 overflow-hidden rounded-full bg-gray-100 dark:bg-slate-800">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.max(0, Math.min(100, score))}%` }} />
      </div>
      <span className={`text-xs font-semibold ${riskTone(score)}`}>{Math.round(score)}</span>
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-dashed border-gray-200 bg-white p-8 text-center text-sm text-gray-500 dark:border-dark-border dark:bg-dark-card dark:text-gray-400">
      {label}
    </div>
  );
}

function SessionTable({ sessions }: { sessions: AiSession[] }) {
  if (!sessions.length) return <Empty label="No active AI-monitored sessions." />;
  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-dark-border dark:bg-dark-card">
      <table className="w-full min-w-[860px] text-left text-sm">
        <thead className="bg-gray-50 text-xs uppercase text-gray-500 dark:bg-slate-900/60 dark:text-gray-400">
          <tr>
            <th className="px-4 py-3">Session</th>
            <th className="px-4 py-3">Type</th>
            <th className="px-4 py-3">Risk</th>
            <th className="px-4 py-3">Events</th>
            <th className="px-4 py-3">Hidden AI</th>
            <th className="px-4 py-3">Started</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
          {sessions.map((session) => (
            <tr key={session.session_id} className="hover:bg-gray-50 dark:hover:bg-slate-900/40">
              <td className="px-4 py-3">
                <Link className="font-medium text-gray-900 hover:text-blue-600 dark:text-white" to={`/ai-moderator/sessions/${encodeURIComponent(session.session_id)}`}>
                  {session.title || session.session_id}
                </Link>
                <div className="font-mono text-xs text-gray-400">{session.session_id}</div>
              </td>
              <td className="px-4 py-3 capitalize">{session.session_type}</td>
              <td className="px-4 py-3"><RiskBar score={Number(session.max_risk_score || session.risk_score || 0)} /></td>
              <td className="px-4 py-3">{fmtNumber(session.event_count || 0)} events</td>
              <td className="px-4 py-3">
                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
                  <CheckCircleIcon className="h-3 w-3" /> system_ai
                </span>
              </td>
              <td className="px-4 py-3 text-gray-500">{fmtDate(session.started_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AlertList({ alerts, onReview }: { alerts: AiAlert[]; onReview: (alert: AiAlert, status: string) => void }) {
  if (!alerts.length) return <Empty label="No AI moderation incidents in this view." />;
  return (
    <div className="space-y-3">
      {alerts.map((alert) => (
        <div key={alert.id} className="rounded-lg border border-gray-200 bg-white p-4 dark:border-dark-border dark:bg-dark-card">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={alert.severity} color={severityColors[alert.severity] || 'gray'} />
                <StatusBadge status={alert.status} color={statusColors[alert.status] || 'gray'} />
                <span className={`text-sm font-semibold ${riskTone(alert.risk_score)}`}>Risk {Math.round(alert.risk_score)}</span>
              </div>
              <h3 className="mt-2 font-semibold text-gray-900 dark:text-white">{alert.title}</h3>
              <p className="mt-1 max-w-3xl text-sm text-gray-500 dark:text-gray-400">{alert.description || 'No description provided.'}</p>
              <div className="mt-2 text-xs text-gray-400">{alert.session_id} · {fmtDate(alert.created_at)}</div>
            </div>
            <div className="flex gap-2">
              {alert.status === 'open' ? <ActionButton size="sm" variant="secondary" onClick={() => onReview(alert, 'acknowledged')}>Ack</ActionButton> : null}
              {!['resolved', 'dismissed'].includes(alert.status) ? (
                <>
                  <ActionButton size="sm" variant="primary" onClick={() => onReview(alert, 'resolved')}>Resolve</ActionButton>
                  <ActionButton size="sm" variant="ghost" onClick={() => onReview(alert, 'dismissed')}>Dismiss</ActionButton>
                </>
              ) : null}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function Feed({ events }: { events: ModerationEvent[] }) {
  if (!events.length) return <Empty label="No realtime moderation events yet." />;
  return (
    <div className="rounded-lg border border-gray-200 bg-white dark:border-dark-border dark:bg-dark-card">
      <div className="divide-y divide-gray-100 dark:divide-slate-800">
        {events.slice(0, 20).map((event) => (
          <div key={event.id} className="p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <StatusBadge status={event.severity} color={severityColors[event.severity] || 'gray'} />
                <span className="text-sm font-medium text-gray-900 dark:text-white">{event.event_type}</span>
              </div>
              <span className="text-xs text-gray-400">{fmtDate(event.created_at)}</span>
            </div>
            <p className="mt-1 line-clamp-2 text-sm text-gray-500 dark:text-gray-400">{event.message || event.transcript || event.content_type || 'AI activity event'}</p>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-gray-400">
              <span>{event.session_id}</span>
              <span>{event.model_name || 'model pending'}</span>
              <span className={riskTone(event.risk_score)}>risk {Math.round(event.risk_score || 0)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RuleCard({ rule }: { rule: AiRule }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-dark-border dark:bg-dark-card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-gray-900 dark:text-white">{rule.label}</h3>
          <p className="text-xs text-gray-400">{rule.rule_key} · {rule.category}</p>
        </div>
        <StatusBadge status={rule.enabled ? 'enabled' : 'disabled'} color={rule.enabled ? 'green' : 'gray'} />
      </div>
      <pre className="mt-3 max-h-40 overflow-auto rounded-md bg-gray-50 p-3 text-xs text-gray-600 dark:bg-slate-900 dark:text-gray-300">
        {JSON.stringify(rule.value, null, 2)}
      </pre>
    </div>
  );
}

export function AIModerator() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = (searchParams.get('tab') || 'overview') as TabKey;
  const [tab, setTab] = useState<TabKey>(tabs.some((item) => item.key === initialTab) ? initialTab : 'overview');
  const [overview, setOverview] = useState<AiOverview | null>(null);
  const [live, setLive] = useState<{ sessions: AiSession[]; alerts: AiAlert[]; feed: ModerationEvent[] }>({ sessions: [], alerts: [], feed: [] });
  const [incidents, setIncidents] = useState<{ incidents: AiAlert[]; total: number }>({ incidents: [], total: 0 });
  const [analytics, setAnalytics] = useState<AiAnalytics | null>(null);
  const [fraud, setFraud] = useState<AiFraudPayload | null>(null);
  const [training, setTraining] = useState<{ rules: AiRule[]; trainingLogs: AiTrainingLog[] }>({ rules: [], trainingLogs: [] });
  const [infra, setInfra] = useState<{ workers: AiWorkerHealth[]; serviceHealth: Record<string, unknown>; aiHealth: Record<string, unknown>; redis: Record<string, unknown>; qstash: Record<string, unknown>; queues: Record<string, number>; recentAlertFeed: AiAlert[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [socketOnline, setSocketOnline] = useState(false);
  const { success, error: toastError } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [overviewRes, liveRes, incidentsRes, analyticsRes, fraudRes, trainingRes, infraRes] = await Promise.all([
        fetchAiOverview(),
        fetchAiLiveMonitoring(),
        fetchAiIncidents({ page: 1, limit: 50 }),
        fetchAiAnalytics('24h'),
        fetchAiFraud(),
        fetchAiTraining(),
        fetchAiInfrastructure(),
      ]);
      setOverview(overviewRes);
      setLive(liveRes);
      setIncidents({ incidents: incidentsRes.incidents, total: incidentsRes.total });
      setAnalytics(analyticsRes);
      setFraud(fraudRes);
      setTraining(trainingRes);
      setInfra(infraRes);
    } catch (err: any) {
      toastError(err.message || 'Could not load AI moderation dashboard.');
    } finally {
      setLoading(false);
    }
  }, [toastError]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const next = (searchParams.get('tab') || 'overview') as TabKey;
    if (tabs.some((item) => item.key === next)) setTab(next);
  }, [searchParams]);

  useEffect(() => subscribeAiModerationSocket({
    onOverview: (payload) => { setOverview(payload); setSocketOnline(true); },
    onSession: ({ session }) => {
      setSocketOnline(true);
      setLive((current) => ({ ...current, sessions: [session, ...current.sessions.filter((row) => row.session_id !== session.session_id)].slice(0, 50) }));
    },
    onAlert: ({ alert }) => {
      setSocketOnline(true);
      setIncidents((current) => ({ ...current, incidents: [alert, ...current.incidents.filter((row) => row.id !== alert.id)].slice(0, 50) }));
      setLive((current) => ({ ...current, alerts: [alert, ...current.alerts.filter((row) => row.id !== alert.id)].slice(0, 25) }));
    },
    onEvent: ({ event }) => {
      setSocketOnline(true);
      setLive((current) => ({ ...current, feed: [event, ...current.feed.filter((row) => row.id !== event.id)].slice(0, 50) }));
    },
    onError: (message) => toastError(message),
  }), [toastError]);

  const filteredSessions = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return live.sessions;
    return live.sessions.filter((session) => `${session.session_id} ${session.title || ''} ${session.creator_id || ''}`.toLowerCase().includes(q));
  }, [live.sessions, search]);

  const handleReview = async (alert: AiAlert, status: string) => {
    try {
      await reviewAiAlert(alert.id, { status, action: status, notes: `Marked ${status} from AI Moderator console.` });
      success(`Alert ${status}.`);
      load();
    } catch (err: any) {
      toastError(err.message || 'Could not update alert.');
    }
  };

  const handleRetrain = async () => {
    try {
      await triggerAiRetraining({ datasetName: 'reviewed-moderation-events', modelName: 'moderation-ensemble' });
      success('AI retraining workflow queued.');
      load();
    } catch (err: any) {
      toastError(err.message || 'Could not queue training workflow.');
    }
  };

  const stats = overview?.stats || { activeSessions: 0, flaggedSessions: 0, realtimeAlerts: 0, criticalAlerts: 0, eventsLastHour: 0, avgRiskScore: 0 };

  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <BotIcon className="h-6 w-6 text-blue-500" />
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">AI Moderator</h1>
            <StatusBadge status={socketOnline ? 'live socket' : 'polling'} color={socketOnline ? 'green' : 'gray'} />
          </div>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Realtime AI moderation for livestreams, IVI, chats, uploads, user behavior, and fraud signals.</p>
        </div>
        <ActionButton variant="secondary" icon={RefreshCwIcon} onClick={load} isLoading={loading}>Refresh</ActionButton>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-6 gap-4">
        <MetricCard label="Active Sessions" value={stats.activeSessions} icon={<ActivityIcon className="h-4 w-4" />} />
        <MetricCard label="Flagged Sessions" value={stats.flaggedSessions} icon={<ShieldAlertIcon className="h-4 w-4" />} />
        <MetricCard label="Realtime Alerts" value={stats.realtimeAlerts} icon={<SirenIcon className="h-4 w-4" />} />
        <MetricCard label="Critical Alerts" value={stats.criticalAlerts} icon={<AlertTriangleIcon className="h-4 w-4" />} />
        <MetricCard label="Events Last Hour" value={stats.eventsLastHour} icon={<DatabaseIcon className="h-4 w-4" />} />
        <MetricCard label="Avg Risk" value={Math.round(stats.avgRiskScore)} icon={<GaugeIcon className="h-4 w-4" />} />
      </div>

      <div className="flex flex-wrap gap-2 rounded-lg border border-gray-200 bg-white p-2 dark:border-dark-border dark:bg-dark-card">
        {tabs.map((item) => {
          const Icon = item.icon;
          const active = tab === item.key;
          return (
            <button
              key={item.key}
              onClick={() => { setTab(item.key); setSearchParams({ tab: item.key }); }}
              className={`inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                active
                  ? 'bg-gray-900 text-white dark:bg-white dark:text-gray-950'
                  : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-slate-800 dark:hover:text-white'
              }`}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </button>
          );
        })}
      </div>

      {tab === 'overview' ? (
        <div className="grid grid-cols-1 xl:grid-cols-[1.2fr_0.8fr] gap-6">
          <div className="space-y-4">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Realtime AI Feed</h2>
            <Feed events={overview?.feed || live.feed} />
          </div>
          <div className="space-y-4">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">AI Health</h2>
            <div className="rounded-lg border border-gray-200 bg-white p-5 dark:border-dark-border dark:bg-dark-card">
              <div className="flex items-center justify-between">
                <StatusBadge status={overview?.aiHealth.status || 'unknown'} color={statusColors[overview?.aiHealth.status || 'unknown'] || 'gray'} />
                <BrainCircuitIcon className="h-5 w-5 text-gray-400" />
              </div>
              <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
                <div>
                  <div className="text-gray-400">Workers online</div>
                  <div className="text-xl font-bold text-gray-900 dark:text-white">{overview?.aiHealth.workersOnline || 0}</div>
                </div>
                <div>
                  <div className="text-gray-400">Avg latency</div>
                  <div className="text-xl font-bold text-gray-900 dark:text-white">{overview?.aiHealth.avgLatencyMs || 0}ms</div>
                </div>
              </div>
            </div>
            <AlertList alerts={overview?.alerts || []} onReview={handleReview} />
          </div>
        </div>
      ) : null}

      {tab === 'live' ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Live Monitoring</h2>
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input className="rounded-md border border-gray-200 bg-white py-2 pl-9 pr-3 text-sm dark:border-dark-border dark:bg-dark-card" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search sessions" />
            </div>
          </div>
          <SessionTable sessions={filteredSessions} />
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <AlertList alerts={live.alerts} onReview={handleReview} />
            <Feed events={live.feed} />
          </div>
        </div>
      ) : null}

      {tab === 'incidents' ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Moderation Incidents</h2>
            <span className="text-sm text-gray-400">{incidents.total} total</span>
          </div>
          <AlertList alerts={incidents.incidents} onReview={handleReview} />
        </div>
      ) : null}

      {tab === 'analytics' ? (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-dark-border dark:bg-dark-card">
            <h3 className="mb-4 text-sm font-semibold text-gray-900 dark:text-white">Risk Progression</h3>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={analytics?.timeline || []}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="ts" hide />
                  <YAxis />
                  <Tooltip />
                  <Area dataKey="avgRisk" stroke="#2563eb" fill="#2563eb33" />
                  <Area dataKey="critical" stroke="#ef4444" fill="#ef444433" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-dark-border dark:bg-dark-card">
            <h3 className="mb-4 text-sm font-semibold text-gray-900 dark:text-white">Events by Type</h3>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={analytics?.byType || []}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="type" />
                  <YAxis />
                  <Tooltip />
                  <Bar dataKey="events" fill="#0ea5e9" />
                  <Bar dataKey="avgRisk" fill="#f97316" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-dark-border dark:bg-dark-card xl:col-span-2">
            <h3 className="mb-4 text-sm font-semibold text-gray-900 dark:text-white">AI Confidence and Risk</h3>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={analytics?.confidence || []}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="ts" hide />
                  <YAxis />
                  <Tooltip />
                  <Line type="monotone" dataKey="confidence" stroke="#22c55e" dot={false} />
                  <Line type="monotone" dataKey="risk" stroke="#ef4444" dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      ) : null}

      {tab === 'fraud' ? (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          <div className="xl:col-span-2 rounded-lg border border-gray-200 bg-white dark:border-dark-border dark:bg-dark-card">
            <div className="border-b border-gray-100 p-4 dark:border-slate-800">
              <h2 className="font-semibold text-gray-900 dark:text-white">Suspicious Withdrawals</h2>
            </div>
            <div className="divide-y divide-gray-100 dark:divide-slate-800">
              {(fraud?.suspiciousPayouts || []).map((row) => (
                <div key={row.id} className="flex items-center justify-between gap-4 p-4 text-sm">
                  <div>
                    <div className="font-medium text-gray-900 dark:text-white">{row.creator_name || row.creator_id}</div>
                    <div className="text-xs text-gray-400">{row.status} · {fmtDate(row.requested_at)}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-semibold">${Number(row.amount_usd || 0).toFixed(2)}</div>
                    <RiskBar score={Number(row.risk_score || 0)} />
                  </div>
                </div>
              ))}
              {!fraud?.suspiciousPayouts?.length ? <div className="p-6"><Empty label="No suspicious payout signals." /></div> : null}
            </div>
          </div>
          <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-dark-border dark:bg-dark-card">
            <h2 className="font-semibold text-gray-900 dark:text-white">User Anomaly Profiles</h2>
            <div className="mt-3 space-y-3">
              {(fraud?.profiles || []).map((profile) => (
                <div key={profile.user_id} className="rounded-md border border-gray-100 p-3 dark:border-slate-800">
                  <div className="font-mono text-xs text-gray-500">{profile.user_id}</div>
                  <div className="mt-2"><RiskBar score={Number(profile.risk_score || 0)} /></div>
                </div>
              ))}
              {!fraud?.profiles?.length ? <Empty label="No high-risk user profiles." /> : null}
            </div>
          </div>
        </div>
      ) : null}

      {tab === 'training' ? (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">AI Training Center</h2>
            <ActionButton icon={GraduationCapIcon} onClick={handleRetrain}>Retrain</ActionButton>
          </div>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {training.rules.map((rule) => <RuleCard key={rule.id} rule={rule} />)}
          </div>
          <div className="rounded-lg border border-gray-200 bg-white dark:border-dark-border dark:bg-dark-card">
            <div className="border-b border-gray-100 p-4 dark:border-slate-800">
              <h3 className="font-semibold text-gray-900 dark:text-white">Training Logs</h3>
            </div>
            <div className="divide-y divide-gray-100 dark:divide-slate-800">
              {training.trainingLogs.map((log) => (
                <div key={log.id} className="flex items-center justify-between gap-4 p-4 text-sm">
                  <div>
                    <div className="font-medium text-gray-900 dark:text-white">{log.model_name}</div>
                    <div className="text-xs text-gray-400">{log.dataset_name || 'dataset'} · {fmtDate(log.created_at)}</div>
                  </div>
                  <StatusBadge status={log.status} color={statusColors[log.status] || 'gray'} />
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {tab === 'infra' ? (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          <MetricCard label="Redis Queue" value={infra?.queues?.moderation || 0} detail="moderation jobs" icon={<DatabaseIcon className="h-4 w-4" />} />
          <MetricCard label="AI Service" value={String(infra?.serviceHealth?.status || 'unknown')} detail={String(infra?.serviceHealth?.latencyMs || 0) + 'ms'} icon={<BrainCircuitIcon className="h-4 w-4" />} />
          <MetricCard label="Workers" value={infra?.workers?.length || 0} detail={`${infra?.aiHealth?.workersOnline || 0} online`} icon={<CpuIcon className="h-4 w-4" />} />
          <div className="xl:col-span-3 rounded-lg border border-gray-200 bg-white dark:border-dark-border dark:bg-dark-card">
            <div className="border-b border-gray-100 p-4 dark:border-slate-800">
              <h3 className="font-semibold text-gray-900 dark:text-white">Worker Status</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="bg-gray-50 text-xs uppercase text-gray-500 dark:bg-slate-900/60">
                  <tr>
                    <th className="px-4 py-3">Worker</th>
                    <th className="px-4 py-3">Model</th>
                    <th className="px-4 py-3">GPU</th>
                    <th className="px-4 py-3">Queue</th>
                    <th className="px-4 py-3">Latency</th>
                    <th className="px-4 py-3">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
                  {(infra?.workers || []).map((worker) => (
                    <tr key={worker.worker_id}>
                      <td className="px-4 py-3 font-mono text-xs">{worker.worker_id}</td>
                      <td className="px-4 py-3">{worker.model_name || '-'}</td>
                      <td className="px-4 py-3">{worker.gpu_name || 'CPU'}</td>
                      <td className="px-4 py-3">{worker.queue_depth}</td>
                      <td className="px-4 py-3">{Math.round(worker.inference_latency_ms)}ms</td>
                      <td className="px-4 py-3"><StatusBadge status={worker.status} color={statusColors[worker.status] || 'gray'} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}

      <div className="rounded-lg border border-gray-200 bg-white p-4 text-xs text-gray-500 dark:border-dark-border dark:bg-dark-card dark:text-gray-400">
        <div className="flex items-center gap-2 font-medium text-gray-700 dark:text-gray-200">
          <SlidersHorizontalIcon className="h-4 w-4" />
          Pipeline
        </div>
        <p className="mt-2">Livestream frame or chat signal {'->'} Redis/QStash queue {'->'} AI worker ensemble {'->'} risk score {'->'} Redis/admin Socket.IO event {'->'} incident review and audit trail.</p>
      </div>
    </motion.div>
  );
}
