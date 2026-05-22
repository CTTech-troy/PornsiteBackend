import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeftIcon, MailIcon, CalendarIcon, ShieldCheckIcon,
  BanIcon, ShieldAlertIcon, CheckCircleIcon, CreditCardIcon,
} from 'lucide-react';
import { StatusBadge, type StatusColor } from '../components/shared/StatusBadge';
import { ActionButton } from '../components/shared/ActionButton';
import { Modal } from '../components/shared/Modal';
import {
  fetchUserById, updateUserStatus, updateUserCoins,
  type UserDetailResponse,
} from '../api/usersApi';

const statusColor: Record<string, StatusColor> = { active: 'green', suspended: 'yellow', banned: 'red' };

function formatDate(value?: string | null, includeTime = false) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return includeTime ? date.toLocaleString() : date.toLocaleDateString();
}

export function UserDetails() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<UserDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [coinsModal, setCoinsModal] = useState(false);
  const [coinsValue, setCoinsValue] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [toast, setToast] = useState('');

  const load = async () => {
    if (!id) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetchUserById(id);
      setDetail(res);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [id]);

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(''), 3000); };

  const handleStatus = async (status: string) => {
    if (!detail) return;
    try {
      setActionLoading(true);
      await updateUserStatus(detail.user.id, status);
      showToast(`User ${status} successfully.`);
      load();
    } catch (e: any) {
      showToast(`Error: ${e.message}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleCoins = async () => {
    if (!detail) return;
    try {
      setActionLoading(true);
      await updateUserCoins(detail.user.id, Number(coinsValue));
      showToast('Coin balance updated.');
      setCoinsModal(false);
      load();
    } catch (e: any) {
      showToast(`Error: ${e.message}`);
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-96">
        <div className="animate-spin w-6 h-6 border-2 border-accent border-t-transparent rounded-full" />
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="bg-danger/10 border border-danger/20 rounded-lg p-4 text-danger text-[13px]">
        {error || 'User not found.'}
      </div>
    );
  }

  const { user: u, membership, earnings, adminHistory } = detail;
  const status = u.status || 'active';

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <button onClick={() => navigate(-1)} className="flex items-center gap-2 text-[13px] text-text-tertiary hover:text-text-primary transition-colors">
        <ArrowLeftIcon className="w-4 h-4" /> Back to Users
      </button>

      {/* Profile Card */}
      <div className="card p-6">
        <div className="flex items-start gap-6 flex-wrap">
          <img
            src={u.avatar_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(u.display_name || u.username)}&size=80&background=1a1a1a&color=fff`}
            className="w-16 h-16 rounded-full object-cover"
            alt=""
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-xl font-semibold text-text-primary">{u.display_name || u.username}</h1>
              <StatusBadge status={status} color={statusColor[status] || 'gray'} />
              {u.is_verified && <span className="flex items-center gap-1 text-accent text-[12px]"><ShieldCheckIcon className="w-3.5 h-3.5" /> Verified</span>}
              {u.is_creator && <span className="text-[11px] bg-accent/10 text-accent border border-accent/20 px-2 py-0.5 rounded-full">Creator</span>}
            </div>
            <p className="text-[13px] text-text-tertiary mt-1">@{u.username}</p>
            <div className="flex flex-wrap gap-4 mt-2 text-[13px] text-text-secondary">
              <span className="flex items-center gap-1.5"><MailIcon className="w-3.5 h-3.5" /> {u.email}</span>
              <span className="flex items-center gap-1.5"><CalendarIcon className="w-3.5 h-3.5" /> Joined {formatDate(u.created_at)}</span>
            </div>
          </div>
          {/* Actions */}
          <div className="flex flex-col gap-2">
            {status !== 'active' && (
              <ActionButton icon={CheckCircleIcon} variant="primary" onClick={() => handleStatus('active')} isLoading={actionLoading}>Activate</ActionButton>
            )}
            {status !== 'suspended' && (
              <ActionButton icon={ShieldAlertIcon} variant="secondary" onClick={() => handleStatus('suspended')} isLoading={actionLoading}>Suspend</ActionButton>
            )}
            {status !== 'banned' && (
              <ActionButton icon={BanIcon} variant="danger" onClick={() => handleStatus('banned')} isLoading={actionLoading}>Ban</ActionButton>
            )}
            <ActionButton icon={CreditCardIcon} variant="secondary" onClick={() => { setCoinsValue(String(u.coin_balance)); setCoinsModal(true); }}>
              Edit Coins
            </ActionButton>
          </div>
        </div>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Coin Balance', value: (u.coin_balance ?? 0).toLocaleString() },
          { label: 'Plan', value: u.active_plan || 'Free' },
          { label: 'Followers', value: (u.followers ?? 0).toLocaleString() },
          { label: 'Following', value: (u.following ?? 0).toLocaleString() },
        ].map(s => (
          <div key={s.label} className="card p-4">
            <p className="text-[11px] font-medium text-text-tertiary uppercase tracking-wide mb-1">{s.label}</p>
            <p className="text-xl font-bold text-text-primary">{s.value}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Membership */}
        <div className="card p-5">
          <h2 className="text-[14px] font-semibold text-text-primary mb-4">Membership</h2>
          {membership ? (
            <div className="space-y-2">
              {[
                { label: 'Plan', value: membership.plan_id },
                { label: 'Amount Paid', value: `$${membership.amount_paid_usd}` },
                { label: 'Expires', value: formatDate(membership.expires_at) },
              ].map(({ label, value }) => (
                <div key={label} className="flex justify-between text-[13px]">
                  <span className="text-text-tertiary">{label}</span>
                  <span className="text-text-primary">{value}</span>
                </div>
              ))}
              <div className="flex justify-between text-[13px]">
                <span className="text-text-tertiary">Status</span>
                <StatusBadge status={membership.status} color="green" />
              </div>
            </div>
          ) : (
            <p className="text-[13px] text-text-tertiary">No active membership.</p>
          )}
        </div>

        {/* Creator Earnings */}
        {u.is_creator && (
          <div className="card p-5">
            <h2 className="text-[14px] font-semibold text-text-primary mb-4">Creator Earnings</h2>
            <p className="text-3xl font-bold text-success">${typeof earnings === 'number' ? earnings.toFixed(2) : '0.00'}</p>
            <p className="text-[11px] text-text-tertiary mt-1">Total lifetime earnings</p>
          </div>
        )}
      </div>

      {/* Admin Action History */}
      {adminHistory && adminHistory.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-5 py-4 border-b border-border-default">
            <h2 className="text-[14px] font-semibold text-text-primary">Admin Action History</h2>
          </div>
          <div className="divide-y divide-border-subtle">
            {adminHistory.map((log, i) => (
              <div key={i} className="px-5 py-3 flex items-start justify-between gap-4">
                <div>
                  <p className="text-[13px] font-medium text-text-primary">{log.action}</p>
                  <p className="text-[12px] text-text-tertiary">by {log.admin_name}</p>
                </div>
                <p className="text-[11px] text-text-tertiary whitespace-nowrap">{formatDate(log.created_at, true)}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      <Modal isOpen={coinsModal} onClose={() => setCoinsModal(false)} title="Edit Coin Balance">
        <div className="space-y-4">
          <p className="text-[13px] text-text-secondary">Update coin balance for <strong className="text-text-primary">{u.display_name || u.username}</strong></p>
          <div>
            <label className="block text-[12px] font-medium text-text-secondary mb-1.5">Coin Balance</label>
            <input type="number" value={coinsValue} onChange={(e) => setCoinsValue(e.target.value)} className="input-field w-full" min={0} />
          </div>
          <div className="flex justify-end gap-3">
            <ActionButton onClick={() => setCoinsModal(false)} variant="secondary">Cancel</ActionButton>
            <ActionButton onClick={handleCoins} isLoading={actionLoading} variant="primary">Save</ActionButton>
          </div>
        </div>
      </Modal>
    </div>
  );
}
