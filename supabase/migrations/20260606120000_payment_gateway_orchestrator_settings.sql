-- Payment gateway orchestrator settings (Flutterwave primary, Paystack fallback).

INSERT INTO public.platform_settings (key, value, section, description, value_type, updated_at)
VALUES
  ('payment_gateway_primary', 'flutterwave', 'Payments', 'Primary Payment Gateway', 'select', now()),
  ('payment_gateway_fallback', 'paystack', 'Payments', 'Fallback Payment Gateway', 'select', now()),
  ('payment_retry_limit', '2', 'Payments', 'Payment Retry Limit', 'number', now()),
  ('payment_retry_delay_ms', '750', 'Payments', 'Payment Retry Delay (ms)', 'number', now()),
  ('payment_timeout_ms', '20000', 'Payments', 'Payment Timeout (ms)', 'number', now())
ON CONFLICT (key) DO UPDATE
SET
  value = EXCLUDED.value,
  section = COALESCE(EXCLUDED.section, public.platform_settings.section),
  description = COALESCE(EXCLUDED.description, public.platform_settings.description),
  value_type = COALESCE(EXCLUDED.value_type, public.platform_settings.value_type),
  updated_at = now()
WHERE public.platform_settings.value IS DISTINCT FROM EXCLUDED.value;
