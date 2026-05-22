const BASE_URL = 'https://api.usepylon.com';

const PRIORITY_WEIGHTS = {
  urgent: 4,
  high: 3,
  medium: 2,
  normal: 2,
  low: 1,
};

// States that count toward the workload score / dashboard
const ACTIVE_STATES = ['new', 'waiting_on_you'];

// Only show these team members in the dashboard. Matched against the first
// word of the user's display name, case-insensitively.
const VISIBLE_FIRST_NAMES = new Set([
  'jared', 'fernando', 'akash', 'stephane', 'parth',
  'manish', 'rahul', 'sheema', 'gonza',    'alex',
]);

// In-memory user cache so we don't re-fetch on every refresh
let userCache = null;       // Map<id, {name, email}>
let userCacheExpiry = 0;
const USER_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'FETCH_WORKLOAD') {
    fetchWorkload(message.apiKey)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true; // keep channel open for async response
  }
});

async function fetchWorkload(apiKey) {
  // Fetch statuses first so we know which custom slugs to exclude
  const customSlugsToExclude = await fetchCustomSlugsInActiveCategories(apiKey);

  const [issues, userMap] = await Promise.all([
    fetchAllActiveIssues(apiKey, customSlugsToExclude),
    fetchUserMap(apiKey),
  ]);
  return groupByAssignee(issues, userMap);
}

// ── Issue statuses ────────────────────────────────────────────────────────────

// Returns the list of custom-status slugs whose `category` is one of our active
// states. We exclude these from the search so e.g. `escalated_to_engineering`
// (category=new) doesn't get counted alongside literal "new" tickets.
async function fetchCustomSlugsInActiveCategories(apiKey) {
  try {
    const res = await fetch(`${BASE_URL}/issue-statuses`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return [];
    const data = await res.json();
    const statuses = data.data ?? [];
    return statuses
      .filter(s => ACTIVE_STATES.includes(s.category) && s.slug !== s.category && !s.is_archived)
      .map(s => s.slug);
  } catch {
    return [];
  }
}

// ── Issues ────────────────────────────────────────────────────────────────────

async function fetchAllActiveIssues(apiKey, excludeSlugs) {
  const issues = [];
  let cursor = null;

  // Compound filter: state in [new, waiting_on_you] AND issue_type = ticket
  //                  AND state not_in [<custom slugs in those categories>]
  // The issue_type filter is critical — Pylon's "On you" UI view only shows
  // tickets, not conversations, so without this we double-count Slack/email
  // conversations that happen to be assigned to a user.
  const subfilters = [
    { field: 'state',      operator: 'in',     values: ACTIVE_STATES },
    { field: 'issue_type', operator: 'equals', value:  'ticket'      },
  ];
  if (excludeSlugs.length) {
    subfilters.push({ field: 'state', operator: 'not_in', values: excludeSlugs });
  }
  const searchFilter = { operator: 'and', subfilters };

  while (true) {
    const body = {
      filter: searchFilter,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    };

    const res = await fetch(`${BASE_URL}/issues/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Pylon API ${res.status}: ${text || res.statusText}`);
    }

    const data = await res.json();
    issues.push(...(data.data ?? []));

    const pagination = data.pagination;
    if (!pagination?.has_next_page || !pagination.cursor) break;
    cursor = pagination.cursor;
  }

  return issues;
}

// ── Users ─────────────────────────────────────────────────────────────────────

async function fetchUserMap(apiKey) {
  if (userCache && Date.now() < userCacheExpiry) return userCache;

  const users = [];
  let cursor = null;

  while (true) {
    const url = new URL(`${BASE_URL}/users`);
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('cursor', cursor);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!res.ok) {
      console.warn('[Pylon Workload] Could not fetch users:', res.status);
      return userCache ?? new Map();
    }

    const data = await res.json();
    users.push(...(data.data ?? []));

    const pagination = data.pagination;
    if (!pagination?.has_next_page || !pagination.cursor) break;
    cursor = pagination.cursor;
  }

  const map = new Map();
  for (const u of users) {
    if (!u.id) continue;
    map.set(u.id, {
      name:  u.name  ?? emailToName(u.email) ?? 'Unknown',
      email: u.email ?? '',
    });
  }

  userCache = map;
  userCacheExpiry = Date.now() + USER_CACHE_TTL;
  return map;
}

function emailToName(email) {
  if (!email) return null;
  return email
    .split('@')[0]
    .replace(/[-_.+]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

// ── Grouping ──────────────────────────────────────────────────────────────────

function groupByAssignee(issues, userMap) {
  const map = {};

  for (const issue of issues) {
    // Defensive: only count the two active states, even if the API ever
    // returns something else.
    if (!ACTIVE_STATES.includes(issue.state)) continue;

    // Skip phantom/stale tickets imported from Zendesk that still carry
    // `state: "new"` despite being resolved long ago — they have a non-null
    // `resolution_time` while real active tickets have it set to null.
    if (issue.resolution_time) continue;

    const assignee = issue.assignee;
    if (!assignee?.id) continue;

    if (!map[assignee.id]) {
      const user = userMap.get(assignee.id);
      const name  = user?.name  ?? assignee.name  ?? emailToName(assignee.email) ?? 'Unknown';
      const email = user?.email ?? assignee.email ?? '';

      map[assignee.id] = {
        id: assignee.id,
        email,
        name,
        newCount: 0,
        waitingCount: 0,
        score: 0,
      };
    }

    const entry = map[assignee.id];
    if (issue.state === 'new') entry.newCount++;
    else if (issue.state === 'waiting_on_you') entry.waitingCount++;

    const priority = (issue.priority ?? 'medium').toLowerCase();
    entry.score += PRIORITY_WEIGHTS[priority] ?? 1;
  }

  return Object.values(map)
    .filter(a => {
      const first = (a.name || '').trim().split(/\s+/)[0]?.toLowerCase();
      return first && VISIBLE_FIRST_NAMES.has(first);
    })
    // Lightest workload first, heaviest last
    .sort((a, b) => a.score - b.score);
}
