// index.js
require("dotenv").config();
const { App, ExpressReceiver } = require("@slack/bolt");
const { getAllClients, getUsers, createTask } = require("./keeper");

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse: true,
});

// Healthchecks
receiver.app.get("/", (_req, res) =>
  res.status(200).send("OK - Slack Keeper Integration")
);
receiver.app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

/** ---------- Precarga de clientes (caché) ---------- */
let cachedClients = [];
async function preloadClients() {
  try {
    cachedClients = await getAllClients();
    console.info(`Cached ${cachedClients.length} Keeper clients`);
  } catch (err) {
    console.error("Error preloading Keeper clients:", err?.message || err);
  }
}
preloadClients();
setInterval(preloadClients, 30 * 60 * 1000);

/** ---------- Opciones del external_select (client_action) ---------- */
slackApp.options("client_action", async (ctx) => {
  const { ack } = ctx;
  try {
    const raw =
      ctx?.options?.value ?? ctx?.payload?.value ?? (ctx?.body?.value || "");
    const query = String(raw || "").toLowerCase();

    if (!cachedClients.length) await prelo



