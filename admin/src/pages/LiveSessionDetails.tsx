import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeftIcon, UsersIcon, HeartIcon, GiftIcon,
  ClockIcon, BanIcon, CheckCircleIcon, RefreshCwIcon,
} from 'lucide-react';
import { StatusBadge, type StatusColor } from '../components/shared/StatusBadge';
import { ActionButton } from '../components/shared/ActionButton';
import { DataTable, type Column } from '../components/shared/DataTable';
import { fetchLiveSessionById, updateLiveStatus } from '../api/contentApi';

const statusColor: Record<string, StatusColor> = {
  live: 'green', paused: 'yellow', ended: 'gray', banned: 'red',
};

function StatBox({ label, value, icon }: { label: string; value: string | number; icon: React.ReactNode }) {
  return (
    <div className="bg-white dark:bg-dark-card rounded-xl border border-gray-200 dark:border-dark-border p-5">
      <div className="flex items-center gap-2 mb-2 text-gray-500">{icon}<span className="text-xs">{label}</span></div>
      <p className="text-2xl font-bold text-gray-900 dark:text-white">{typeof value === 'number' ? value.toLocaleString() : value}</p>
    </div>
  );
}

function dur(start: string, end?: string) {
  const ms = new Date(end || Date.now()).getTime() - new Date(start).getTime();
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function LiveSessionDetails() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [toast, setToast] = useState('');
  const [activeTab, setActiveTab] = useState<'gifts' | 'viewers'>('gifts');

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(''), 3000); };

  const load = () => {
    if (!id) return;
    setLoading(true);
    fetchLiveSessionById(id)
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [id]);

  const handleStatus = async (status: string) => {
    if (!id) return;
    try {
      setActionLoading(true);
      await updateLiveStatus(id, status);
      showToast(`Session ${status}.`);
      load();
    } catch (e: any) { showToast(`Error: ${e.message}`); }
    finally { setActionLoading(false); }
  };

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="w-8 h-8 border-4 border-brand-primary border-t-transparent rounded-full animate-spin" />
    </div>
  );

  if (error || !data) return (
    <div className="p-6">
      <button onClick={() => navigate('/live-sessions')} className="flex items-center gap-2 text-gray-500 hover:text-gray-700 mb-4">
        <ArrowLeftIcon className="w-4 h-4" /> Back
      </button>
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">{error || 'Not found.'}</div>
    </div>
  );

  const { live, gifts, viewers } = data;
  const duration = live.created_at ? dur(live.created_at, live.ended_at) : '—';

  const giftColumns: Column<any>[] = [
    { key: 'sender_id', header: 'Sender', render: (g) => <span className="text-sm font-medium">{g.sender_username || g.username || 'Anonymous'}</span> },
    { key: 'gift_type', header: 'Gift', render: (g) => <span className="text-sm">{g.gift_type || g.name || '—'}</span> },
    { key: 'amount', header: 'Amount', render: (g) => <span className="text-sm font-medium text-green-600">₦{Number(g.amount || 0).toLocaleString()}</span> },
    { key: 'created_at', header: 'Time', render: (g) => <span className="text-xs text-gray-500">{g.created_at ? new Date(g.created_at).toLocaleString() : '—'}</span> },
  ];

  const viewerColumns: Column<any>[] = [
    { key: 'user_id', header: 'Viewer', render: (v) => <span className="text-sm font-medium">{v.username || 'Anonymous'}</span> },
    { key: 'joined_at', header: 'Joined', render: (v) => <span className="text-xs text-gray-500">{v.joined_at ? new Date(v.joined_at).toLocaleTimeString() : '—'}</span> },
    { key: 'left_at', header: 'Left', render: (v) => v.left_at ? <span className="text-xs text-gray-500">{new Date(v.left_at).toLocaleTimeString()}</span> : <span className="text-xs text-green-500">Watching</span> },
  ];

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="p-6 space-y-6">
      {toast && <div className="fixed top-4 right-4 z-50 bg-gray-900 text-white px-4 py-2 rounded-lg shadow-lg text-sm">{toast}</div>}

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-4">
          <button onClick={() => navigate('/live-sessions')}
            className="p-2 text-gray-500 hover:bg-gray-100 dark:hover:bg-slate-800 rounded-lg border border-gray-200 dark:border-dark-border">
            <ArrowLeftIcon className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-3">
            <img
              src={live.hostAvatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(live.hostName)}&size=40&background=random`}
              className="w-10 h-10 rounded-full object-cover"
              alt={live.hostName}
            />
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-xl font-bold text-gray-900 dark:text-white">{live.hostName}</h1>
                <StatusBadge status={live.status} color={statusColor[live.status] || 'gray'} />
              </div>
              <p className="text-sm text-gray-500">Session ID: {id?.slice(0, 12)}… · Started {live.created_at ? new Date(live.created_at).toLocaleString() : '—'}</p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <ActionButton label="Refresh" icon={<RefreshCwIcon className="w-4 h-4" />} onClick={load} variant="secondary" />
          {live.status === 'live' && (
            <ActionButton label="Force End" icon={<BanIcon className="w-4 h-4" />} onClick={() => handleStatus('ended')} isLoading={actionLoading} variant="danger" />
          )}
          {live.status !== 'banned' && (
            <ActionButton label="Ban Stream" icon={<BanIcon className="w-4 h-4" />} onClick={() => handleStatus('banned')} isLoading={actionLoading} variant="danger" />
          )}
          {live.status === 'banned' && (
            <ActionButton label="Unban" icon={<CheckCircleIcon className="w-4 h-4" />} onClick={() => handleStatus('ended')} isLoading={actionLoading} variant="primary" />
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatBox label="Peak Viewers" value={live.viewers_count || 0} icon={<UsersIcon className="w-4 h-4" />} />
        <StatBox label="Total Likes" value={live.total_likes || 0} icon={<HeartIcon className="w-4 h-4" />} />
        <StatBox label="Gift Revenue" value={`₦${Number(live.total_gifts_amount || 0).toLocaleString()}`} icon={<GiftIcon className="w-4 h-4" />} />
        <StatBox label="Duration" value={duration} icon={<ClockIcon className="w-4 h-4" />} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Tabs */}
        <div className="lg:col-span-2">
          <div className="bg-white dark:bg-dark-card rounded-xl border border-gray-200 dark:border-dark-border overflow-hidden">
            <nav className="flex border-b border-gray-200 dark:border-dark-border">
              {(['gifts', 'viewers'] as const).map(tab => (
                <button key={tab} onClick={() => setActiveTab(tab)}
                  className={`flex-1 py-3 text-sm font-medium transition-colors ${activeTab === tab ? 'border-b-2 border-brand-primary text-brand-primary' : 'text-gray-500 hover:text-gray-700'}`}>
                  {tab === 'gifts' ? `Gifts (${gifts.length})` : `Viewers (${viewers.length})`}
                </button>
              ))}
            </nav>
            <DataTable
              columns={activeTab === 'gifts' ? giftColumns : viewerColumns}
              data={activeTab === 'gifts' ? gifts : viewers}
              isLoading={false}
              emptyMessage={activeTab === 'gifts' ? 'No gifts recorded.' : 'No viewer data.'}
            />
          </div>
        </div>

        {/* Summary */}
        <div className="space-y-4">
          <div className="bg-white dark:bg-dark-card rounded-xl border border-gray-200 dark:border-dark-border p-5">
            <h3 className="font-semibold text-gray-900 dark:text-white mb-4">Session Summary</h3>
            <div className="space-y-3 text-sm">
              {[
                ['Host', live.hostName || 'Unknown'],
                ['Status', live.status],
                ['Started', live.created_at ? new Date(live.created_at).toLocaleString() : '—'],
                ['Ended', live.ended_at ? new Date(live.ended_at).toLocaleString() : 'Still active'],
                ['Duration', duration],
                ['Total Gifts', `₦${Number(live.total_gifts_amount || 0).toLocaleString()}`],
                ['Creator Share (70%)', `₦${(Number(live.total_gifts_amount || 0) * 0.7).toLocaleString()}`],
                ['Platform Share (30%)', `₦${(Number(live.total_gifts_amount || 0) * 0.3).toLocaleString()}`],
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between items-center py-1.5 border-b border-gray-100 dark:border-slate-800">
                  <span className="text-gray-500">{label}</span>
                  <span className="font-medium text-gray-900 dark:text-white text-right">{value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
