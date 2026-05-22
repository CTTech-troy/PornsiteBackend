import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { PlaySquareIcon, LogInIcon, AlertCircleIcon, ShieldIcon, CheckCircleIcon, EyeIcon, EyeOffIcon } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { ActionButton } from '../components/shared/ActionButton';
import { API_BASE, apiMessage, readApiResponse } from '../api/http';

type Mode = 'login' | 'setup';

function PasswordInput({ value, onChange, placeholder, autoComplete }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoComplete?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input
        type={show ? 'text' : 'password'}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        className="input-field pr-10"
      />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setShow(s => !s)}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary transition-colors"
      >
        {show ? <EyeOffIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />}
      </button>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <label className="block text-[12px] font-medium text-text-secondary mb-1.5">{children}</label>;
}

export function Login() {
  const { login, isLoading } = useAuth();
  const navigate = useNavigate();

  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [setupName, setSetupName] = useState('');
  const [setupEmail, setSetupEmail] = useState('');
  const [setupPassword, setSetupPassword] = useState('');
  const [setupSecret, setSetupSecret] = useState('');
  const [setupLoading, setSetupLoading] = useState(false);
  const [setupSuccess, setSetupSuccess] = useState('');
  const [error, setError] = useState('');

  const switchMode = (m: Mode) => { setMode(m); setError(''); setSetupSuccess(''); };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!email || !password) { setError('Email and password are required'); return; }
    try {
      await login(email, password);
      navigate('/');
    } catch (err) {
      setError((err as Error)?.message || 'Invalid credentials');
    }
  };

  const handleSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setSetupSuccess('');
    if (!setupName.trim() || !setupEmail || !setupPassword || !setupSecret) {
      setError('All fields are required'); return;
    }
    if (setupPassword.length < 8) { setError('Password must be at least 8 characters'); return; }
    setSetupLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/admin/auth/founder-create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-bootstrap-secret': setupSecret },
        body: JSON.stringify({ name: setupName.trim(), email: setupEmail, password: setupPassword }),
      });
      const data = await readApiResponse<Record<string, any>>(res);
      if (!res.ok) throw new Error(apiMessage(data, 'Setup failed'));
      setSetupSuccess(`Account created. Signing you in as ${data.email}`);
      setEmail(setupEmail);
      setTimeout(() => switchMode('login'), 2000);
    } catch (err) {
      setError((err as Error)?.message || 'Setup failed');
    } finally {
      setSetupLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-bg-base flex flex-col items-center justify-center p-4">
      {/* Subtle grid bg */}
      <div
        className="absolute inset-0 opacity-[0.02] pointer-events-none"
        style={{
          backgroundImage: 'linear-gradient(#ffffff 1px, transparent 1px), linear-gradient(90deg, #ffffff 1px, transparent 1px)',
          backgroundSize: '40px 40px',
        }}
      />

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
        className="relative w-full max-w-[380px]"
      >
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-white mb-4">
            <PlaySquareIcon className="w-5 h-5 text-black" strokeWidth={2.5} />
          </div>
          <h1 className="text-xl font-semibold text-text-primary tracking-tight">Xstream Admin</h1>
          <p className="text-[13px] text-text-tertiary mt-1">
            {mode === 'login' ? 'Sign in to your workspace' : 'Create the first super admin'}
          </p>
        </div>

        <div className="card p-6">
          {/* Mode tabs */}
          <div className="flex gap-1.5 mb-5 p-1 bg-bg-elevated rounded-lg">
            {(['login', 'setup'] as const).map(m => (
              <button
                key={m}
                onClick={() => switchMode(m)}
                className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-[12px] font-medium transition-all duration-150 ${
                  mode === m
                    ? 'bg-white text-black shadow-sm'
                    : 'text-text-tertiary hover:text-text-secondary'
                }`}
              >
                {m === 'setup' && <ShieldIcon className="w-3 h-3" />}
                {m === 'login' ? 'Sign In' : 'First-time Setup'}
              </button>
            ))}
          </div>

          {/* Alerts */}
          {error && (
            <div className="mb-4 flex items-start gap-2 px-3 py-2.5 rounded-md bg-danger/10 border border-danger/20 text-danger text-[12px]">
              <AlertCircleIcon className="w-4 h-4 shrink-0 mt-0.5" />
              {error}
            </div>
          )}
          {setupSuccess && (
            <div className="mb-4 flex items-start gap-2 px-3 py-2.5 rounded-md bg-success/10 border border-success/20 text-success text-[12px]">
              <CheckCircleIcon className="w-4 h-4 shrink-0 mt-0.5" />
              {setupSuccess}
            </div>
          )}

          {mode === 'login' ? (
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <Label>Email address</Label>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  className="input-field"
                  placeholder="admin@xstream.com"
                  autoComplete="email"
                  autoFocus
                />
              </div>
              <div>
                <Label>Password</Label>
                <PasswordInput
                  value={password}
                  onChange={setPassword}
                  placeholder="••••••••"
                  autoComplete="current-password"
                />
              </div>
              <ActionButton
                variant="primary"
                className="w-full h-9 justify-center mt-1"
                icon={LogInIcon}
                type="submit"
                isLoading={isLoading}
              >
                {isLoading ? 'Signing in…' : 'Sign In'}
              </ActionButton>
              <p className="text-[11px] text-center text-text-tertiary">
                No access? Ask a Super Admin to invite you.
              </p>
            </form>
          ) : (
            <form onSubmit={handleSetup} className="space-y-4">
              <div className="p-3 rounded-md bg-warning/10 border border-warning/20 text-warning text-[12px] leading-relaxed">
                <strong>One-time setup.</strong> Requires the <code className="font-mono bg-bg-elevated px-1 rounded text-[11px]">ADMIN_BOOTSTRAP_SECRET</code> env var.
              </div>
              <div>
                <Label>Full name</Label>
                <input type="text" value={setupName} onChange={e => setSetupName(e.target.value)} className="input-field" placeholder="John Doe" />
              </div>
              <div>
                <Label>Email address</Label>
                <input type="email" value={setupEmail} onChange={e => setSetupEmail(e.target.value)} className="input-field" placeholder="admin@xstream.com" />
              </div>
              <div>
                <Label>Password <span className="font-normal text-text-tertiary">(min. 8 chars)</span></Label>
                <PasswordInput value={setupPassword} onChange={setSetupPassword} placeholder="••••••••" autoComplete="new-password" />
              </div>
              <div>
                <Label>Bootstrap secret</Label>
                <PasswordInput value={setupSecret} onChange={setSetupSecret} placeholder="••••••••••••" />
              </div>
              <ActionButton
                variant="primary"
                className="w-full h-9 justify-center mt-1"
                icon={ShieldIcon}
                type="submit"
                isLoading={setupLoading}
              >
                {setupLoading ? 'Creating…' : 'Create Super Admin'}
              </ActionButton>
              <p className="text-[11px] text-center text-text-tertiary">
                Blocked if a super admin already exists.
              </p>
            </form>
          )}
        </div>

        <p className="mt-4 text-center text-[11px] text-text-disabled">
          First run? <code className="font-mono">node apply-admin-migration.js</code>
        </p>
      </motion.div>
    </div>
  );
}
