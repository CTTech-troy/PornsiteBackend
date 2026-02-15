import fs from 'fs';
import path from 'path';
import { supabase, isConfigured } from '../src/config/supabase.js';

if (!isConfigured()) {
  console.error('Supabase not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in env.');
  process.exit(1);
}

async function apply() {
  const dir = path.join(process.cwd(), 'db', 'migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    const full = path.join(dir, file);
    console.log('Applying', file);
    const sql = fs.readFileSync(full, 'utf8');
    try {
      const { data, error } = await supabase.rpc('sql_query', { p_sql: sql });
      if (error) {
        console.error('Migration error:', error);
      } else {
        console.log('Applied', file);
      }
    } catch (err) {
      console.error('Migration exception:', err);
    }
  }
}

apply().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
