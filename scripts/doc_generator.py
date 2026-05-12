import os
import json
import subprocess
from datetime import datetime

def run_scanner(script_path):
    result = subprocess.run(['python3', script_path], capture_output=True, text=True)
    if result.returncode != 0: return None
    try: return json.loads(result.stdout)
    except: return None

def generate_markdown(api_data, db_data, ws_data):
    md = "# Platform API & Database Documentation\n\n"
    md += f"*Generated on: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}*\n\n"

    md += "## Table of Contents\n"
    md += "- [API Architecture](#api-architecture)\n"
    md += "- [Authentication & Security](#authentication--security)\n"
    md += "- [Key Platform Flows](#key-platform-flows)\n"
    md += "- [Database Schema (Supabase)](#database-schema-supabase)\n"
    md += "- [API Endpoints](#api-endpoints)\n"
    md += "- [WebSocket APIs](#websocket-apis)\n"
    md += "- [Frontend Integration Notes](#frontend-integration-notes)\n\n"

    md += "## API Architecture\n"
    md += "The backend is a Node.js Express application using Supabase for PostgreSQL and Firebase for Realtime Database and Auth. Real-time features are powered by Socket.IO and LiveKit.\n\n"

    md += "## Authentication & Security\n"
    md += "### Authentication Flow\n"
    md += "1. User logins/signups via `/api/auth`.\n2. Server returns a JWT or validates a Firebase ID Token.\n3. All subsequent requests must include `Authorization: Bearer <token>`.\n\n"
    md += "### Required Headers\n"
    md += "- `Authorization`: `Bearer <token>` (for most endpoints)\n"
    md += "- `Content-Type`: `application/json` (for POST/PUT/PATCH)\n\n"
    md += "### Rate Limits\n"
    md += "- **Auth Me**: 100 requests per 15 minutes per IP.\n"
    md += "- **Burst Protection**: 20 requests per 10 seconds for sensitive auth routes.\n\n"

    md += "## Key Platform Flows\n"
    md += "### Creator Approval Flow\n"
    md += "1. User submits documents via `/api/auth/apply-creator`.\n2. Admin reviews application in the Admin Panel (`/api/admin/applications`).\n3. Admin approves/rejects via `/api/admin/applications/:id/status`.\n4. If approved, user is granted `creator: true` status and can access `/api/studio`.\n\n"
    md += "### Video Publishing Flow\n"
    md += "1. Creator prepares upload via `/api/videos/prepare-upload` to get a signed storage path.\n2. Browser uploads file to Supabase Video Bucket.\n3. Creator calls `/api/videos/publish` with path and metadata.\n\n"

    md += "## Database Schema (Supabase)\n\n### Tables\n"
    for table_name, table_info in db_data['tables'].items():
        md += f"#### Table: `public.{table_name}`\n| Column | Type |\n| --- | --- |\n"
        for col in table_info['columns']:
            md += f"| `{col['name']}` | `{col['type']}` |\n"
        md += "\n"

    md += "## API Endpoints\n\n"
    sections = {
        "Authentication": ["auth.route.js"],
        "Videos": ["videos.route.js"],
        "Live Streaming": ["live.route.js"],
        "Creators": ["creators.route.js", "creatorStudio.route.js"],
        "Payments": ["payment.route.js", "memberships.route.js", "finance.route.js"],
        "Users": ["users.route.js"],
        "Messages": ["messages.route.js"],
        "Admin": ["admin.route.js", "adminContent.route.js", "adminModeration.route.js"],
        "Search": ["search.controller.js"],
        "Recommendations": ["recommendation.Controller.js"]
    }

    endpoints = api_data['endpoints']
    for section, files in sections.items():
        relevant = [e for e in endpoints if e['file'] in files or section.lower() in e['path'].lower()]
        if not relevant: continue
        md += f"### {section}\n"
        for e in relevant:
            md += f"#### {e['title'] or (e['method'] + ' ' + e['path'])}\n"
            md += f"- **Description:** {e.get('description', 'No description available')}\n"
            md += f"- **Method:** `{e['method']}`\n"
            md += f"- **Endpoint:** `{e['path']}`\n"
            md += f"- **Auth Requirement:** {e['auth']}\n"
            if e['path_params'] != 'N/A': md += f"- **Path Params:** `{e['path_params']}`\n"
            if e['query_params'] != 'N/A': md += f"- **Query Params:** `{e['query_params']}`\n"
            if e['request_body'] != 'N/A': md += f"- **Request Body:** `{e['request_body']}`\n"
            md += f"- **Response Example:** `{e.get('response_example', '{}')}`\n"
            tables = e.get('tables_used', [])
            tables_str = ', '.join([f'`{t}`' for t in tables]) if tables else 'None identified'
            md += f"- **Database Tables Used:** {tables_str}\n\n"

    if api_data.get('duplicates'):
        md += "## Duplicate Endpoints\n"
        for d in api_data['duplicates']:
            md += f"- `{d['method']} {d['path']}` (found in `{d['file']}`)\n"
        md += "\n"

    md += "## WebSocket APIs\n\n### Incoming Events (Client -> Server)\n| Event | Params |\n| --- | --- |\n"
    for ev in [e for e in ws_data if e['type'] == 'incoming']:
        md += f"| `{ev['event']}` | `{ev['params']}` |\n"
    md += "\n## Frontend Integration Notes\n- **Pagination:** Listings use `page` and `limit`. Default limit is 20.\n- **Real-time:** Use `socket.io-client` to connect with Bearer token.\n"
    return md

def main():
    api_data = run_scanner('scripts/api_scanner.py')
    db_data = run_scanner('scripts/db_scanner.py')
    ws_data = run_scanner('scripts/ws_scanner.py')
    if api_data and db_data and ws_data:
        markdown = generate_markdown(api_data, db_data, ws_data)
        with open('API_DOCUMENTATION.md', 'w') as f: f.write(markdown)
        print("API_DOCUMENTATION.md generated successfully.")

if __name__ == "__main__": main()
