'use strict';
const https = require('https');
const http  = require('http');

// ─── Generic JSON fetch ───────────────────────────────────────────────────────
function fetchJSON(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed   = new URL(url);
    const isHttps  = parsed.protocol === 'https:';
    const lib      = isHttps ? https : http;
    const reqOpts  = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   options.method || 'GET',
      headers:  { 'Content-Type': 'application/json', 'Accept': 'application/json', ...(options.headers || {}) },
      timeout:  10000,
    };
    const req = lib.request(reqOpts, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data, raw: true }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    if (options.body) req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    req.end();
  });
}

// ─── Date helpers ─────────────────────────────────────────────────────────────
function today()     { return new Date().toISOString().slice(0,10); }
function daysAgo(n)  { const d = new Date(); d.setDate(d.getDate()-n); return d.toISOString().slice(0,10); }
function monthStart(){ const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`; }

// ═══════════════════════════════════════════════════════════════════════════════
// DIKIDI
// Docs: https://dikidi.net/ru/open-api/
// Auth: Bearer token in header (API key from DIKIDI settings → Users)
// ═══════════════════════════════════════════════════════════════════════════════
async function dikidiFetch(apiKey, path, params = {}) {
  const qs  = new URLSearchParams(params).toString();
  const url = `https://dikidi.net/api/v2${path}${qs ? '?' + qs : ''}`;
  const res = await fetchJSON(url, {
    headers: { 'Authorization': `Bearer ${apiKey}` }
  });
  if (res.status !== 200) throw new Error(`DIKIDI ${res.status}: ${JSON.stringify(res.data).slice(0,200)}`);
  return res.data;
}

async function connectDikidi(apiKey) {
  // Test connection — get company info
  const data = await dikidiFetch(apiKey, '/company');
  if (!data?.data?.id) throw new Error('Неверный API-ключ DIKIDI');
  return {
    company_id:   String(data.data.id),
    company_name: data.data.name || 'DIKIDI Salon',
    city:         data.data.city || '',
    currency:     data.data.currency || 'UAH',
  };
}

async function syncDikidi(apiKey, companyId) {
  const dateFrom = monthStart();
  const dateTo   = today();

  // Records (appointments) for current month
  const records = await dikidiFetch(apiKey, '/records', {
    company_id: companyId,
    date_from:  dateFrom,
    date_to:    dateTo,
    status:     '1', // completed
    count:      500,
  });

  const items = records?.data?.records || [];

  // Aggregate metrics
  const revenue   = items.reduce((s, r) => s + Number(r.total_sum || 0), 0);
  const visits    = items.length;
  const avgCheck  = visits > 0 ? Math.round(revenue / visits) : 0;

  // New vs returning clients
  const clientIds = items.map(r => r.client_id).filter(Boolean);
  const uniqueIds = [...new Set(clientIds)];
  const newClients = uniqueIds.length; // approximation without history

  // Masters breakdown
  const masterMap = {};
  items.forEach(r => {
    const name = r.staff_name || r.master_name || 'Мастер';
    if (!masterMap[name]) masterMap[name] = { name, revenue: 0, visits: 0 };
    masterMap[name].revenue += Number(r.total_sum || 0);
    masterMap[name].visits  += 1;
  });
  const masters = Object.values(masterMap)
    .sort((a,b) => b.revenue - a.revenue)
    .map(m => ({ ...m, revenue: Math.round(m.revenue) }));

  // Today's data
  const todayItems = items.filter(r => (r.date || '').slice(0,10) === today());
  const todayRev   = todayItems.reduce((s,r) => s + Number(r.total_sum||0), 0);

  return {
    period:     dateFrom.slice(0,7), // 'YYYY-MM'
    revenue:    Math.round(revenue),
    visits,
    avg_check:  avgCheck,
    new_clients: newClients,
    masters,
    today: {
      revenue:   Math.round(todayRev),
      visits:    todayItems.length,
      avg_check: todayItems.length > 0 ? Math.round(todayRev / todayItems.length) : 0,
    },
    raw_count: items.length,
    source: 'dikidi',
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// YCLIENTS
// Docs: https://developers.yclients.com/
// Auth: Bearer {partner_token}, User-Token {user_token}
// ═══════════════════════════════════════════════════════════════════════════════
async function yclientsFetch(partnerToken, userToken, path, params = {}) {
  const qs  = new URLSearchParams(params).toString();
  const url = `https://api.yclients.com/api/v1${path}${qs ? '?' + qs : ''}`;
  const res = await fetchJSON(url, {
    headers: {
      'Authorization': `Bearer ${partnerToken}, User ${userToken}`,
      'Accept':        'application/vnd.yclients.v2+json',
    }
  });
  if (!res.data?.success) throw new Error(`Yclients error: ${res.data?.meta?.message || res.status}`);
  return res.data;
}

async function connectYclients(partnerToken, userToken) {
  // Get user's companies
  const data = await yclientsFetch(partnerToken, userToken, '/companies', { count: 10 });
  const companies = data?.data || [];
  if (!companies.length) throw new Error('Компании не найдены в Yclients');
  const co = companies[0];
  return {
    company_id:   String(co.id),
    company_name: co.title || 'Yclients Salon',
    city:         co.city?.title || '',
    currency:     co.currency?.symbol || '₴',
  };
}

async function syncYclients(partnerToken, userToken, companyId) {
  const dateFrom = monthStart();
  const dateTo   = today();

  // Visits (records)
  const visits = await yclientsFetch(partnerToken, userToken,
    `/records/${companyId}`, {
      start_date: dateFrom,
      end_date:   dateTo,
      count:      500,
      status:     '1,2,8', // completed statuses
    }
  );

  const items = visits?.data || [];
  const revenue  = items.reduce((s,r) => s + Number(r.cost || 0), 0);
  const count    = items.length;
  const avgCheck = count > 0 ? Math.round(revenue / count) : 0;

  // Masters
  const masterMap = {};
  items.forEach(r => {
    r.staff?.forEach(st => {
      const name = st.name || 'Мастер';
      if (!masterMap[name]) masterMap[name] = { name, revenue: 0, visits: 0 };
      masterMap[name].revenue += Number(r.cost || 0) / (r.staff?.length || 1);
      masterMap[name].visits  += 1;
    });
  });
  const masters = Object.values(masterMap)
    .sort((a,b) => b.revenue - a.revenue)
    .map(m => ({ ...m, revenue: Math.round(m.revenue) }));

  // Today
  const todayItems = items.filter(r => (r.datetime || '').slice(0,10) === today());
  const todayRev   = todayItems.reduce((s,r) => s + Number(r.cost||0), 0);

  return {
    period:      dateFrom.slice(0,7),
    revenue:     Math.round(revenue),
    visits:      count,
    avg_check:   avgCheck,
    new_clients: Math.round(count * 0.2), // Yclients doesn't expose new/return in basic API
    masters,
    today: {
      revenue:   Math.round(todayRev),
      visits:    todayItems.length,
      avg_check: todayItems.length > 0 ? Math.round(todayRev / todayItems.length) : 0,
    },
    source: 'yclients',
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOOKSY (Poland)
// Docs: https://booksy.com/developers
// Auth: API key in X-Api-Key header
// ═══════════════════════════════════════════════════════════════════════════════
async function booksyFetch(apiKey, path, params = {}) {
  const qs  = new URLSearchParams(params).toString();
  const url = `https://us.booksy.com/api/us/2${path}${qs ? '?' + qs : ''}`;
  const res = await fetchJSON(url, {
    headers: { 'X-Api-Key': apiKey }
  });
  if (res.status !== 200) throw new Error(`Booksy ${res.status}: ${JSON.stringify(res.data).slice(0,200)}`);
  return res.data;
}

async function connectBooksy(apiKey) {
  const data = await booksyFetch(apiKey, '/business/me');
  if (!data?.id) throw new Error('Неверный API-ключ Booksy');
  return {
    company_id:   String(data.id),
    company_name: data.name || 'Booksy Salon',
    city:         data.city || '',
    currency:     'PLN',
  };
}

async function syncBooksy(apiKey, companyId) {
  const dateFrom = monthStart();
  const dateTo   = today();

  const appts = await booksyFetch(apiKey, `/business/${companyId}/appointments`, {
    from: dateFrom,
    to:   dateTo,
    status: 'completed',
    limit: 500,
  });

  const items     = appts?.appointments || appts?.data || [];
  const revenue   = items.reduce((s,r) => s + Number(r.total_price || r.price || 0), 0);
  const count     = items.length;
  const avgCheck  = count > 0 ? Math.round(revenue / count) : 0;
  const newCl     = items.filter(r => r.is_new_client).length;

  const masterMap = {};
  items.forEach(r => {
    const name = r.staff?.name || r.employee_name || 'Мастер';
    if (!masterMap[name]) masterMap[name] = { name, revenue: 0, visits: 0 };
    masterMap[name].revenue += Number(r.total_price || 0);
    masterMap[name].visits  += 1;
  });

  const todayItems = items.filter(r => (r.date || r.start_time || '').slice(0,10) === today());

  return {
    period: dateFrom.slice(0,7),
    revenue: Math.round(revenue),
    visits: count,
    avg_check: avgCheck,
    new_clients: newCl,
    masters: Object.values(masterMap).sort((a,b) => b.revenue - a.revenue),
    today: {
      revenue: todayItems.reduce((s,r) => s + Number(r.total_price||0), 0),
      visits:  todayItems.length,
    },
    source: 'booksy',
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIMPLYBOOK.ME (Spain, UAE, Global)
// Docs: https://simplybook.me/en/api/developer-api
// Auth: company_login + api_key → get token
// ═══════════════════════════════════════════════════════════════════════════════
async function simplybookGetToken(companyLogin, apiKey) {
  const res = await fetchJSON('https://user-api.simplybook.me/login', {
    method: 'POST',
    body: JSON.stringify({ company: companyLogin, login: 'api', password: apiKey }),
  });
  const token = res.data?.token || res.data?.result;
  if (!token) throw new Error('SimplyBook: не удалось получить токен');
  return token;
}

async function simplybookFetch(token, method, params = []) {
  const res = await fetchJSON('https://user-api.simplybook.me/', {
    method: 'POST',
    headers: { 'X-Company-Login': '', 'X-Token': token },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (res.data?.error) throw new Error(`SimplyBook: ${res.data.error.message}`);
  return res.data?.result;
}

async function connectSimplybook(companyLogin, apiKey) {
  const token = await simplybookGetToken(companyLogin, apiKey);
  const info  = await simplybookFetch(token, 'getCompanyInfo');
  return {
    company_id:   companyLogin,
    company_name: info?.name || companyLogin,
    city:         info?.city || '',
    currency:     info?.currency || 'EUR',
    extra: { company_login: companyLogin }
  };
}

async function syncSimplybook(companyLogin, apiKey) {
  const token = await simplybookGetToken(companyLogin, apiKey);
  const dateFrom = monthStart();
  const dateTo   = today();

  const bookings = await simplybookFetch(token, 'getBookings', [{
    date_from: dateFrom, date_to: dateTo, status: ['confirmed','completed']
  }]);

  const items    = Array.isArray(bookings) ? bookings : (bookings?.data || []);
  const revenue  = items.reduce((s,r) => s + Number(r.total_amount || r.price || 0), 0);
  const count    = items.length;

  const todayItems = items.filter(r => (r.start_date || r.date || '').slice(0,10) === today());

  return {
    period:    dateFrom.slice(0,7),
    revenue:   Math.round(revenue),
    visits:    count,
    avg_check: count > 0 ? Math.round(revenue/count) : 0,
    new_clients: 0,
    today: {
      revenue: todayItems.reduce((s,r) => s + Number(r.total_amount||0), 0),
      visits:  todayItems.length,
    },
    source: 'simplybook',
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIMIFY (Germany, DACH)
// Docs: https://developers.timify.com
// Auth: Bearer token (API key from Timify dashboard)
// ═══════════════════════════════════════════════════════════════════════════════
async function timifyFetch(apiKey, path, params = {}) {
  const qs  = new URLSearchParams(params).toString();
  const url = `https://api.timify.com/v1${path}${qs ? '?' + qs : ''}`;
  const res = await fetchJSON(url, {
    headers: { 'Authorization': `Bearer ${apiKey}` }
  });
  if (res.status !== 200) throw new Error(`Timify ${res.status}: ${JSON.stringify(res.data).slice(0,150)}`);
  return res.data;
}

async function connectTimify(apiKey) {
  const data = await timifyFetch(apiKey, '/account');
  if (!data?.id && !data?.account) throw new Error('Неверный API-ключ Timify');
  const acc = data?.account || data;
  return {
    company_id:   String(acc.id || acc.accountId || 'timify'),
    company_name: acc.name || acc.companyName || 'Timify Salon',
    city:         acc.city || '',
    currency:     'EUR',
  };
}

async function syncTimify(apiKey, companyId) {
  const dateFrom = monthStart();
  const dateTo   = today();

  const appts = await timifyFetch(apiKey, '/appointments', {
    startDate: dateFrom,
    endDate:   dateTo,
    status:    'BOOKED,ATTENDED',
    limit:     500,
  });

  const items   = appts?.appointments || appts?.data || appts || [];
  const revenue = items.reduce((s,r) => s + Number(r.price || r.amount || 0), 0);
  const count   = Array.isArray(items) ? items.length : 0;

  const todayItems = Array.isArray(items)
    ? items.filter(r => (r.start || r.date || '').slice(0,10) === today())
    : [];

  return {
    period:    dateFrom.slice(0,7),
    revenue:   Math.round(revenue),
    visits:    count,
    avg_check: count > 0 ? Math.round(revenue/count) : 0,
    new_clients: 0,
    today: { revenue: 0, visits: todayItems.length },
    source: 'timify',
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHORE (Germany)
// Docs: https://www.shore.com/developer
// Auth: Bearer token
// ═══════════════════════════════════════════════════════════════════════════════
async function shoreFetch(apiKey, path, params = {}) {
  const qs  = new URLSearchParams(params).toString();
  const url = `https://api.shore.com/v1${path}${qs ? '?' + qs : ''}`;
  const res = await fetchJSON(url, {
    headers: { 'Authorization': `Bearer ${apiKey}` }
  });
  if (res.status !== 200) throw new Error(`Shore ${res.status}`);
  return res.data;
}

async function connectShore(apiKey) {
  const data = await shoreFetch(apiKey, '/me');
  if (!data) throw new Error('Неверный API-ключ Shore');
  return {
    company_id:   String(data.id || 'shore'),
    company_name: data.name || data.business_name || 'Shore Salon',
    city:         data.city || '',
    currency:     'EUR',
  };
}

async function syncShore(apiKey, companyId) {
  const dateFrom = monthStart();
  const dateTo   = today();

  const appts = await shoreFetch(apiKey, '/appointments', {
    from:   dateFrom,
    to:     dateTo,
    status: 'completed',
    per_page: 500,
  });

  const items   = appts?.appointments || appts?.data || [];
  const revenue = items.reduce((s,r) => s + Number(r.price || 0), 0);
  const count   = items.length;

  return {
    period:    dateFrom.slice(0,7),
    revenue:   Math.round(revenue),
    visits:    count,
    avg_check: count > 0 ? Math.round(revenue/count) : 0,
    new_clients: 0,
    today: { revenue: 0, visits: 0 },
    source: 'shore',
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// POSTER POS (Ukraine, Kazakhstan)
// Docs: https://dev.joinposter.com/
// Auth: access_token as query param
// ═══════════════════════════════════════════════════════════════════════════════
async function posterFetch(accessToken, method, params = {}) {
  const qs  = new URLSearchParams({ token: accessToken, ...params }).toString();
  const url = `https://joinposter.com/api/${method}?${qs}`;
  const res = await fetchJSON(url);
  if (res.data?.error) throw new Error(`Poster: ${res.data.error}`);
  return res.data;
}

async function connectPoster(accessToken) {
  const data = await posterFetch(accessToken, 'settings.getSettings');
  const info = data?.response;
  if (!info) throw new Error('Неверный токен Poster');
  return {
    company_id:   String(info.spot_id || 'poster'),
    company_name: info.company_name || 'Poster Salon',
    city:         info.city || '',
    currency:     info.currency || 'UAH',
  };
}

async function syncPoster(accessToken) {
  const dateFrom = monthStart().replace(/-/g,'');
  const dateTo   = today().replace(/-/g,'');

  const trans = await posterFetch(accessToken, 'dash.getAnalytics', {
    dateFrom, dateTo,
  });

  const data    = trans?.response || {};
  const revenue = Number(data.revenue || data.total_revenue || 0) / 100; // Poster uses kopecks
  const count   = Number(data.total_receipts || data.receipts || 0);

  return {
    period:    monthStart().slice(0,7),
    revenue:   Math.round(revenue),
    visits:    count,
    avg_check: count > 0 ? Math.round(revenue/count) : 0,
    new_clients: 0,
    today: { revenue: 0, visits: 0 },
    source: 'poster',
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ALTEGGIO (alteg.io)
// Docs: https://developers.alteg.io/
// Auth: Bearer {partner_token}, User {user_token} — same structure as Yclients
// ═══════════════════════════════════════════════════════════════════════════════
async function altegFetch(partnerToken, userToken, path, params = {}) {
  const qs  = new URLSearchParams(params).toString();
  const url = `https://api.alteg.io/api/v1${path}${qs ? '?' + qs : ''}`;
  const res = await fetchJSON(url, {
    headers: {
      'Authorization': `Bearer ${partnerToken}, User ${userToken}`,
      'Accept':        'application/vnd.yclients.v2+json',
    }
  });
  if (!res.data?.success) throw new Error(`Alteg error: ${res.data?.meta?.message || res.status}`);
  return res.data;
}

async function connectAlteg(partnerToken, userToken) {
  const data = await altegFetch(partnerToken, userToken, '/companies', { count: 10 });
  const companies = data?.data || [];
  if (!companies.length) throw new Error('Компании не найдены в Alteggio');
  const co = companies[0];
  return {
    company_id:   String(co.id),
    company_name: co.title || 'Alteggio Salon',
    city:         co.city?.title || '',
    currency:     co.currency?.symbol || '₴',
  };
}

async function syncAlteg(partnerToken, userToken, companyId) {
  const dateFrom = monthStart();
  const dateTo   = today();

  const visits = await altegFetch(partnerToken, userToken,
    `/records/${companyId}`, {
      start_date: dateFrom,
      end_date:   dateTo,
      count:      500,
      status:     '1,2,8',
    }
  );

  const items    = visits?.data || [];
  const revenue  = items.reduce((s,r) => s + Number(r.cost || 0), 0);
  const count    = items.length;
  const avgCheck = count > 0 ? Math.round(revenue / count) : 0;

  const masterMap = {};
  items.forEach(r => {
    r.staff?.forEach(st => {
      const name = st.name || 'Мастер';
      if (!masterMap[name]) masterMap[name] = { name, revenue: 0, visits: 0 };
      masterMap[name].revenue += Number(r.cost || 0) / (r.staff?.length || 1);
      masterMap[name].visits  += 1;
    });
  });
  const masters = Object.values(masterMap)
    .sort((a,b) => b.revenue - a.revenue)
    .map(m => ({ ...m, revenue: Math.round(m.revenue) }));

  const todayItems = items.filter(r => (r.datetime || '').slice(0,10) === today());
  const todayRev   = todayItems.reduce((s,r) => s + Number(r.cost||0), 0);

  return {
    period:      dateFrom.slice(0,7),
    revenue:     Math.round(revenue),
    visits:      count,
    avg_check:   avgCheck,
    new_clients: Math.round(count * 0.2),
    masters,
    today: {
      revenue:   Math.round(todayRev),
      visits:    todayItems.length,
      avg_check: todayItems.length > 0 ? Math.round(todayRev / todayItems.length) : 0,
    },
    raw_count: items.length,
    source: 'alteg',
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// DISPATCHER — connect and sync any service
// ═══════════════════════════════════════════════════════════════════════════════
const CONNECTORS = {
  dikidi:    { connect: connectDikidi,    sync: syncDikidi    },
  yclients:  { connect: connectYclients,  sync: syncYclients  },
  alteg:     { connect: connectAlteg,     sync: syncAlteg     },
  booksy:    { connect: connectBooksy,    sync: syncBooksy    },
  simplybook:{ connect: connectSimplybook,sync: syncSimplybook},
  timify:    { connect: connectTimify,    sync: syncTimify    },
  shore:     { connect: connectShore,     sync: syncShore     },
  poster:    { connect: connectPoster,    sync: syncPoster    },
};

async function connectService(service, credentials) {
  const connector = CONNECTORS[service];
  if (!connector) throw new Error(`Неизвестный сервис: ${service}`);

  const { apiKey, apiSecret, companyLogin } = credentials;

  switch(service) {
    case 'dikidi':    return connector.connect(apiKey);
    case 'yclients':  return connector.connect(apiKey, apiSecret);
    case 'alteg':     return connector.connect(apiKey, apiSecret);
    case 'booksy':    return connector.connect(apiKey);
    case 'simplybook':return connector.connect(companyLogin, apiKey);
    case 'timify':    return connector.connect(apiKey);
    case 'shore':     return connector.connect(apiKey);
    case 'poster':    return connector.connect(apiKey);
    default: throw new Error(`Нет обработчика для: ${service}`);
  }
}

async function syncService(service, credentials, companyId, extra = {}) {
  const connector = CONNECTORS[service];
  if (!connector) throw new Error(`Неизвестный сервис: ${service}`);

  const { apiKey, apiSecret, companyLogin } = credentials;

  switch(service) {
    case 'dikidi':    return connector.sync(apiKey, companyId);
    case 'yclients':  return connector.sync(apiKey, apiSecret, companyId);
    case 'alteg':     return connector.sync(apiKey, apiSecret, companyId);
    case 'booksy':    return connector.sync(apiKey, companyId);
    case 'simplybook':return connector.sync(extra.company_login || companyLogin, apiKey);
    case 'timify':    return connector.sync(apiKey, companyId);
    case 'shore':     return connector.sync(apiKey, companyId);
    case 'poster':    return connector.sync(apiKey);
    default: throw new Error(`Нет обработчика sync для: ${service}`);
  }
}

module.exports = { connectService, syncService };
