// Thin People API wrappers used by the Google Contacts sync module.
// Server-only. Uses the existing Gmail OAuth pair — the caller is responsible
// for ensuring the account has granted the `contacts` scope.
import { getAccessToken } from "@/lib/google-oauth.server";
import { READ_PERSON_FIELDS, UPDATE_PERSON_FIELDS, type Person } from "./mapper";

const BASE = "https://people.googleapis.com/v1";
const TIMEOUT_MS = 20_000;

export const CONTACTS_SCOPE = "https://www.googleapis.com/auth/contacts";

export class PeopleApiError extends Error {
  status: number;
  googleReason: string | null;
  constructor(message: string, status: number, googleReason: string | null = null) {
    super(message);
    this.name = "PeopleApiError";
    this.status = status;
    this.googleReason = googleReason;
  }
  /** True when the sync token was invalidated and a full resync is required. */
  get isExpiredSyncToken(): boolean {
    return (
      this.status === 400 &&
      /EXPIRED_SYNC_TOKEN|expired_sync_token/i.test(this.message + (this.googleReason ?? ""))
    );
  }
  /** True when the local etag no longer matches the remote — pull first, retry. */
  get isEtagConflict(): boolean {
    return this.status === 400 && /FAILED_PRECONDITION|etag/i.test(this.message);
  }
  /** True when the People API scope was not granted on this account. */
  get isMissingScope(): boolean {
    return (
      this.status === 403 &&
      /insufficient|scope|forbidden/i.test(this.message + (this.googleReason ?? ""))
    );
  }
}

function parseReason(body: string): string | null {
  try {
    const j = JSON.parse(body) as {
      error?: { status?: string; errors?: Array<{ reason?: string }> };
    };
    return j.error?.errors?.[0]?.reason ?? j.error?.status ?? null;
  } catch {
    return null;
  }
}

async function call<T>(
  accountId: string,
  path: string,
  init: { method?: string; query?: Record<string, string>; body?: unknown } = {},
): Promise<T> {
  const token = await getAccessToken(accountId);
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: init.method ?? "GET",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new PeopleApiError(`People API network error on ${path}: ${msg}`, 0);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new PeopleApiError(
      `People API ${res.status} on ${path}: ${text.slice(0, 400)}`,
      res.status,
      parseReason(text),
    );
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export type ConnectionsPage = {
  connections?: Person[];
  nextPageToken?: string;
  nextSyncToken?: string;
  totalPeople?: number;
};

export async function listConnectionsPage(
  accountId: string,
  opts: { pageSize?: number; pageToken?: string; syncToken?: string; requestSyncToken?: boolean },
): Promise<ConnectionsPage> {
  const query: Record<string, string> = {
    personFields: READ_PERSON_FIELDS,
    pageSize: String(opts.pageSize ?? 500),
  };
  if (opts.pageToken) query.pageToken = opts.pageToken;
  if (opts.syncToken) query.syncToken = opts.syncToken;
  if (opts.requestSyncToken) query.requestSyncToken = "true";
  return call<ConnectionsPage>(accountId, "/people/me/connections", { query });
}

export async function createPerson(accountId: string, body: Partial<Person>): Promise<Person> {
  return call<Person>(accountId, "/people:createContact", {
    method: "POST",
    query: { personFields: READ_PERSON_FIELDS },
    body,
  });
}

export async function updatePerson(
  accountId: string,
  resourceName: string,
  body: Partial<Person> & { etag: string },
): Promise<Person> {
  return call<Person>(accountId, `/${resourceName}:updateContact`, {
    method: "PATCH",
    query: { updatePersonFields: UPDATE_PERSON_FIELDS, personFields: READ_PERSON_FIELDS },
    body,
  });
}

export async function deletePerson(accountId: string, resourceName: string): Promise<void> {
  await call(accountId, `/${resourceName}:deleteContact`, { method: "DELETE" });
}

export type ContactGroup = {
  resourceName?: string;
  etag?: string;
  name?: string;
  formattedName?: string;
  groupType?: string;
  memberResourceNames?: string[];
  memberCount?: number;
};

export type GroupsPage = {
  contactGroups?: ContactGroup[];
  nextPageToken?: string;
  nextSyncToken?: string;
  totalItems?: number;
};

export async function listContactGroupsPage(
  accountId: string,
  opts: { pageToken?: string; syncToken?: string; requestSyncToken?: boolean },
): Promise<GroupsPage> {
  const query: Record<string, string> = {
    pageSize: "200",
    groupFields: "name,formattedName,groupType,memberCount",
  };
  if (opts.pageToken) query.pageToken = opts.pageToken;
  if (opts.syncToken) query.syncToken = opts.syncToken;
  if (opts.requestSyncToken) query.requestSyncToken = "true";
  return call<GroupsPage>(accountId, "/contactGroups", { query });
}

export async function getContactGroupWithMembers(
  accountId: string,
  resourceName: string,
): Promise<ContactGroup> {
  return call<ContactGroup>(accountId, `/${resourceName}`, {
    query: { maxMembers: "10000" },
  });
}

export async function createContactGroup(accountId: string, name: string): Promise<ContactGroup> {
  return call<ContactGroup>(accountId, "/contactGroups", {
    method: "POST",
    body: { contactGroup: { name } },
  });
}

export async function updateContactGroup(
  accountId: string,
  resourceName: string,
  name: string,
): Promise<ContactGroup> {
  return call<ContactGroup>(accountId, `/${resourceName}`, {
    method: "PUT",
    body: { contactGroup: { name }, updateGroupFields: "name" },
  });
}

export async function deleteContactGroup(
  accountId: string,
  resourceName: string,
): Promise<void> {
  await call(accountId, `/${resourceName}`, {
    method: "DELETE",
    query: { deleteContacts: "false" },
  });
}

export async function modifyGroupMembers(
  accountId: string,
  resourceName: string,
  add: string[],
  remove: string[],
): Promise<void> {
  // Google caps members:modify at ~1000 per call — chunk to stay safe.
  const chunk = <T,>(arr: T[], n: number): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  };
  const passes = Math.max(chunk(add, 500).length, chunk(remove, 500).length, 1);
  const addChunks = chunk(add, 500);
  const removeChunks = chunk(remove, 500);
  for (let i = 0; i < passes; i++) {
    await call(accountId, `/${resourceName}/members:modify`, {
      method: "POST",
      body: {
        resourceNamesToAdd: addChunks[i] ?? [],
        resourceNamesToRemove: removeChunks[i] ?? [],
      },
    });
  }
}
