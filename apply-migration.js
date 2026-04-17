/**
 * Apply Chat Queue Migration
 * Creates the missing cleanup_stale_queue function
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.error('❌ SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: { autoRefreshToken: false },
});

const CREATE_FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION cleanup_stale_queue(p_seconds_old int DEFAULT 30)
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
  v_deleted int;
BEGIN
  DELETE FROM chat_queue
   WHERE joined_at < now() - (p_seconds_old || ' seconds')::interval;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;
`;

async function applyMigration() {
  try {
    console.log('🚀 Applying chat queue migration...');

    // Try to execute the SQL directly
    const { data, error } = await supabase.rpc('exec', { sql: CREATE_FUNCTION_SQL });

    if (error) {
      console.error('❌ Error applying migration:', error);
      console.log('💡 You may need to run this SQL manually in your Supabase SQL Editor:');
      console.log(CREATE_FUNCTION_SQL);
      return false;
    }

    console.log('✅ Migration applied successfully!');
    console.log('📊 Result:', data);
    return true;
  } catch (error) {
    console.error('❌ Unexpected error:', error);
    console.log('💡 You may need to run this SQL manually in your Supabase SQL Editor:');
    console.log(CREATE_FUNCTION_SQL);
    return false;
  }
}

applyMigration();</content>
<parameter name="filePath">c:\Users\Korede Abdulsalam\Desktop\pornsite\backend\apply-migration.js