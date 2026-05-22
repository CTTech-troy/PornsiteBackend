import React from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { LogOutIcon, ShieldIcon, MailIcon, ClockIcon, KeyIcon } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { ActionButton } from '../components/shared/ActionButton';

function initials(user: any) {
  const name = String(user?.name || '').trim();
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean);
    const letters = parts.slice(0, 2).map((p: string) => p[0]?.toUpperCase() || '').join('');
    if (letters) return letters;
  }
  return String(user?.email || 'AD').slice(0, 2).toUpperCase();
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="py-3 border-b border-border-subtle last:border-0">
      <p className="text-[11px] font-medium text-text-tertiary uppercase tracking-wide mb-1">{label}</p>
      <p className="text-[14px] text-text-primary font-medium">{value}</p>
    </div>
  );
}

export function Profile() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => { logout(); navigate('/login'); };

  if (!user) return null;
  const roleLabel = user.is_super_admin ? 'Super Admin' : 'Admin';

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="max-w-2xl mx-auto space-y-5"
    >
      <div>
        <h1 className="text-xl font-semibold text-text-primary">Profile</h1>
        <p className="text-[13px] text-text-tertiary mt-0.5">Your admin account</p>
      </div>

      {/* Identity card */}
      <div className="card p-6 flex items-center gap-5">
        <div className="w-14 h-14 rounded-full bg-bg-elevated border border-border-strong flex items-center justify-center text-xl font-semibold text-text-secondary shrink-0">
          {initials(user)}
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-[16px] font-semibold text-text-primary">{user.name}</h2>
          <div className="flex items-center gap-1.5 mt-0.5 text-[13px] text-text-tertiary">
            <MailIcon className="w-3.5 h-3.5" />
            <span>{user.email}</span>
          </div>
          <div className="mt-2 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium bg-accent/10 text-accent border border-accent/20">
            <ShieldIcon className="w-3 h-3" />
            {roleLabel}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* Account */}
        <div className="card p-5">
          <h3 className="text-[13px] font-semibold text-text-primary mb-3">Account</h3>
          <Field label="Full name" value={user.name} />
          <Field label="Email" value={user.email} />
          <Field label="Role" value={roleLabel} />
          <Field label="Access level" value={user.is_super_admin ? 'Full access' : 'Role-based access'} />
        </div>

        {/* Session */}
        <div className="card p-5">
          <h3 className="text-[13px] font-semibold text-text-primary mb-3">Session</h3>
          <div className="space-y-3">
            {[
              { icon: ClockIcon, title: 'Session started', sub: new Date().toLocaleDateString() },
              { icon: KeyIcon, title: 'Authentication', sub: 'JWT — expires in 7 days' },
              { icon: ShieldIcon, title: 'Security', sub: user.is_super_admin ? 'Super admin privileges' : 'Standard admin' },
            ].map(({ icon: Icon, title, sub }) => (
              <div key={title} className="flex items-start gap-3">
                <div className="w-7 h-7 rounded-md bg-bg-elevated flex items-center justify-center shrink-0">
                  <Icon className="w-3.5 h-3.5 text-text-tertiary" />
                </div>
                <div>
                  <p className="text-[13px] font-medium text-text-primary">{title}</p>
                  <p className="text-[12px] text-text-tertiary">{sub}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="card p-5">
        <h3 className="text-[13px] font-semibold text-text-primary mb-4">Actions</h3>
        <ActionButton variant="danger" icon={LogOutIcon} onClick={handleLogout}>
          Sign out
        </ActionButton>
      </div>
    </motion.div>
  );
}
