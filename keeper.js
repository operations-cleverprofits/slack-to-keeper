// keeper.js
const axios = require("axios");

const BASE_URL =
  process.env.KEEPER_API_BASE ||
  process.env.KEEPER_BASE_URL ||
  "https://api.keeper.app";
const OAUTH_URL = process.env.KEEPER_OAUTH_URL || `${BASE_URL}/oauth/token`;
const CLIENT_ID = process.env.KEEPER_CLIENT_ID;
const CLIENT_SECRET = process.env.KEEPER_CLIENT_SECRET;

let _cachedToken = null;
let _tokenExp = 0;

async function getToken() {
  const now = Date.now();
  if (_cachedToken && now < _tokenExp - 60_000) return _cachedToken;

  const resp = await axios.post(
    OAUTH_URL,
    new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  _cachedToken = resp.data.access_token;
  _tokenExp = now + (resp.data.expires_in || 3600) * 1000;
  return _cachedToken;
}

async function apiGet(path) {
  const token = await getToken();
  const { data } = await axios.get(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return data;
}

async function apiPost(path, body) {
  const token = await getToken();
  const { data } = await axios.post(`${BASE_URL}${path}`, body, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });
  return data;
}

async function apiPatch(path, body) {
  const token = await getToken();
  const { data } = await axios.patch(`${BASE_URL}${path}`, body, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });
  return data;
}

// ---- Normalizadores auxiliares
function pickList(resp) {
  return Array.isArray(resp)
    ? resp
    : resp.items || resp.results || resp.clients || resp.data || [];
}

function mapClient(c) {
  return {
    id: c.id,
    name:
      c.name ||
      c.clientName ||
      c.title ||
      c.companyName ||
      c.client_name ||
      c.company,
  };
}

// === Buscar (máx 100)
async function getClients(search) {
  const params = new URLSearchParams();
  params.set("limit", 100);
  if (search) params.set("search", search);

  const resp = await apiGet(`/api/clients/summary?${params.toString()}`);
  return pickList(resp).map(mapClient).filter((c) => c.id && c.name);
}

// === Traer todos (precache)
async function getAllClients() {
  const limit = 100;
  const aggregated = [];
  const seen = new Set();

  let cursor = 0;
  let usePage = false;

  while (true) {
    let params = new URLSearchParams();
    params.set("limit", limit);

    if (usePage) {
      const pageIdx = cursor + 1;
      params.set("page", pageIdx);
      params.set("pageNumber", pageIdx);
      params.set("pageSize", limit);
    } else {
      const offset = cursor * limit;
      params.set("skip", offset);
      params.set("offset", offset);
    }

    let resp;
    try {
      resp = await apiGet(`/api/clients/summary?${params.toString()}`);
    } catch (e) {
      if (!usePage) {
        usePage = true;
        continue;
      }
      throw e;
    }

    const list = pickList(resp);
    const before = seen.size;

    for (const c of list) {
      if (!c?.id || seen.has(c.id)) continue;
      seen.add(c.id);
      aggregated.push(mapClient(c));
    }

    if (list.length < limit) break;

    if (seen.size === before) {
      if (usePage) break;
      usePage = true;
      continue;
    }

    cursor += 1;
  }

  return aggregated.filter((c) => c.id && c.name);
}

async function getUsers() {
  const list = await apiGet(`/api/users`);
  return list.map((u) => ({ id: u.id, name: u.name }));
}

/**
 * Crea una tarea en Keeper y guarda la descripción en varios campos
 * para máxima compatibilidad visual.
 */
async function createTask(clientId, assigneeId, title, description, dueDate) {
  const rawTitle = String(title || "").trim();
  const rawDesc  = String(description || "").trim();
  const fallbackTitle =
    rawDesc.split(/\r?\n/)[0]?.slice(0, 255) || "Task from Slack";

  // OJO: el campo del backend es `subText` (T mayúscula)
  const body = {
    clientId: Number(clientId),
    taskName: (rawTitle || fallbackTitle).slice(0, 255),
    description: rawDesc || undefined,
    subText: rawDesc || undefined,
    notes: rawDesc || undefined,
    assignedTo: assigneeId ? Number(assigneeId) : undefined,
    priority: false,
    dueDate: dueDate || undefined,
  };
  Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);

  const created = await apiPost(`/api/non-closing-tasks`, body);

  // Fallback: asegurar que subText quedó escrito
  if (rawDesc) {
    const taskId = created?.id || created?.taskId || created?.data?.id;
    if (taskId) {
      try {
        await apiPatch(`/api/non-closing-tasks/${taskId}`, { subText: rawDesc });
      } catch {
        /* noop */
      }
    }
  }

  return created;
}

module.exports = {
  getClients,
  getAllClients,
  getUsers,
  createTask,
};


