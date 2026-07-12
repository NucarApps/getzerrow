UPDATE public.gmail_accounts
SET needs_reconnect = false,
    last_oauth_error = null,
    consecutive_silent_ticks = 0
WHERE needs_reconnect = true
  AND last_oauth_error ILIKE '%invalid_client%';