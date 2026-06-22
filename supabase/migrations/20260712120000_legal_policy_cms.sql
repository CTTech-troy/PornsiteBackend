create extension if not exists pgcrypto;

create table if not exists public.legal_documents (
  id uuid primary key default gen_random_uuid(),
  document_key text not null unique,
  slug text not null unique,
  title text not null,
  description text,
  category text not null default 'Legal',
  status text not null default 'draft' check (status in ('draft', 'published', 'scheduled', 'archived')),
  content_html text not null default '',
  content_text text not null default '',
  seo jsonb not null default '{}'::jsonb,
  require_reacceptance boolean not null default false,
  update_banner_enabled boolean not null default false,
  update_summary text,
  scheduled_publish_at timestamptz,
  published_at timestamptz,
  archived_at timestamptz,
  current_version_id uuid,
  version_number integer not null default 0,
  created_by uuid,
  created_by_email text,
  updated_by uuid,
  updated_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.legal_document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.legal_documents(id) on delete cascade,
  version_number integer not null,
  status text not null check (status in ('draft', 'published', 'scheduled', 'archived')),
  title text not null,
  slug text not null,
  description text,
  category text not null default 'Legal',
  content_html text not null default '',
  content_text text not null default '',
  seo jsonb not null default '{}'::jsonb,
  require_reacceptance boolean not null default false,
  update_banner_enabled boolean not null default false,
  update_summary text,
  scheduled_publish_at timestamptz,
  published_at timestamptz,
  change_notes text,
  author_id uuid,
  author_email text,
  author_name text,
  created_at timestamptz not null default now(),
  unique(document_id, version_number)
);

create table if not exists public.legal_policy_acceptances (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references public.legal_documents(id) on delete set null,
  version_id uuid references public.legal_document_versions(id) on delete set null,
  document_key text not null,
  version_number integer not null,
  user_id text not null,
  session_id text,
  ip_hash text,
  device_info jsonb not null default '{}'::jsonb,
  accepted_at timestamptz not null default now(),
  unique(document_key, version_number, user_id)
);

create table if not exists public.legal_policy_notifications (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references public.legal_documents(id) on delete cascade,
  version_id uuid references public.legal_document_versions(id) on delete cascade,
  document_key text not null,
  version_number integer not null,
  title text not null,
  message text,
  audience text not null default 'all' check (audience in ('all', 'users', 'creators')),
  require_reacceptance boolean not null default false,
  banner_enabled boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists idx_legal_documents_status on public.legal_documents(status);
create index if not exists idx_legal_documents_slug on public.legal_documents(slug);
create index if not exists idx_legal_documents_updated_at on public.legal_documents(updated_at desc);
create index if not exists idx_legal_documents_scheduled on public.legal_documents(scheduled_publish_at) where status = 'scheduled';
create index if not exists idx_legal_versions_document_created on public.legal_document_versions(document_id, created_at desc);
create index if not exists idx_legal_acceptances_user on public.legal_policy_acceptances(user_id, accepted_at desc);
create index if not exists idx_legal_acceptances_document on public.legal_policy_acceptances(document_key, version_number);
create index if not exists idx_legal_notifications_active on public.legal_policy_notifications(active, banner_enabled, created_at desc);

create or replace function public.set_legal_documents_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_legal_documents_updated_at on public.legal_documents;
create trigger trg_legal_documents_updated_at
before update on public.legal_documents
for each row
execute function public.set_legal_documents_updated_at();

alter table public.legal_documents enable row level security;
alter table public.legal_document_versions enable row level security;
alter table public.legal_policy_acceptances enable row level security;
alter table public.legal_policy_notifications enable row level security;

drop policy if exists "Public can read published legal documents" on public.legal_documents;
create policy "Public can read published legal documents"
on public.legal_documents
for select
using (status = 'published');

drop policy if exists "Public can read published legal versions" on public.legal_document_versions;
create policy "Public can read published legal versions"
on public.legal_document_versions
for select
using (status = 'published');

drop policy if exists "Public can read active legal notifications" on public.legal_policy_notifications;
create policy "Public can read active legal notifications"
on public.legal_policy_notifications
for select
using (active = true);

with seed(document_key, slug, title, description, category, content_html, content_text, seo) as (
  values
  (
    'terms',
    'terms',
    'Terms of Service',
    'Rules and terms for using XstreamVideos.',
    'Core Policy',
    $html$
      <h2>Introduction</h2>
      <p>Welcome to XstreamVideos. These Terms of Service explain the rules for accessing, viewing, uploading, purchasing, and interacting with content on the platform.</p>
      <h2>Eligibility</h2>
      <p>You must be at least 18 years old, or the age of majority in your jurisdiction if higher, to access this platform.</p>
      <h2>Accounts</h2>
      <p>You are responsible for keeping your account credentials secure and for all activity that happens under your account.</p>
      <h2>Content And Conduct</h2>
      <p>Users and creators may only upload or share lawful content they own or are legally authorized to publish. Prohibited conduct includes abuse, harassment, fraud, spam, and attempts to bypass platform safety systems.</p>
      <h2>Termination</h2>
      <p>We may suspend or terminate accounts that violate these terms, applicable laws, or platform policies.</p>
    $html$,
    'Welcome to XstreamVideos. These Terms of Service explain the rules for using the platform. Users must be adults, keep accounts secure, publish only authorized content, follow conduct rules, and may be suspended for violations.',
    jsonb_build_object('pageTitle', 'Terms of Service | XstreamVideos', 'metaTitle', 'Terms of Service', 'metaDescription', 'Read the XstreamVideos Terms of Service.', 'canonicalUrl', '/terms')
  ),
  (
    'privacy-policy',
    'privacy-policy',
    'Privacy Policy',
    'How XstreamVideos collects, uses, stores, and protects data.',
    'Privacy',
    $html$
      <h2>Overview</h2>
      <p>This Privacy Policy explains what information we collect, why we collect it, and how we protect it.</p>
      <h2>Information We Collect</h2>
      <p>We may collect account information, usage data, device information, payment metadata, content interactions, and communications submitted through the platform.</p>
      <h2>How We Use Information</h2>
      <p>We use information to operate the platform, process transactions, improve safety, personalize experiences, provide support, and meet legal obligations.</p>
      <h2>Data Sharing</h2>
      <p>We may share limited data with service providers, payment processors, moderation tools, analytics systems, or legal authorities when required.</p>
      <h2>Your Choices</h2>
      <p>You can update account information, adjust cookie settings, and contact support about privacy requests.</p>
    $html$,
    'This Privacy Policy explains what information we collect, why we collect it, how we use it, when data may be shared, and the privacy choices available to users.',
    jsonb_build_object('pageTitle', 'Privacy Policy | XstreamVideos', 'metaTitle', 'Privacy Policy', 'metaDescription', 'Learn how XstreamVideos handles privacy and user data.', 'canonicalUrl', '/privacy-policy')
  ),
  (
    'privacy-notice',
    'privacy-notice',
    'Privacy Notice',
    'A concise notice about privacy practices and user controls.',
    'Privacy',
    $html$
      <h2>Privacy At A Glance</h2>
      <p>This notice summarizes how we process personal information on XstreamVideos.</p>
      <h2>Personal Information</h2>
      <p>We process information needed for accounts, creator tools, payments, moderation, security, analytics, and customer support.</p>
      <h2>Legal Bases</h2>
      <p>We process information to perform services, comply with legal obligations, protect platform integrity, and support legitimate business interests.</p>
      <h2>Retention</h2>
      <p>We retain information only for as long as needed for service delivery, legal compliance, safety, dispute resolution, and recordkeeping.</p>
    $html$,
    'This Privacy Notice summarizes personal information processing, legal bases, and retention practices.',
    jsonb_build_object('pageTitle', 'Privacy Notice | XstreamVideos', 'metaTitle', 'Privacy Notice', 'metaDescription', 'Review the XstreamVideos privacy notice.', 'canonicalUrl', '/privacy-notice')
  ),
  (
    'cookies',
    'cookies',
    'Cookie Policy',
    'How cookies and similar technologies are used.',
    'Privacy',
    $html$
      <h2>Cookie Use</h2>
      <p>We use cookies and similar technologies to keep users signed in, remember preferences, measure platform performance, and improve safety.</p>
      <h2>Types Of Cookies</h2>
      <ul><li>Essential cookies for login and security.</li><li>Analytics cookies for aggregate usage insights.</li><li>Preference cookies for saved settings.</li></ul>
      <h2>Managing Cookies</h2>
      <p>You can manage browser-level cookie preferences and platform cookie choices where available.</p>
    $html$,
    'We use essential, analytics, and preference cookies to operate and improve XstreamVideos. Users can manage cookie preferences through browser or platform controls.',
    jsonb_build_object('pageTitle', 'Cookie Policy | XstreamVideos', 'metaTitle', 'Cookie Policy', 'metaDescription', 'Understand how XstreamVideos uses cookies.', 'canonicalUrl', '/cookies')
  ),
  (
    'community-guidelines',
    'community-guidelines',
    'Community Guidelines',
    'Rules for safe and respectful participation.',
    'Community',
    $html$
      <h2>Community Standards</h2>
      <p>Everyone using XstreamVideos must follow rules that protect safety, consent, privacy, and lawful participation.</p>
      <h2>Prohibited Behavior</h2>
      <p>Harassment, threats, impersonation, doxxing, illegal content, spam, fraud, and non-consensual activity are prohibited.</p>
      <h2>Enforcement</h2>
      <p>Violations may lead to content removal, account limits, suspension, termination, or reporting to authorities where appropriate.</p>
    $html$,
    'Community Guidelines describe required behavior, prohibited conduct, and enforcement actions.',
    jsonb_build_object('pageTitle', 'Community Guidelines | XstreamVideos', 'metaTitle', 'Community Guidelines', 'metaDescription', 'Read XstreamVideos community standards.', 'canonicalUrl', '/community-guidelines')
  ),
  (
    'content-policy',
    'content-policy',
    'Content Policy',
    'Policy for content uploads, moderation, and removals.',
    'Creator Policy',
    $html$
      <h2>Content Requirements</h2>
      <p>Creators must own or have legal authorization for all uploaded content and must comply with applicable law and platform rules.</p>
      <h2>Restricted Content</h2>
      <p>Illegal, non-consensual, exploitative, deceptive, or otherwise prohibited content is not allowed.</p>
      <h2>Moderation</h2>
      <p>We may review, restrict, demonetize, remove, or report content that violates this policy.</p>
    $html$,
    'Creators must upload only lawful authorized content. Restricted content may be removed or reported.',
    jsonb_build_object('pageTitle', 'Content Policy | XstreamVideos', 'metaTitle', 'Content Policy', 'metaDescription', 'Review the XstreamVideos content policy.', 'canonicalUrl', '/content-policy')
  ),
  (
    'creator-agreement',
    'creator-agreement',
    'Creator Agreement',
    'Terms for creators publishing and monetizing content.',
    'Creator Policy',
    $html$
      <h2>Creator Eligibility</h2>
      <p>Creators must complete required verification and provide accurate account, identity, payment, and tax information where requested.</p>
      <h2>Ownership And Authorization</h2>
      <p>Creators represent that they own or are legally authorized to publish all submitted content.</p>
      <h2>Monetization</h2>
      <p>Creator earnings, payouts, fees, refunds, chargebacks, and account limits are handled according to platform rules and applicable payment provider requirements.</p>
    $html$,
    'The Creator Agreement covers eligibility, ownership, authorization, monetization, and payout responsibilities.',
    jsonb_build_object('pageTitle', 'Creator Agreement | XstreamVideos', 'metaTitle', 'Creator Agreement', 'metaDescription', 'Read the XstreamVideos creator agreement.', 'canonicalUrl', '/creator-agreement')
  ),
  (
    'refund-policy',
    'refund-policy',
    'Refund Policy',
    'Rules for refund requests, chargebacks, and paid content.',
    'Payments',
    $html$
      <h2>Refund Requests</h2>
      <p>Refund eligibility depends on the transaction type, content access status, provider rules, and applicable law.</p>
      <h2>Digital Content</h2>
      <p>Because digital content may be available immediately after purchase, some transactions may be final once access begins.</p>
      <h2>Chargebacks</h2>
      <p>Chargeback misuse may result in account review, payment restrictions, or suspension.</p>
    $html$,
    'Refund eligibility depends on transaction type, access status, payment provider rules, and applicable law.',
    jsonb_build_object('pageTitle', 'Refund Policy | XstreamVideos', 'metaTitle', 'Refund Policy', 'metaDescription', 'Review XstreamVideos refund rules.', 'canonicalUrl', '/refund-policy')
  ),
  (
    'age-verification-policy',
    'age-verification-policy',
    'Age Verification Policy',
    'Adult access and verification requirements.',
    'Safety',
    $html$
      <h2>Adult Access Only</h2>
      <p>XstreamVideos is intended only for adults who meet the minimum legal age in their jurisdiction.</p>
      <h2>Verification</h2>
      <p>We may require age checks, identity review, creator verification, or additional safeguards to comply with legal and safety obligations.</p>
      <h2>Account Restrictions</h2>
      <p>Accounts that fail age or identity requirements may be restricted, suspended, or removed.</p>
    $html$,
    'XstreamVideos is adult only and may require age, identity, or creator verification.',
    jsonb_build_object('pageTitle', 'Age Verification Policy | XstreamVideos', 'metaTitle', 'Age Verification Policy', 'metaDescription', 'Read XstreamVideos age verification policy.', 'canonicalUrl', '/age-verification-policy')
  ),
  (
    'copyright-policy',
    'copyright-policy',
    'Copyright Policy',
    'Copyright ownership, infringement reporting, and repeat infringer rules.',
    'Legal',
    $html$
      <h2>Copyright Ownership</h2>
      <p>Users and creators must respect intellectual property rights and may only upload content they own or are authorized to use.</p>
      <h2>Reporting Infringement</h2>
      <p>Rights holders may submit copyright complaints with enough detail for us to identify the disputed material.</p>
      <h2>Repeat Infringers</h2>
      <p>Accounts that repeatedly violate copyright rules may be restricted or terminated.</p>
    $html$,
    'Users must respect copyright and may report infringement. Repeat infringers may be terminated.',
    jsonb_build_object('pageTitle', 'Copyright Policy | XstreamVideos', 'metaTitle', 'Copyright Policy', 'metaDescription', 'Read the XstreamVideos copyright policy.', 'canonicalUrl', '/copyright-policy')
  ),
  (
    'dmca-policy',
    'dmca-policy',
    'DMCA Policy',
    'DMCA notice, counter-notice, and takedown workflow.',
    'Legal',
    $html$
      <h2>DMCA Notices</h2>
      <p>Copyright owners may submit DMCA notices that identify the copyrighted work, the allegedly infringing content, contact information, and required legal statements.</p>
      <h2>Counter-Notices</h2>
      <p>Users may submit counter-notices when they believe content was removed by mistake or misidentification.</p>
      <h2>Takedown Process</h2>
      <p>We review valid notices, remove or restrict disputed content where required, and may restore content according to applicable law.</p>
    $html$,
    'The DMCA Policy explains notice, counter-notice, and takedown processes.',
    jsonb_build_object('pageTitle', 'DMCA Policy | XstreamVideos', 'metaTitle', 'DMCA Policy', 'metaDescription', 'Read the XstreamVideos DMCA policy.', 'canonicalUrl', '/dmca-policy')
  )
),
inserted_docs as (
  insert into public.legal_documents (
    document_key,
    slug,
    title,
    description,
    category,
    status,
    content_html,
    content_text,
    seo,
    version_number,
    published_at
  )
  select
    document_key,
    slug,
    title,
    description,
    category,
    'published',
    content_html,
    content_text,
    seo,
    1,
    now()
  from seed
  on conflict (document_key) do nothing
  returning id, document_key
),
seed_docs as (
  select
    d.id,
    d.title,
    d.slug,
    d.description,
    d.category,
    d.published_at,
    s.content_html,
    s.content_text,
    s.seo
  from public.legal_documents d
  join seed s on s.document_key = d.document_key
),
inserted_versions as (
  insert into public.legal_document_versions (
    document_id,
    version_number,
    status,
    title,
    slug,
    description,
    category,
    content_html,
    content_text,
    seo,
    published_at,
    change_notes,
    author_name
  )
  select
    id,
    1,
    'published',
    title,
    slug,
    description,
    category,
    content_html,
    content_text,
    seo,
    coalesce(published_at, now()),
    'Initial database-managed legal document import.',
    'System'
  from seed_docs
  where not exists (
    select 1
    from public.legal_document_versions v
    where v.document_id = seed_docs.id
      and v.version_number = 1
  )
  returning id, document_id
)
update public.legal_documents d
set current_version_id = v.id
from inserted_versions v
where d.id = v.document_id
  and d.current_version_id is null;
