import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { CheckCircleIcon, PlusIcon, ShieldIcon, Trash2Icon, UserCogIcon } from 'lucide-react';
import { ALL_PAGES, buildPermissionsFromKeys } from '../lib/permissions';
import { useAuth } from '../contexts/AuthContext';
import { API_BASE, apiMessage, readApiResponse } from '../api/http';

interface AdminRow {
  id: string;
  name: string | null;
  email: string;
  role?: string;
  avatar_url?: string | null;
  permissions: string[];
  is_active: boolean;
  is_super_admin: boolean;
  online?: boolean;
  last_active_at?: string | null;
  last_login: string | null;
  created_at: string | null;
}

const ROLE_OPTIONS = ['admin', 'moderator', 'finance', 'support', 'operations'];

function initials(admin: AdminRow) {
  return String(admin.name || admin.email || 'AD').slice(0, 2).toUpperCase();
}

function roleLabel(admin: AdminRow) {
  return (admin.is_super_admin ? 'super_admin' : (admin.role || 'admin')).replace('_', ' ');
}

export function AdminRoles() {
  const { token, user } = useAuth();
  const [admins, setAdmins] = useState<AdminRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [savingId, setSavingId] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteName, setInviteName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteKeys, setInviteKeys] = useState<string[]>([]);
  const [inviteStatus, setInviteStatus] = useState('');
  const [drafts, setDrafts] = useState<Record<string, { role: string; keys: string[] }>>({});

  const allKeys = useMemo(() => ALL_PAGES.map((page) => page.key), []);

  async function api(path: string, init: RequestInit = {}) {
    const res = await fetch(`${API_BASE}/api/admin${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token || ''}`,
        ...init.headers,
      },
    });
    const data = await readApiResponse<Record<string, any>>(res);
    if (!res.ok) throw new Error(apiMessage(data, 'Admin request failed'));
    return data;
  }

  async function loadAdmins() {
    if (!token) return;
    setLoading(true);
    setError('');
    try {
      const data = await api('/admin-users');
      const rows = Array.isArray(data.users) ? data.users : [];
      setAdmins(rows);
      setDrafts(Object.fromEntries(rows.map((admin: AdminRow) => [
        admin.id,
        {
          role: admin.is_super_admin ? 'admin' : (admin.role || 'admin'),
          keys: ALL_PAGES.filter((page) => (admin.permissions || []).includes(page.path)).map((page) => page.key),
        },
      ])));
    } catch (err) {
      setAdmins([]);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadAdmins(); }, [token]);

  function toggleDraftKey(adminId: string, key: string) {
    setDrafts((prev) => {
      const current = prev[adminId] || { role: 'admin', keys: [] };
      const keys = current.keys.includes(key) ? current.keys.filter((item) => item !== key) : [...current.keys, key];
      return { ...prev, [adminId]: { ...current, keys } };
    });
  }

  async function saveAdmin(admin: AdminRow) {
    const draft = drafts[admin.id];
    if (!draft || !token) return;
    setSavingId(admin.id);
    setError('');
    try {
      await api(`/admin-users/${encodeURIComponent(admin.id)}/permissions`, {
        method: 'PATCH',
        body: JSON.stringify({
          role: draft.role,
          permissions: buildPermissionsFromKeys(draft.keys),
        }),
      });
      await loadAdmins();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingId('');
    }
  }

  async function toggleStatus(admin: AdminRow) {
    setSavingId(admin.id);
    setError('');
    try {
      await api(`/admin-users/${encodeURIComponent(admin.id)}/toggle`, {
        method: 'PUT',
        body: JSON.stringify({ is_active: !admin.is_active }),
      });
      await loadAdmins();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingId('');
    }
  }

  async function deleteAdmin(admin: AdminRow) {
    if (!window.confirm(`Remove admin ${admin.email}?`)) return;
    setSavingId(admin.id);
    setError('');
    try {
      await api(`/admin-users/${encodeURIComponent(admin.id)}`, { method: 'DELETE' });
      setAdmins((prev) => prev.filter((item) => item.id !== admin.id));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingId('');
    }
  }

  async function sendInvite() {
    setInviteStatus('');
    if (!inviteEmail.trim()) {
      setInviteStatus('Email is required.');
      return;
    }
    if (inviteKeys.length === 0) {
      setInviteStatus('Select at least one permission.');
      return;
    }
    try {
      await api('/invite', {
        method: 'POST',
        body: JSON.stringify({
          email: inviteEmail.trim(),
          name: inviteName.trim(),
          permissions: buildPermissionsFromKeys(inviteKeys),
        }),
      });
      setInviteStatus('Invite sent successfully.');
      setInviteName('');
      setInviteEmail('');
      setInviteKeys([]);
      await loadAdmins();
    } catch (err) {
      setInviteStatus((err as Error).message);
    }
  }

  if (!user?.is_super_admin) {
    return (
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
        <div className="card p-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-danger/20 bg-danger/10">
            <ShieldIcon className="h-6 w-6 text-danger" />
          </div>
          <h1 className="text-[15px] font-semibold text-text-primary">Access denied</h1>
          <p className="mt-1 text-[13px] text-text-tertiary">Only Super Admins can manage the admin team.</p>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Admin Team</h1>
          <p className="mt-0.5 text-[13px] text-text-tertiary">Manage admins, roles, page permissions, and account status.</p>
        </div>
        <button onClick={() => setInviteOpen((value) => !value)} className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-accent px-4 text-[13px] font-semibold text-white">
          <PlusIcon className="h-4 w-4" />
          Add Admin
        </button>
      </div>

      {error && <div className="rounded-lg border border-danger/20 bg-danger/10 p-4 text-[13px] text-danger">{error}</div>}

      {inviteOpen && (
        <div className="card p-5">
          <div className="grid gap-4 lg:grid-cols-[1fr_1fr_2fr_auto]">
            <input value={inviteName} onChange={(e) => setInviteName(e.target.value)} className="input-field" placeholder="Full name" />
            <input value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} className="input-field" placeholder="Email address" type="email" />
            <div className="flex flex-wrap gap-2">
              {ALL_PAGES.map((page) => (
                <button
                  key={page.key}
                  type="button"
                  onClick={() => setInviteKeys((prev) => prev.includes(page.key) ? prev.filter((key) => key !== page.key) : [...prev, page.key])}
                  className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${inviteKeys.includes(page.key) ? 'border-accent bg-accent/10 text-accent' : 'border-border-default text-text-secondary'}`}
                >
                  {page.label}
                </button>
              ))}
            </div>
            <button onClick={sendInvite} className="h-10 rounded-lg bg-accent px-4 text-[13px] font-semibold text-white">Send</button>
          </div>
          {inviteStatus && <p className="mt-3 text-[13px] text-text-secondary">{inviteStatus}</p>}
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="flex items-center justify-between border-b border-border-default px-5 py-4">
          <div className="flex items-center gap-2">
            <UserCogIcon className="h-4 w-4 text-text-tertiary" />
            <h2 className="text-[14px] font-semibold text-text-primary">Admin Team ({loading ? '...' : admins.length})</h2>
          </div>
          <span className="text-[12px] text-text-tertiary">{admins.filter((admin) => admin.online).length} online</span>
        </div>

        <div className="divide-y divide-border-subtle">
          {!loading && admins.length === 0 && (
            <div className="p-10 text-center text-[13px] text-text-tertiary">No admin users found.</div>
          )}
          {admins.map((admin) => {
            const draft = drafts[admin.id] || { role: 'admin', keys: [] };
            return (
              <div key={admin.id} className="grid gap-4 p-5 xl:grid-cols-[1.2fr_0.8fr_1.8fr_auto]">
                <div className="flex min-w-0 items-center gap-3">
                  {admin.avatar_url ? (
                    <img src={admin.avatar_url} alt="" className="h-11 w-11 rounded-full object-cover" />
                  ) : (
                    <div className="flex h-11 w-11 items-center justify-center rounded-full border border-border-default bg-bg-elevated text-[13px] font-bold text-text-secondary">
                      {initials(admin)}
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-[13px] font-semibold text-text-primary">{admin.name || admin.email}</p>
                      {admin.is_super_admin && <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-bold text-accent">Super</span>}
                    </div>
                    <p className="truncate text-[12px] text-text-tertiary">{admin.email}</p>
                    <p className="mt-0.5 text-[11px] text-text-tertiary">
                      {admin.online ? 'Online now' : `Last active ${admin.last_active_at ? new Date(admin.last_active_at).toLocaleString() : '-'}`}
                    </p>
                  </div>
                </div>

                <div>
                  <label className="mb-1 block text-[11px] font-semibold uppercase tracking-widest text-text-tertiary">Role</label>
                  <select
                    value={draft.role}
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [admin.id]: { ...draft, role: e.target.value } }))}
                    disabled={admin.is_super_admin}
                    className="input-field"
                  >
                    {ROLE_OPTIONS.map((role) => <option key={role} value={role}>{role}</option>)}
                  </select>
                  <p className="mt-1 text-[11px] capitalize text-text-tertiary">{roleLabel(admin)}</p>
                </div>

                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <label className="text-[11px] font-semibold uppercase tracking-widest text-text-tertiary">Permissions</label>
                    <button
                      type="button"
                      onClick={() => setDrafts((prev) => ({ ...prev, [admin.id]: { ...draft, keys: draft.keys.length === allKeys.length ? [] : allKeys } }))}
                      disabled={admin.is_super_admin}
                      className="text-[11px] font-semibold text-accent disabled:text-text-tertiary"
                    >
                      {draft.keys.length === allKeys.length ? 'Clear' : 'Select all'}
                    </button>
                  </div>
                  <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto pr-1">
                    {ALL_PAGES.map((page) => (
                      <button
                        key={page.key}
                        type="button"
                        disabled={admin.is_super_admin}
                        onClick={() => toggleDraftKey(admin.id, page.key)}
                        className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${draft.keys.includes(page.key) ? 'border-accent bg-accent/10 text-accent' : 'border-border-default text-text-secondary'}`}
                      >
                        {page.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-start gap-2 xl:justify-end">
                  <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-semibold ${admin.is_active ? 'border-success/20 bg-success/10 text-success' : 'border-warning/20 bg-warning/10 text-warning'}`}>
                    <CheckCircleIcon className="h-3 w-3" />
                    {admin.is_active ? 'Active' : 'Suspended'}
                  </span>
                  <button
                    onClick={() => saveAdmin(admin)}
                    disabled={savingId === admin.id || admin.is_super_admin}
                    className="h-8 rounded-lg border border-border-default px-3 text-[12px] font-semibold text-text-secondary hover:bg-bg-elevated disabled:opacity-50"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => toggleStatus(admin)}
                    disabled={savingId === admin.id || admin.id === user.id}
                    className="h-8 rounded-lg border border-border-default px-3 text-[12px] font-semibold text-text-secondary hover:bg-bg-elevated disabled:opacity-50"
                  >
                    {admin.is_active ? 'Suspend' : 'Activate'}
                  </button>
                  <button
                    onClick={() => deleteAdmin(admin)}
                    disabled={savingId === admin.id || admin.id === user.id}
                    className="inline-flex h-8 items-center gap-1 rounded-lg border border-danger/20 px-3 text-[12px] font-semibold text-danger hover:bg-danger/10 disabled:opacity-50"
                  >
                    <Trash2Icon className="h-3.5 w-3.5" />
                    Remove
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </motion.div>
  );
}
