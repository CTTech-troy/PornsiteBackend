-- Admin users table
create table if not exists admin_users (
  id uuid primary key default gen_random_uuid(),
  name text,
  email text unique not null,
  password_hash text,
  permissions text[] not null default '{}',
  is_active boolean default false,
  is_super_admin boolean default false,
  last_login timestamptz,
  created_at timestamptz default now(),
  created_by uuid references admin_users(id) on delete set null
);

-- Admin invite tokens table
create table if not exists admin_invites (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  name text,
  permissions text[] not null default '{}',
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_by uuid references admin_users(id) on delete set null,
  created_at timestamptz default now()
);
