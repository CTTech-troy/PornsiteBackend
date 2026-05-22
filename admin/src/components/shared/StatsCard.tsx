import React from 'react';
import { TrendingUpIcon, TrendingDownIcon } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface StatsCardProps {
  title: string;
  value: string | number;
  icon?: React.ComponentType<{ className?: string }>;
  trend?: string | number;
  trendLabel?: string;
  trendUp?: boolean;
  path?: string;
  color?: 'default' | 'brand' | 'blue' | 'green' | 'purple' | 'orange';
  description?: string;
}

export function StatsCard({
  title,
  value,
  icon: Icon,
  trend,
  trendLabel = 'vs last month',
  trendUp,
  path,
  description,
}: StatsCardProps) {
  const navigate = useNavigate();
  const hasValue = trend !== undefined && trend !== null && trend !== '';
  const isPositive = hasValue && (typeof trend === 'number' ? trend > 0 : String(trend).startsWith('+'));
  const isNegative = hasValue && (typeof trend === 'number' ? trend < 0 : String(trend).startsWith('-'));
  const up = trendUp !== undefined ? trendUp : isPositive;

  return (
    <div
      onClick={() => path && navigate(path)}
      className={`
        group card p-5 flex flex-col gap-3
        transition-all duration-200
        ${path ? 'cursor-pointer hover:border-border-strong hover:bg-bg-elevated' : ''}
      `}
    >
      <div className="flex items-start justify-between">
        <p className="text-[12px] font-medium text-text-tertiary uppercase tracking-wide">{title}</p>
        {Icon && (
          <Icon className="w-4 h-4 text-text-tertiary group-hover:text-text-secondary transition-colors shrink-0" />
        )}
      </div>

      <div>
        <p className="text-[28px] font-bold text-text-primary leading-none tracking-tight tabular-nums">
          {value}
        </p>
        {description && (
          <p className="text-xs text-text-tertiary mt-1">{description}</p>
        )}
      </div>

      {hasValue && (
        <div className="flex items-center gap-1.5 text-[12px]">
          {up ? (
            <TrendingUpIcon className="w-3.5 h-3.5 text-success shrink-0" />
          ) : (
            <TrendingDownIcon className="w-3.5 h-3.5 text-danger shrink-0" />
          )}
          <span className={up ? 'text-success' : isNegative ? 'text-danger' : 'text-text-tertiary'}>
            {trend}
          </span>
          <span className="text-text-tertiary">{trendLabel}</span>
        </div>
      )}
    </div>
  );
}
