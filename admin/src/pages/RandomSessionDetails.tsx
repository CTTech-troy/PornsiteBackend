import React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeftIcon,
  VideoIcon,
  FlagIcon,
  BanIcon,
  ShieldAlertIcon,
  ClockIcon,
  MessageSquareIcon } from
'lucide-react';
import { StatusBadge } from '../components/shared/StatusBadge';
import { ActionButton } from '../components/shared/ActionButton';
// --- MOCK DATA ---
const MOCK_CHAT = Array.from({
  length: 20
}).map((_, i) => ({
  id: `msg-${i}`,
  sender: Math.random() > 0.5 ? 'UserA_123' : 'UserB_456',
  message: [
  'Hello!',
  'How are you?',
  'Where are you from?',
  'Nice to meet you.',
  'Can you hear me?'][
  Math.floor(Math.random() * 5)],
  timestamp: new Date(Date.now() - Math.random() * 1800000).toISOString()
}));
const MOCK_REPORTS = [
{
  id: 'rep-1',
  reporter: 'UserA_123',
  reason: 'Inappropriate behavior',
  timestamp: new Date(Date.now() - 600000).toISOString()
}];

export function RandomSessionDetails() {
  const { id } = useParams();
  const navigate = useNavigate();
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
      className="max-w-5xl mx-auto space-y-6">
      
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigate('/random-sessions')}
            className="p-2 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 bg-white dark:bg-dark-card rounded-lg border border-gray-200 dark:border-dark-border shadow-sm">
            
            <ArrowLeftIcon className="w-5 h-5" />
          </button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
                Session Details
              </h1>
              <StatusBadge status="Flagged" color="yellow" />
            </div>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              Session ID: {id}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <ActionButton variant="warning" icon={FlagIcon}>
            Flag Session
          </ActionButton>
          <ActionButton variant="danger" icon={BanIcon}>
            Ban User A
          </ActionButton>
          <ActionButton variant="danger" icon={BanIcon}>
            Ban User B
          </ActionButton>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column */}
        <div className="lg:col-span-2 space-y-6">
          {/* Users Info */}
          <div className="bg-white dark:bg-dark-card rounded-xl shadow-sm border border-gray-200 dark:border-dark-border p-6">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-6">
              Connected Users
            </h3>
            <div className="flex items-center justify-between">
              <div className="flex flex-col items-center gap-3">
                <img
                  src="https://i.pravatar.cc/150?u=usera"
                  alt="User A"
                  className="w-20 h-20 rounded-full border-4 border-gray-100 dark:border-slate-800" />
                
                <div className="text-center">
                  <p className="font-medium text-gray-900 dark:text-white">
                    UserA_123
                  </p>
                  <p className="text-sm text-gray-500">ID: usr_8923</p>
                </div>
                <ActionButton variant="ghost" size="sm">
                  View Profile
                </ActionButton>
              </div>

              <div className="flex flex-col items-center gap-2">
                <div className="w-12 h-12 rounded-full bg-gray-100 dark:bg-slate-800 flex items-center justify-center">
                  <VideoIcon className="w-6 h-6 text-gray-400" />
                </div>
                <span className="text-sm font-medium text-gray-500">
                  14m 23s
                </span>
              </div>

              <div className="flex flex-col items-center gap-3">
                <img
                  src="https://i.pravatar.cc/150?u=userb"
                  alt="User B"
                  className="w-20 h-20 rounded-full border-4 border-gray-100 dark:border-slate-800" />
                
                <div className="text-center">
                  <p className="font-medium text-gray-900 dark:text-white">
                    UserB_456
                  </p>
                  <p className="text-sm text-gray-500">ID: usr_1045</p>
                </div>
                <ActionButton variant="ghost" size="sm">
                  View Profile
                </ActionButton>
              </div>
            </div>
          </div>

          {/* Chat Log */}
          <div className="bg-white dark:bg-dark-card rounded-xl shadow-sm border border-gray-200 dark:border-dark-border overflow-hidden flex flex-col h-[500px]">
            <div className="p-4 border-b border-gray-200 dark:border-dark-border bg-gray-50 dark:bg-slate-800/50 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <MessageSquareIcon className="w-5 h-5 text-gray-500" />
                <h3 className="font-semibold text-gray-900 dark:text-white">
                  Chat Log
                </h3>
              </div>
              <span className="text-xs text-gray-500 bg-gray-200 dark:bg-slate-700 px-2 py-1 rounded">
                For moderation only
              </span>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
              {MOCK_CHAT.map((msg) =>
              <div
                key={msg.id}
                className={`flex flex-col ${msg.sender === 'UserA_123' ? 'items-start' : 'items-end'}`}>
                
                  <span className="text-xs text-gray-500 mb-1">
                    {msg.sender} •{' '}
                    {new Date(msg.timestamp).toLocaleTimeString()}
                  </span>
                  <div
                  className={`px-4 py-2 rounded-2xl max-w-[80%] ${msg.sender === 'UserA_123' ? 'bg-gray-100 dark:bg-slate-800 text-gray-900 dark:text-white rounded-tl-none' : 'bg-brand-500 text-white rounded-tr-none'}`}>
                  
                    {msg.message}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right Column */}
        <div className="space-y-6">
          {/* Session Info */}
          <div className="bg-white dark:bg-dark-card rounded-xl shadow-sm border border-gray-200 dark:border-dark-border p-6">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
              Session Info
            </h3>
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-gray-500 dark:text-gray-400 flex items-center gap-2">
                  <ClockIcon className="w-4 h-4" /> Start Time
                </span>
                <span className="font-medium text-gray-900 dark:text-white">
                  10:23 PM
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-500 dark:text-gray-400 flex items-center gap-2">
                  <ClockIcon className="w-4 h-4" /> End Time
                </span>
                <span className="font-medium text-gray-900 dark:text-white">
                  10:37 PM
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-500 dark:text-gray-400">
                  Duration
                </span>
                <span className="font-medium text-gray-900 dark:text-white">
                  14m 23s
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-500 dark:text-gray-400">
                  Connection
                </span>
                <span className="text-green-500 font-medium">Good</span>
              </div>
            </div>
          </div>

          {/* Safety flags */}
          <div className="bg-white dark:bg-dark-card rounded-xl shadow-sm border border-red-200 dark:border-red-900/30 p-6">
            <div className="flex items-center gap-2 mb-4 text-red-600 dark:text-red-400">
              <ShieldAlertIcon className="w-5 h-5" />
              <h3 className="text-lg font-semibold">Safety Flags (1)</h3>
            </div>
            <div className="space-y-4">
              {MOCK_REPORTS.map((report) =>
              <div
                key={report.id}
                className="bg-red-50 dark:bg-red-900/10 p-4 rounded-lg border border-red-100 dark:border-red-900/20">
                
                  <div className="flex justify-between items-start mb-2">
                    <span className="font-medium text-red-800 dark:text-red-300">
                      Reported by {report.reporter}
                    </span>
                    <span className="text-xs text-red-600 dark:text-red-400">
                      {new Date(report.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                  <p className="text-sm text-red-700 dark:text-red-400">
                    {report.reason}
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Admin Notes */}
          <div className="bg-white dark:bg-dark-card rounded-xl shadow-sm border border-gray-200 dark:border-dark-border p-6">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
              Admin Notes
            </h3>
            <textarea
              className="input-field min-h-[100px] mb-3"
              placeholder="Add a note about this session...">
            </textarea>
            <ActionButton className="w-full">Save Note</ActionButton>
          </div>
        </div>
      </div>
    </motion.div>);

}
