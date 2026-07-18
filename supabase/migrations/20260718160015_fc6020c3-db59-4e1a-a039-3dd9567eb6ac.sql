
ALTER FUNCTION public.autolink_contact_email_to_company() SECURITY INVOKER;
ALTER FUNCTION public.autolink_contact_company_domain() SECURITY INVOKER;
REVOKE EXECUTE ON FUNCTION public.autolink_contact_email_to_company() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.autolink_contact_company_domain() FROM PUBLIC;
