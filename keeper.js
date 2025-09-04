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



