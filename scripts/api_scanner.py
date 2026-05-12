import os
import re
import json

def get_base_paths(index_file):
    base_paths = {}
    if not os.path.exists(index_file): return {}
    with open(index_file, 'r') as f:
        content = f.read()
        matches = re.finditer(r"app\.use\(\s*['\"]([^'\"]+)['\"]\s*,\s*(\w+)\s*\)", content)
        for match in matches:
            path = match.group(1)
            router_var = match.group(2)
            base_paths[router_var] = path
        import_matches = re.finditer(r"import\s+(\w+)\s+from\s+['\"](.+)\.js['\"]", content)
        var_to_file = {}
        for match in import_matches:
            var_to_file[match.group(1)] = os.path.basename(match.group(2))
        final_base_paths = {}
        for var, path in base_paths.items():
            if var in var_to_file:
                final_base_paths[var_to_file[var]] = path
    return final_base_paths

def extract_details(handlers_str, router_content, router_file):
    details = {
        "title": "",
        "description": "No description available",
        "request_body": "N/A",
        "query_params": "N/A",
        "path_params": "N/A",
        "response_example": "{\"success\": true}",
        "error_responses": "401: Unauthorized, 500: Internal Error",
        "tables_used": [],
        "frontend_notes": "None"
    }

    handler_name_match = re.search(r'(\w+)\.(\w+)', handlers_str)
    if not handler_name_match:
        handler_name_match = re.search(r'\b(\w+)\b', handlers_str)

    if handler_name_match:
        ctrl_alias = handler_name_match.group(1)
        func_name = handler_name_match.group(2) if '.' in handler_name_match.group(0) else ctrl_alias
        details["title"] = func_name.replace('_', ' ').capitalize()

        import_match = re.search(fr"import\s+(?:.*?\b{ctrl_alias}\b.*?)\s+from\s+['\"](.+)\.js['\"]", router_content)
        if import_match:
            ctrl_path = import_match.group(1)
            router_dir = os.path.dirname(os.path.abspath(router_file))
            ctrl_file = os.path.abspath(os.path.join(router_dir, ctrl_path + '.js'))

            if os.path.exists(ctrl_file):
                with open(ctrl_file, 'r') as f:
                    ctrl_content = f.read()
                    jsdoc_match = re.search(fr"/\*\*(.*?)\*/\s*export\s+(?:async\s+)?function\s+{func_name}", ctrl_content, re.DOTALL)
                    if jsdoc_match:
                        jsdoc = jsdoc_match.group(1)
                        lines = [l.strip('* ').strip() for l in jsdoc.split('\n') if l.strip('* ').strip()]
                        if lines: details["description"] = lines[0]

                    body_match = re.search(fr"export\s+(?:async\s+)?function\s+{func_name}.*?\{(.*?)\n\}}", ctrl_content, re.DOTALL)
                    if body_match:
                        body = body_match.group(1)
                        tables = re.findall(r"\.from\(['\"](\w+)['\"]\)", body)
                        details["tables_used"] = list(set(tables))
                        body_fields = re.findall(r"const\s+\{(.*?)\}\s*=\s*req\.body", body)
                        if body_fields:
                            fields = [f.strip() for f in body_fields[0].split(',')]
                            details["request_body"] = "{" + ", ".join([f'"{f}": "..."' for f in fields]) + "}"
                        query_fields = re.findall(r"const\s+\{(.*?)\}\s*=\s*req\.query", body)
                        if query_fields:
                            fields = [f.strip() for f in query_fields[0].split(',')]
                            details["query_params"] = ", ".join(fields)
    return details

def scan_routers(router_dir, base_paths):
    endpoints = []
    if not os.path.exists(router_dir): return []
    for filename in os.listdir(router_dir):
        if filename.endswith('.js'):
            filepath = os.path.join(router_dir, filename)
            bp_key = filename.replace('.js', '')
            base_path = base_paths.get(bp_key, base_paths.get(bp_key.replace('.route', ''), ''))
            with open(filepath, 'r') as f:
                content = f.read()
                matches = re.finditer(r'router\.(get|post|put|patch|delete)\(\s*[\'"]([^\'"]*)[\'"]\s*,(.*?)\)(?:\s*;|\s*\n)', content, re.DOTALL)
                for match in matches:
                    method = match.group(1).upper()
                    path = match.group(2)
                    handlers_str = match.group(3)
                    auth = "None"
                    if "requireAuth" in handlers_str or "requireAdminAuth" in handlers_str:
                        auth = "Required"
                    elif "optionalAuth" in handlers_str:
                        auth = "Optional"
                    full_path = (base_path + path).replace('//', '/')
                    details = extract_details(handlers_str, content, filepath)
                    path_params = re.findall(r':(\w+)', full_path)
                    if path_params: details["path_params"] = ", ".join(path_params)
                    endpoints.append({
                        "file": filename,
                        "method": method,
                        "path": full_path,
                        "auth": auth,
                        **details
                    })
    return endpoints

def main():
    base_paths = get_base_paths('index.js')
    base_paths['auth.route'] = '/api/auth'
    base_paths['videos.route'] = '/api/videos'
    base_paths['live.route'] = '/api/live'
    base_paths['creators.route'] = '/api/creators'
    base_paths['payment.route'] = '/api/payments'
    base_paths['admin.route'] = '/api/admin'
    base_paths['users.route'] = '/api/users'
    base_paths['memberships.route'] = '/api/memberships'
    endpoints = scan_routers('src/router', base_paths)
    seen = {}
    duplicates = []
    for e in endpoints:
        key = (e['method'], e['path'])
        if key in seen: duplicates.append(e)
        else: seen[key] = e
    print(json.dumps({"endpoints": endpoints, "duplicates": duplicates}, indent=2))

if __name__ == "__main__": main()
