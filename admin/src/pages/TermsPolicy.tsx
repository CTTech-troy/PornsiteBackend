import React from 'react';
import { motion } from 'framer-motion';
import { FileCheckIcon, SaveIcon, EyeIcon } from 'lucide-react';
import { ActionButton } from '../components/shared/ActionButton';
export function TermsPolicy() {
  return (
    <motion.div
      initial={{
        opacity: 0,
        y: 20
      }}
      animate={{
        opacity: 1,
        y: 0
      }}
      className="space-y-6 max-w-4xl mx-auto">
      
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">
            Terms & Policy
          </h1>
          <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">
            Manage legal content and guidelines
          </p>
        </div>
        <div className="flex gap-2">
          <ActionButton variant="secondary" icon={EyeIcon}>
            Preview
          </ActionButton>
          <ActionButton variant="primary" icon={SaveIcon}>
            Publish Changes
          </ActionButton>
        </div>
      </div>

      <div className="card p-6">
        <div className="mb-4">
          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
            Select Document
          </label>
          <select className="input-field">
            <option>Terms and Conditions</option>
            <option>Privacy Policy</option>
            <option>Creator Policy</option>
            <option>Community Guidelines</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
            Content Editor
          </label>
          <textarea
            className="input-field min-h-[400px] font-mono text-sm"
            defaultValue="# Terms and Conditions&#10;&#10;Welcome to Xstream Videos..." />
          
        </div>

        <div className="mt-4 flex items-center justify-between text-sm text-slate-500">
          <span>Last updated: Oct 24, 2023</span>
          <span>Edited by: Super Admin</span>
        </div>
      </div>
    </motion.div>);

}