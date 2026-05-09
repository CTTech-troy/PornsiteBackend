import os
import re
import json

def parse_columns(columns_str):
    columns = []
    # We look for commas that are NOT inside parentheses to split columns
    parts = []
    current_part = []
    depth = 0
    for char in columns_str:
        if char == '(':
            depth += 1
        elif char == ')':
            depth -= 1

        if char == ',' and depth == 0:
            parts.append("".join(current_part).strip())
            current_part = []
        else:
            current_part.append(char)
    if current_part:
        parts.append("".join(current_part).strip())

    for line in parts:
        if not line or line.startswith('--'): continue
        line_upper = line.upper()
        if any(line_upper.startswith(k) for k in ['PRIMARY KEY', 'CONSTRAINT', 'FOREIGN KEY', 'CHECK']):
            continue

        # Match name, then everything else
        match = re.match(r'(\w+)\s+(.*)', line)
        if match:
            col_name = match.group(1)
            rest = match.group(2).strip()

            # Extract type: it's everything until the first keyword that isn't part of the type
            # Types can be "text", "numeric(18, 2)", "timestamp with time zone"
            # Keywords: NOT NULL, DEFAULT, CHECK, PRIMARY KEY, UNIQUE, REFERENCES

            # Simple heuristic: find the first occurrence of a keyword and take everything before it
            keywords = [r'NOT\s+NULL', r'DEFAULT', r'CHECK', r'PRIMARY\s+KEY', r'UNIQUE', r'REFERENCES']
            pattern = r'\s+(?:' + '|'.join(keywords) + r')'

            type_part = re.split(pattern, rest, flags=re.IGNORECASE)[0].strip()
            columns.append({
                "name": col_name,
                "type": type_part
            })
    return columns

def scan_migrations(migration_dir):
    tables = {}
    policies = []

    for filename in sorted(os.listdir(migration_dir)):
        if filename.endswith('.sql'):
            filepath = os.path.join(migration_dir, filename)
            with open(filepath, 'r', encoding='utf-8') as f:
                content = f.read()

                # Extract CREATE TABLE
                table_matches = re.finditer(r'create table (?:if not exists )?public\.(\w+)\s*\((.*?)\);', content, re.DOTALL | re.IGNORECASE)
                for match in table_matches:
                    table_name = match.group(1)
                    columns_str = match.group(2)
                    columns = parse_columns(columns_str)

                    if table_name not in tables:
                        tables[table_name] = {"columns": columns, "foreign_keys": []}
                    else:
                        existing_cols = {c['name']: i for i, c in enumerate(tables[table_name]["columns"])}
                        for new_col in columns:
                            if new_col['name'] in existing_cols:
                                tables[table_name]["columns"][existing_cols[new_col['name']]] = new_col
                            else:
                                tables[table_name]["columns"].append(new_col)

                # Extract ALTER TABLE ADD COLUMN
                alter_matches = re.finditer(r'alter table (?:if exists )?public\.(\w+)\s+(.*?);', content, re.DOTALL | re.IGNORECASE)
                for match in alter_matches:
                    table_name = match.group(1)
                    actions_str = match.group(2).strip()

                    # Split actions by comma, respecting parentheses
                    action_parts = []
                    current_part = []
                    depth = 0
                    for char in actions_str:
                        if char == '(': depth += 1
                        elif char == ')': depth -= 1
                        if char == ',' and depth == 0:
                            action_parts.append("".join(current_part).strip())
                            current_part = []
                        else:
                            current_part.append(char)
                    if current_part:
                        action_parts.append("".join(current_part).strip())

                    for action in action_parts:
                        col_match = re.match(r'add column (?:if not exists )?(\w+)\s+(.*)', action, re.IGNORECASE)
                        if col_match:
                            col_name = col_match.group(1)
                            rest = col_match.group(2).strip()
                            keywords = [r'NOT\s+NULL', r'DEFAULT', r'CHECK', r'PRIMARY\s+KEY', r'UNIQUE', r'REFERENCES']
                            pattern = r'\s+(?:' + '|'.join(keywords) + r')'
                            col_type = re.split(pattern, rest, flags=re.IGNORECASE)[0].strip()

                            if table_name not in tables:
                                tables[table_name] = {"columns": [], "foreign_keys": []}

                            if not any(c['name'] == col_name for c in tables[table_name]["columns"]):
                                tables[table_name]["columns"].append({"name": col_name, "type": col_type})

                # Extract RLS Policies
                policy_matches = re.finditer(r'create policy\s+["\'](.*?)["\']\s+on\s+public\.(\w+)\s+(.*?)(?:;|\n\n)', content, re.DOTALL | re.IGNORECASE)
                for match in policy_matches:
                    policies.append({
                        "name": match.group(1),
                        "table": match.group(2),
                        "definition": match.group(3).strip()
                    })

    return {
        "tables": tables,
        "policies": policies
    }

def main():
    migration_dirs = ['supabase/migrations', 'db/migrations']
    result = {"tables": {}, "policies": []}
    for m_dir in migration_dirs:
        if os.path.exists(m_dir):
            scan_res = scan_migrations(m_dir)
            result["tables"].update(scan_res["tables"])
            result["policies"].extend(scan_res["policies"])

    print(json.dumps(result, indent=2))

if __name__ == "__main__":
    main()
