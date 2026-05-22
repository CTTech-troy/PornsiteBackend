import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { AlertCircleIcon, CheckCircle2Icon, Loader2Icon, PlaySquareIcon, EyeIcon, EyeOffIcon } from 'lucide-react';
import { ActionButton } from '../components/shared/ActionButton';
import { API_BASE, apiMessage, readApiResponse } from '../api/http';

interface InviteDetails {
  email: string;
  name: string | null;
  permissions: string[];
}

function PasswordInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input
        type={show ? 'text' : 'password'}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
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

export function InviteComplete() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = useMemo(() => params.get('token') || '', [params]);

  const [isVerifying, setIsVerifying] = useState(true);
  const [verifyError, setVerifyError] = useState<string>('');
  const [invite, setInvite] = useState<InviteDetails | null>(null);

  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [submitSuccess, setSubmitSuccess] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!token) { setVerifyError('Missing invite token.'); setIsVerifying(false); return; }
      setIsVerifying(true); setVerifyError('');
      try {
        const res = await fetch(`${API_BASE}/api/admin/invite/verify/${encodeURIComponent(token)}`);
        const data = await readApiResponse<Record<string, any>>(res);
        if (!res.ok) throw new Error(apiMessage(data, 'Failed to verify invitation'));
        if (cancelled) return;
        setInvite({ email: data.email, name: data.name ?? null, permissions: Array.isArray(data.permissions) ? data.permissions : [] });
        setFullName(String(data.name || '').trim());
      } catch (err) {
        if (cancelled) return;
        setVerifyError((err as Error)?.message || 'Failed to verify invitation');
      } finally {
        if (!cancelled) setIsVerifying(false);
      }
    }
    run();
    return () => { cancelled = true; };
  }, [token]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(''); setSubmitSuccess('');
    if (!token || !invite) return;
    if (!fullName.trim() || !password || !confirmPassword) { setSubmitError('Please complete all fields.'); return; }
    if (password !== confirmPassword) { setSubmitError('Passwords do not match.'); return; }
    if (password.length < 8) { setSubmitError('Password must be at least 8 characters.'); return; }

    setIsSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/admin/invite/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, name: fullName.trim(), password, confirmPassword }),
      });
      const data = await readApiResponse<Record<string, any>>(res);
      if (!res.ok) throw new Error(apiMessage(data, 'Failed to create account'));
      setSubmitSuccess('Account created! Redirecting to login...');
      setTimeout(() => navigate('/login', { replace: true }), 2000);
    } catch (err) {
      setSubmitError((err as Error)?.message || 'Failed to create account');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-bg-base flex flex-col items-center justify-center p-4">
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
        className="relative w-full max-w-[400px]"
      >
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-white mb-4">
            <PlaySquareIcon className="w-5 h-5 text-black" strokeWidth={2.5} />
          </div>
          <h1 className="text-xl font-semibold text-text-primary tracking-tight">Complete your invite</h1>
          <p className="text-[13px] text-text-tertiary mt-1">Create your admin account to continue.</p>
        </div>

        <div className="card p-6">
          {isVerifying && (
            <div className="flex items-center gap-3 text-text-secondary text-[13px]">
              <Loader2Icon className="w-4 h-4 animate-spin text-text-tertiary" />
              Verifying invitation…
            </div>
          )}

          {!isVerifying && verifyError && (
            <div className="flex items-start gap-2 px-3 py-2.5 rounded-md bg-danger/10 border border-danger/20 text-danger text-[12px]">
              <AlertCircleIcon className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold mb-0.5">Invitation error</div>
                <div>{verifyError}</div>
              </div>
            </div>
          )}

          {!isVerifying && invite && !verifyError && (
            <form onSubmit={onSubmit} className="space-y-4">
              {submitError && (
                <div className="flex items-start gap-2 px-3 py-2.5 rounded-md bg-danger/10 border border-danger/20 text-danger text-[12px]">
                  <AlertCircleIcon className="w-4 h-4 shrink-0 mt-0.5" />
                  {submitError}
                </div>
              )}
              {submitSuccess && (
                <div className="flex items-start gap-2 px-3 py-2.5 rounded-md bg-success/10 border border-success/20 text-success text-[12px]">
                  <CheckCircle2Icon className="w-4 h-4 shrink-0 mt-0.5" />
                  {submitSuccess}
                </div>
              )}

              <div>
                <Label>Full Name</Label>
                <input type="text" value={fullName} onChange={(e) => setFullName(e.target.value)}
                  className="input-field" placeholder="Your name" autoFocus />
              </div>
              <div>
                <Label>Email</Label>
                <input type="email" value={invite.email} readOnly className="input-field opacity-60 cursor-not-allowed" />
              </div>
              <div>
                <Label>Password <span className="font-normal text-text-tertiary">(min. 8 chars)</span></Label>
                <PasswordInput value={password} onChange={setPassword} placeholder="••••••••" />
              </div>
              <div>
                <Label>Confirm Password</Label>
                <PasswordInput value={confirmPassword} onChange={setConfirmPassword} placeholder="••••••••" />
              </div>

              <ActionButton
                variant="primary"
                className="w-full h-9 justify-center mt-1"
                type="submit"
                isLoading={isSubmitting}
              >
                {isSubmitting ? 'Creating account…' : 'Create Account'}
              </ActionButton>
            </form>
          )}
        </div>
      </motion.div>
    </div>
  );
}
