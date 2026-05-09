-- PostgREST schema cache: after DDL or when API reports "Could not find the table ... in the schema cache",
-- call notify_pgrst_reload_schema() (service role) or run NOTIFY from SQL editor.

CREATE OR REPLACE FUNCTION public.notify_pgrst_reload_schema()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NOTIFY pgrst, 'reload schema';
END;
$$;

REVOKE ALL ON FUNCTION public.notify_pgrst_reload_schema() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.notify_pgrst_reload_schema() TO service_role;

SELECT public.notify_pgrst_reload_schema();
