import React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeftIcon,
  PlayIcon,
  UsersIcon,
  GiftIcon,
  DollarSignIcon,
  FlagIcon,
  AlertTriangleIcon,
  StopCircleIcon,
  MessageSquareIcon } from
'lucide-react';
import { ActionButton } from '../components/shared/ActionButton';
const MOCK_CHAT = Array.from({
  length: 12
}).map((_, i) => ({
  id: i,
  user: `User${Math.floor(Math.random() * 9000) + 1000}`,
  message: [
  'Wow!',
  'This is awesome',
  'Hello from Brazil',
  'Great stream',
  'Can you do a flip?',
  'Nice!',
  '❤️❤️❤️'][
  Math.floor(Math.random() * 7)],
  time: new Date(Date.now() - (12 - i) * 15000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  })
}));
export function LiveSessionViewer() {
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
      className="space-y-6 max-w-7xl mx-auto h-[calc(100vh-8rem)] flex flex-col">
      
      <div className="flex items-center gap-4 shrink-0">
        <button
          onClick={() => navigate('/live-sessions')}
          className="p-2 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 transition-colors">
          
          <ArrowLeftIcon className="w-5 h-5" />
        </button>
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">
            Live Monitor: {id}
          </h1>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 flex-1 min-h-0">
        {/* Left Column - Video & Info */}
        <div className="lg:col-span-2 flex flex-col gap-6 min-h-0">
          {/* Video Player Mock */}
          <div className="relative w-full bg-slate-950 rounded-xl overflow-hidden aspect-video shadow-lg border border-slate-800 flex items-center justify-center group">
            <PlayIcon className="w-16 h-16 text-white/50 group-hover:text-white/80 transition-colors" />

            {/* Overlay Badges */}
            <div className="absolute top-4 left-4 flex gap-2">
              <div className="bg-brand-600 text-white text-xs font-bold px-2 py-1 rounded uppercase tracking-wider animate-pulse">
                Live
              </div>
              <div className="bg-black/60 backdrop-blur-sm text-white text-xs font-medium px-2 py-1 rounded flex items-center gap-1">
                <UsersIcon className="w-3 h-3" />
                2,451
              </div>
            </div>
            <div className="absolute bottom-4 right-4 bg-black/60 backdrop-blur-sm text-white text-xs font-medium px-2 py-1 rounded">
              01:24:05
            </div>
          </div>

          {/* Stream Info */}
          <div className="card p-6 shrink-0">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-4">
                <img
                  src="https://i.pravatar.cc/150?u=creator1"
                  alt="Creator"
                  className="w-12 h-12 rounded-full object-cover" />
                
                <div>
                  <h2 className="text-lg font-bold text-slate-900 dark:text-white">
                    Late Night Chat & Gaming
                  </h2>
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    Creator 1 • Started at 10:30 PM
                  </p>
                </div>
              </div>
              <div className="flex gap-4 text-center">
                <div>
                  <div className="text-xs text-slate-500 uppercase tracking-wider">
                    Gifts
                  </div>
                  <div className="font-bold text-slate-900 dark:text-white flex items-center gap-1 justify-center">
                    <GiftIcon className="w-4 h-4 text-brand-500" /> 142
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500 uppercase tracking-wider">
                    Revenue
                  </div>
                  <div className="font-bold text-slate-900 dark:text-white flex items-center gap-1 justify-center">
                    <DollarSignIcon className="w-4 h-4 text-emerald-500" />{' '}
                    $450.20
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column - Chat & Actions */}
        <div className="flex flex-col gap-6 min-h-0">
          {/* Admin Actions */}
          <div className="card p-4 shrink-0 border-brand-500/30">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white mb-3 flex items-center gap-2">
              <AlertTriangleIcon className="w-4 h-4 text-brand-500" />
              Moderation Actions
            </h3>
            <div className="grid grid-cols-2 gap-2">
              <ActionButton
                variant="danger"
                icon={StopCircleIcon}
                className="justify-center text-xs py-2">
                
                End Stream
              </ActionButton>
              <ActionButton
                variant="warning"
                icon={AlertTriangleIcon}
                className="justify-center text-xs py-2">
                
                Warn Creator
              </ActionButton>
              <ActionButton
                variant="secondary"
                icon={FlagIcon}
                className="justify-center text-xs py-2 col-span-2">
                
                Flag Content
              </ActionButton>
            </div>
          </div>

          {/* Live Chat */}
          <div className="card flex flex-col flex-1 min-h-0 overflow-hidden">
            <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2 shrink-0">
              <MessageSquareIcon className="w-4 h-4 text-slate-500" />
              <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
                Live Chat Monitor
              </h3>
            </div>
            <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-3">
              {MOCK_CHAT.map((chat) =>
              <div
                key={chat.id}
                className="group flex items-start gap-2 text-sm">
                
                  <span className="text-xs text-slate-400 shrink-0 mt-0.5">
                    {chat.time}
                  </span>
                  <div className="flex-1">
                    <span className="font-medium text-slate-700 dark:text-slate-300 mr-2">
                      {chat.user}:
                    </span>
                    <span className="text-slate-600 dark:text-slate-400">
                      {chat.message}
                    </span>
                  </div>
                  <button className="opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-brand-500 transition-all shrink-0">
                    <FlagIcon className="w-3 h-3" />
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </motion.div>);

}