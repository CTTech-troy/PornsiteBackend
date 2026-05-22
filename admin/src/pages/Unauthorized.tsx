import React from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ShieldOffIcon } from 'lucide-react';
import { ActionButton } from '../components/shared/ActionButton';

export function Unauthorized() {
  const navigate = useNavigate();
  return (
    <div className="min-h-screen flex items-center justify-center bg-bg-base">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
        className="text-center p-8"
      >
        <div className="w-14 h-14 rounded-full bg-danger/10 border border-danger/20 flex items-center justify-center mx-auto mb-5">
          <ShieldOffIcon className="w-6 h-6 text-danger" />
        </div>
        <h1 className="text-xl font-semibold text-text-primary mb-2">Access Denied</h1>
        <p className="text-[13px] text-text-tertiary mb-6 max-w-xs mx-auto">
          You don't have permission to view this page.
        </p>
        <ActionButton variant="primary" onClick={() => navigate('/')}>Go to Dashboard</ActionButton>
      </motion.div>
    </div>
  );
}
