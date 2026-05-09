import os
import re
import json

def get_base_paths(index_file):
    base_paths = {}
    with open(index_file, 'r') as f:
        content = f.read()
        # Look for app.use('/api/auth', authRouter)
        matches = re.finditer(r"app\.use\(\s*['\"]([^'\"]+)['\"]\s*,\s*(\w+)\s*\)", content)
        for match in matches:
            path = match.group(1)
            router_var = match.group(2)
            base_paths[router_var] = path

        # Also look for imports to match router_var to filename
        import_matches = re.finditer(r"import\s+(\w+)\s+from\s+['\"](.+)\.js['\"]", content)
        var_to_file = {}
        for match in import_matches:
            var_to_file[match.group(1)] = os.path.basename(match.group(2))

        final_base_paths = {}
        for var, path in base_paths.items():
            if var in var_to_file:
                final_base_paths[var_to_file[var]] = path
    return final_base_paths

def scan_routers(router_dir, base_paths):
    endpoints = []
    for filename in os.listdir(router_dir):
        if filename.endswith('.js'):
            filepath = os.path.join(router_dir, filename)
            base_path = base_paths.get(filename.replace('.js', ''), '')
            if not base_path:
                # Try with .route.js
                base_path = base_paths.get(filename, '')

            with open(filepath, 'r') as f:
                content = f.read()

                # Match router.get('/...', ...), router.post('/...', ...), etc.
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

                    endpoints.append({
                        "file": filename,
                        "method": method,
                        "path": full_path,
                        "auth": auth,
                        "handlers": handlers_str.strip()
                    })
    return endpoints

def main():
    index_file = 'index.js'
    router_dir = 'src/router'
    base_paths = get_base_paths(index_file)
    # Manual fixes for some routers if needed
    base_paths['auth.route'] = '/api/auth'
    base_paths['videos.route'] = '/api/videos'
    base_paths['live.route'] = '/api/live'
    base_paths['creators.route'] = '/api/creators'
    base_paths['payment.route'] = '/api/payments'
    base_paths['admin.route'] = '/api/admin'

    endpoints = scan_routers(router_dir, base_paths)

    # Detect duplicates
    seen = {}
    duplicates = []
    for e in endpoints:
        key = (e['method'], e['path'])
        if key in seen:
            duplicates.append(e)
        else:
            seen[key] = e

    result = {
        "endpoints": endpoints,
        "duplicates": duplicates
    }
    print(json.dumps(result, indent=2))

if __name__ == "__main__":
    main()
