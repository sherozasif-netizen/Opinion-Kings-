const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

function headers() {
  return {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
  };
}

async function query(path, opts = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetch(url, { headers: headers(), ...opts });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase error ${res.status}: ${text}`);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) return res.json();
  return null;
}

async function rpc(fnName, args = {}) {
  const url = `${SUPABASE_URL}/rest/v1/rpc/${fnName}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase RPC error ${res.status}: ${text}`);
  }
  return res.json();
}

module.exports = {
  async getAll(table, filter = '', select = '*', order = '') {
    let path = `${table}?select=${select}`;
    if (filter) path += `&${filter}`;
    if (order) path += `&order=${order}`;
    return query(path);
  },

  async getOne(table, filter, select = '*') {
    const path = `${table}?select=${select}&${filter}&limit=1`;
    const rows = await query(path);
    return rows && rows[0] ? rows[0] : null;
  },

  async count(table) {
    const url = `${SUPABASE_URL}/rest/v1/${table}?select=id`;
    const res = await fetch(url, {
      headers: { ...headers(), 'Prefer': 'count=exact' },
      method: 'HEAD',
    });
    const range = res.headers.get('content-range') || '0';
    const total = range.split('/')[1];
    return Number(total) || 0;
  },

  async insert(table, data) {
    return query(table, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async update(table, filter, data) {
    return query(`${table}?${filter}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },

  async countWhere(table, filter) {
    const url = `${SUPABASE_URL}/rest/v1/${table}?select=id&${filter}`;
    const res = await fetch(url, {
      headers: { ...headers(), 'Prefer': 'count=exact' },
      method: 'HEAD',
    });
    const range = res.headers.get('content-range') || '0';
    const total = range.split('/')[1];
    return Number(total) || 0;
  },

  rpc,
};
