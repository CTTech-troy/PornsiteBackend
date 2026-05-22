import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  BotIcon,
  CameraIcon,
  FileTextIcon,
  MessageSquareIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  Volume2Icon,
} from 'lucide-react';
import {
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
import { fetchAiSessionDetail, reviewAiAlert, type AiAlert, type AiSession, type ModerationEvent } from '../api/moderationApi';
import { useToast } from '../contexts/ToastContext';

const severityColors: Record<string, StatusColor> = {
  info: 'gray',
  low: 'yellow',
  medium: 'yellow',
  high: 'red',
  critical: 'red',
};

const statusColors: Record<string, StatusColor> = {
  active: 'green',
  open: 'red',
  reviewing: 'yellow',
  acknowledged: 'blue',
  resolved: 'green',
  dismissed: 'gray',
};

function fmtDate(value?: string | null) {
  return value ? new Date(value).toLocaleString() : '-';
}

function riskColor(score: number) {
  if (score >= 85) return 'text-red-500';
  if (score >= 65) return 'text-orange-500';
  if (score >= 45) return 'text-amber-500';
  return 'text-emerald-500';
}

function EventIcon({ type }: { type?: string | null }) {
  const value = String(type || '').toLowerCase();
  if (value.includes('audio') || value.includes('transcript')) return <Volume2Icon className="h-4 w-4" />;
  if (value.includes('frame') || value.includes('image')) return <CameraIcon className="h-4 w-4" />;
  if (value.includes('chat') || value.includes('comment')) return <MessageSquareIcon className="h-4 w-4" />;
  return <FileTextIcon className="h-4 w-4" />;
}

function SessionHeader({ session }: { session: AiSession }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5 dark:border-dark-border dark:bg-dark-card">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <BotIcon className="h-5 w-5 text-blue-500" />
            <h1 className="text-xl font-bold text-gray-900 dark:text-white">{session.title || session.session_id}</h1>
            <StatusBadge status={session.status} color={statusColors[session.status] || 'gray'} />
          </div>
          <p className="mt-1 font-mono text-xs text-gray-400">{session.session_id}</p>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            Hidden AI participant: <span className="font-semibold text-gray-700 dark:text-gray-200">system_ai</span>. Users never see this participant.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-4 text-right">
          <div>
            <div className="text-xs uppercase text-gray-400">Risk</div>
            <div className={`text-2xl font-bold ${riskColor(session.max_risk_score || session.risk_score)}`}>{Math.round(session.max_risk_score || session.risk_score || 0)}</div>
          </div>
          <div>
            <div className="text-xs uppercase text-gray-400">Events</div>
            <div className="text-2xl font-bold text-gray-900 dark:text-white">{session.event_count || 0}</div>
          </div>
          <div>
            <div className="text-xs uppercase text-gray-400">Alerts</div>
            <div className="text-2xl font-bold text-gray-900 dark:text-white">{session.alert_count || 0}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function AlertPanel({ alerts, onReview }: { alerts: AiAlert[]; onReview: (alert: AiAlert, status: string) => void }) {
  if (!alerts.length) {
    return <div className="rounded-lg border border-dashed border-gray-200 p-6 text-center text-sm text-gray-400 dark:border-dark-border">No alerts for this session.</div>;
  }
  return (
    <div className="space-y-3">
      {alerts.map((alert) => (
        <div key={alert.id} className="rounded-lg border border-gray-200 bg-white p-4 dark:border-dark-border dark:bg-dark-card">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <StatusBadge status={alert.severity} color={severityColors[alert.severity] || 'gray'} />
                <StatusBadge status={alert.status} color={statusColors[alert.status] || 'gray'} />
              </div>
              <h3 className="mt-2 font-semibold text-gray-900 dark:text-white">{alert.title}</h3>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{alert.description}</p>
            </div>
            {!['resolved', 'dismissed'].includes(alert.status) ? (
              <div className="flex gap-2">
                <ActionButton size="sm" onClick={() => onReview(alert, 'resolved')}>Resolve</ActionButton>
                <ActionButton size="sm" variant="ghost" onClick={() => onReview(alert, 'dismissed')}>Dismiss</ActionButton>
              </div>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function Timeline({ events }: { events: ModerationEvent[] }) {
  if (!events.length) {
    return <div className="rounded-lg border border-dashed border-gray-200 p-6 text-center text-sm text-gray-400 dark:border-dark-border">No moderation events yet.</div>;
  }
  return (
    <div className="rounded-lg border border-gray-200 bg-white dark:border-dark-border dark:bg-dark-card">
      <div className="divide-y divide-gray-100 dark:divide-slate-800">
        {events.map((event) => (
          <div key={event.id} className="p-4">
            <div className="flex items-start gap-3">
              <div className={`mt-1 rounded-md border p-2 ${Number(event.risk_score) >= 65 ? 'border-red-200 text-red-500 dark:border-red-500/30' : 'border-gray-200 text-gray-400 dark:border-slate-700'}`}>
                <EventIcon type={event.content_type || event.event_type} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-gray-900 dark:text-white">{event.event_type}</span>
                    <StatusBadge status={event.severity} color={severityColors[event.severity] || 'gray'} />
                    <span className={riskColor(event.risk_score)}>risk {Math.round(event.risk_score)}</span>
                  </div>
                  <span className="text-xs text-gray-400">{fmtDate(event.created_at)}</span>
                </div>
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{event.message || event.transcript || event.content_type || 'No text payload.'}</p>
                <div className="mt-2 flex flex-wrap gap-3 text-xs text-gray-400">
                  <span>{event.model_name || 'model pending'}</span>
                  <span>{event.verdict}</span>
                  <span>{Math.round(event.confidence || 0)}% confidence</span>
                  {event.user_id ? <span>user {event.user_id}</span> : null}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function AIModerationSession() {
  const { sessionId = '' } = useParams();
  const [session, setSession] = useState<AiSession | null>(null);
  const [events, setEvents] = useState<ModerationEvent[]>([]);
  const [alerts, setAlerts] = useState<AiAlert[]>([]);
  const [scores, setScores] = useState<Array<Record<string, any>>>([]);
  const [loading, setLoading] = useState(true);
  const { success, error: toastError } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const detail = await fetchAiSessionDetail(sessionId);
      setSession(detail.session);
      setEvents(detail.events);
      setAlerts(detail.alerts);
      setScores(detail.scores);
    } catch (err: any) {
      toastError(err.message || 'Could not load AI session.');
    } finally {
      setLoading(false);
    }
  }, [sessionId, toastError]);

  useEffect(() => { load(); }, [load]);

  const chart = useMemo(() => scores.map((row) => ({
    ts: row.created_at,
    score: Number(row.score || 0),
    confidence: Number(row.confidence || 0),
  })), [scores]);

  const handleReview = async (alert: AiAlert, status: string) => {
    try {
      await reviewAiAlert(alert.id, { status, action: status, notes: `Marked ${status} from session detail.` });
      success(`Alert ${status}.`);
      load();
    } catch (err: any) {
      toastError(err.message || 'Could not update alert.');
    }
  };

  if (!session && !loading) {
    return (
      <div className="space-y-4">
        <Link to="/ai-moderator" className="inline-flex items-center gap-2 text-sm text-gray-500 hover:text-gray-900 dark:hover:text-white">
          <ArrowLeftIcon className="h-4 w-4" /> Back to AI Moderator
        </Link>
        <div className="rounded-lg border border-dashed border-gray-200 p-8 text-center text-sm text-gray-400 dark:border-dark-border">
          Session not found.
        </div>
      </div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <div className="flex items-center justify-between">
        <Link to="/ai-moderator" className="inline-flex items-center gap-2 text-sm text-gray-500 hover:text-gray-900 dark:hover:text-white">
          <ArrowLeftIcon className="h-4 w-4" /> Back to AI Moderator
        </Link>
        <ActionButton variant="secondary" icon={RefreshCwIcon} onClick={load} isLoading={loading}>Refresh</ActionButton>
      </div>

      {session ? <SessionHeader session={session} /> : null}

      <div className="grid grid-cols-1 xl:grid-cols-[1.2fr_0.8fr] gap-6">
        <div className="space-y-6">
          <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-dark-border dark:bg-dark-card">
            <div className="mb-4 flex items-center gap-2">
              <ShieldAlertIcon className="h-4 w-4 text-gray-400" />
              <h2 className="font-semibold text-gray-900 dark:text-white">Risk Progression</h2>
            </div>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chart}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="ts" hide />
                  <YAxis />
                  <Tooltip />
                  <Line type="monotone" dataKey="score" stroke="#ef4444" dot={false} />
                  <Line type="monotone" dataKey="confidence" stroke="#2563eb" dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div>
            <div className="mb-3 flex items-center gap-2">
              <AlertTriangleIcon className="h-4 w-4 text-gray-400" />
              <h2 className="font-semibold text-gray-900 dark:text-white">Threat Timeline</h2>
            </div>
            <Timeline events={events} />
          </div>
        </div>

        <div className="space-y-6">
          <div>
            <h2 className="mb-3 font-semibold text-gray-900 dark:text-white">Moderation Actions</h2>
            <AlertPanel alerts={alerts} onReview={handleReview} />
          </div>

          <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-dark-border dark:bg-dark-card">
            <h2 className="font-semibold text-gray-900 dark:text-white">Captured Signals</h2>
            <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-md bg-gray-50 p-3 dark:bg-slate-900">
                <div className="text-gray-400">Suspicious messages</div>
                <div className="text-xl font-bold text-gray-900 dark:text-white">{events.filter((e) => ['chat', 'text'].includes(String(e.content_type))).length}</div>
              </div>
              <div className="rounded-md bg-gray-50 p-3 dark:bg-slate-900">
                <div className="text-gray-400">Frame snapshots</div>
                <div className="text-xl font-bold text-gray-900 dark:text-white">{events.filter((e) => String(e.content_type).includes('frame')).length}</div>
              </div>
              <div className="rounded-md bg-gray-50 p-3 dark:bg-slate-900">
                <div className="text-gray-400">Audio transcripts</div>
                <div className="text-xl font-bold text-gray-900 dark:text-white">{events.filter((e) => e.transcript).length}</div>
              </div>
              <div className="rounded-md bg-gray-50 p-3 dark:bg-slate-900">
                <div className="text-gray-400">Behavior events</div>
                <div className="text-xl font-bold text-gray-900 dark:text-white">{events.filter((e) => String(e.content_type).includes('behavior')).length}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
