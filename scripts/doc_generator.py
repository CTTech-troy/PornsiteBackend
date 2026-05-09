import os
import json
import subprocess
from datetime import datetime

def run_scanner(script_path):
    result = subprocess.run(['python3', script_path], capture_output=True, text=True)
    if result.returncode != 0:
        print(f"Error running {script_path}: {result.stderr}")
        return None
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        print(f"Error decoding JSON from {script_path}")
        return None

def generate_markdown(api_data, db_data, ws_data):
    md = "# Platform API & Database Documentation\n\n"
    md += f"*Generated on: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}*\n\n"

    md += "## Table of Contents\n"
    md += "- [API Architecture](#api-architecture)\n"
    md += "- [Key Platform Flows](#key-platform-flows)\n"
    md += "- [Database Schema (Supabase)](#database-schema-supabase)\n"
    md += "- [API Endpoints](#api-endpoints)\n"
    md += "- [WebSocket APIs](#websocket-apis)\n"
    md += "- [Frontend Integration Notes](#frontend-integration-notes)\n\n"

    md += "## API Architecture\n"
    md += "The backend is a Node.js Express application using Supabase for PostgreSQL and Firebase for Realtime Database and Auth. Real-time features are powered by Socket.IO and LiveKit.\n\n"
    md += "### Authentication Flow\n"
    md += "1. User logins/signups via `/api/auth`.\n"
    md += "2. Server returns a JWT or validates a Firebase ID Token.\n"
    md += "3. All subsequent requests must include `Authorization: Bearer <token>`.\n\n"

    md += "## Key Platform Flows\n"
    md += "### Creator Approval Flow\n"
    md += "1. User submits documents via `/api/auth/apply-creator`.\n"
    md += "2. Admin reviews application in the Admin Panel (`/api/admin/applications`).\n"
    md += "3. Admin approves/rejects via `/api/admin/applications/:id/status`.\n"
    md += "4. If approved, user is granted `creator: true` status and can access `/api/studio`.\n\n"

    md += "### Premium Subscription Flow\n"
    md += "1. User selects a plan from `/api/payments/plans`.\n"
    md += "2. App calls `/api/payments/checkout` to get a checkout URL (Paystack or Monnify).\n"
    md += "3. User completes payment on the provider's hosted page.\n"
    md += "4. Webhook confirms payment and calls `activatePlan` to update user status.\n\n"

    md += "### Video Publishing Flow\n"
    md += "1. Creator prepares upload via `/api/posts/prepare-upload` to get a signed S3 URL.\n"
    md += "2. Browser uploads file directly to Supabase Storage.\n"
    md += "3. Creator submits metadata and storage path to `/api/posts/publish`.\n"
    md += "4. Video is processed and appears in public feeds.\n\n"

    md += "### Live Streaming Flow\n"
    md += "1. Creator calls `/api/live/create` to initialize a session.\n"
    md += "2. Creator obtains LiveKit token and starts broadcasting.\n"
    md += "3. Users join via Socket.IO `join-live` and obtain LiveKit tokens to view.\n"
    md += "4. Host ends stream; server calculates final earnings (70% to creator).\n\n"

    md += "## Database Schema (Supabase)\n\n"
    md += "### Tables\n"
    for table_name, table_info in db_data['tables'].items():
        md += f"#### Table: `public.{table_name}`\n"
        md += "| Column | Type |\n"
        md += "| --- | --- |\n"
        for col in table_info['columns']:
            md += f"| `{col['name']}` | `{col['type']}` |\n"
        md += "\n"

    md += "### RLS Policies\n"
    md += "| Policy Name | Table | Definition |\n"
    md += "| --- | --- | --- |\n"
    for policy in db_data['policies']:
        md += f"| {policy['name']} | {policy['table']} | `{policy['definition'].replace('\\n', ' ')}` |\n"
    md += "\n"

    md += "## API Endpoints\n\n"
    # Group endpoints by file
    files = {}
    for e in api_data['endpoints']:
        f = e['file']
        if f not in files:
            files[f] = []
        files[f].append(e)

    for filename, endpoints in sorted(files.items()):
        section_name = filename.replace('.route.js', '').replace('Routes.js', '').capitalize()
        md += f"### {section_name} API Section\n"
        for e in endpoints:
            md += f"#### {e['method']} `{e['path']}`\n"
            md += f"- **Auth:** {e['auth']}\n"
            md += f"- **Source File:** `src/router/{filename}`\n"
            md += "\n"

    md += "## WebSocket APIs\n\n"
    md += "### Incoming Events (Client -> Server)\n"
    md += "| Event | Params |\n"
    md += "| --- | --- |\n"
    for ev in [e for e in ws_data if e['type'] == 'incoming']:
        md += f"| `{ev['event']}` | `{ev['params']}` |\n"
    md += "\n"

    md += "### Outgoing Events (Server -> Client)\n"
    md += "| Event | Payload |\n"
    md += "| --- | --- |\n"
    for ev in [e for e in ws_data if e['type'] == 'outgoing']:
        md += f"| `{ev['event']}` | `{ev['payload']}` |\n"
    md += "\n"

    md += "## Frontend Integration Notes\n"
    md += "- **Pagination:** Listings use `page` and `limit`. Default limit is usually 20.\n"
    md += "- **Authentication:** Store JWT in LocalStorage and send in `Authorization: Bearer <token>`.\n"
    md += "- **Real-time:** Use `socket.io-client` to connect to the base URL with auth token.\n"
    md += "- **Environment Variables:** Production API is at `https://api.xstreamvideos.site/api`.\n"

    return md

def main():
    # Use paths relative to repo root
    api_data = run_scanner('scripts/api_scanner.py')
    db_data = run_scanner('scripts/db_scanner.py')
    ws_data = run_scanner('scripts/ws_scanner.py')

    if api_data and db_data and ws_data:
        markdown = generate_markdown(api_data, db_data, ws_data)
        with open('API_DOCUMENTATION.md', 'w') as f:
            f.write(markdown)
        print("API_DOCUMENTATION.md generated successfully.")

if __name__ == "__main__":
    main()
