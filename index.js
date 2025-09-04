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

/** ---------- Helpers ---------- */
// Reemplaza <@UXXXX> por @Display Name
async function expandMentionsToNames(text, client) {
  if (!text) return text;
  const re = /<@([A-Z0-9]+)>/g;
  const ids = new Set();
  let m;
  while ((m = re.exec(text))) ids.add(m[1]);
  if (!ids.size) return text;

  const cache = new Map();
  for (const id of ids) {
    try {
      const { user } = await client.users.info({ user: id });
      const name =
        user?.profile?.display_name ||
        user?.real_name ||
        user?.name ||
        id;
      cache.set(id, name);
    } catch {
      cache.set(id, id);
    }
  }

  let out = text;
  for (const [id, name] of cache.entries()) {
    const token = new RegExp(`<@${id}>`, "g");
    out = out.replace(token, `@${name}`);
  }
  return out;
}

/** ---------- Opciones del external_select (client_action) ---------- */
slackApp.options("client_action", async (ctx) => {
  const { ack } = ctx;
  try {
    const raw =
      ctx?.options?.value ?? ctx?.payload?.value ?? (ctx?.body?.value || "");
    const query = String(raw || "").toLowerCase();

    if (!cachedClients.length) await preloadClients();

    const pool = query
      ? cachedClients.filter(
          (c) => c.name && c.name.toLowerCase().includes(query)
        )
      : cachedClients.slice(0, 50);

    const options = pool.slice(0, 100).map((c) => ({
      text: { type: "plain_text", text: c.name },
      value: String(c.id),
    }));

    await ack({ options });
  } catch {
    try { await ack({ options: [] }); } catch {}
  }
});

/** ---------- Shortcut: abre el modal ---------- */
slackApp.shortcut("send_to_keeper", async ({ shortcut, ack, client }) => {
  await ack();

  const users = await getUsers();

  const initialMsg =
    shortcut?.message?.text ||
    shortcut?.message?.blocks?.[0]?.text?.text ||
    "";

  // Obtener permalink + guardar metadatos para el submit
  const channelId =
    shortcut?.channel?.id ||
    shortcut?.message?.channel ||
    shortcut?.channel_id ||
    "";
  const message_ts = shortcut?.message?.ts;
  const teamId = shortcut?.team?.id || shortcut?.user?.team_id || "";

  let permalink = "";
  try {
    if (channelId && message_ts) {
      const r = await client.chat.getPermalink({ channel: channelId, message_ts });
      permalink = r?.permalink || "";
    }
  } catch (e) {
    console.warn("No pude obtener permalink:", e?.data?.error || e?.message);
  }

  await client.views.open({
    trigger_id: shortcut.trigger_id,
    view: {
      type: "modal",
      callback_id: "create_keeper_task",
      private_metadata: JSON.stringify({ permalink, channelId, message_ts, teamId }),
      title: { type: "plain_text", text: "Send to Keeper" },
      submit: { type: "plain_text", text: "Create Task" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [
        {
          type: "input",
          block_id: "client_block",
          label: { type: "plain_text", text: "Select Client" },
          element: {
            type: "external_select",
            action_id: "client_action",
            min_query_length: 0,
            placeholder: { type: "plain_text", text: "Pick a client" },
          },
        },
        {
          type: "input",
          block_id: "assignee_block",
          label: { type: "plain_text", text: "Assign To" },
          element: {
            type: "static_select",
            action_id: "assignee_action",
            placeholder: { type: "plain_text", text: "Pick a user" },
            options: users.slice(0, 100).map((u) => ({
              text: { type: "plain_text", text: u.name },
              value: String(u.id),
            })),
          },
        },
        {
          type: "input",
          block_id: "task_title_block",
          label: { type: "plain_text", text: "Task Title" },
          element: {
            type: "plain_text_input",
            action_id: "task_title_action",
            initial_value: "",
          },
        },
        {
          type: "input",
          block_id: "description_block",
          label: { type: "plain_text", text: "Description" },
          element: {
            type: "plain_text_input",
            action_id: "description_action",
            multiline: true,
            initial_value: initialMsg,
          },
        },
        {
          type: "input",
          block_id: "due_date_block",
          optional: true,
          label: { type: "plain_text", text: "Due Date" },
          element: {
            type: "datepicker",
            action_id: "due_date_action",
            placeholder: { type: "plain_text", text: "Select a date" },
          },
        },
      ],
    },
  });
});

/** ---------- Submit del modal: crear tarea ---------- */
slackApp.view("create_keeper_task", async ({ ack, body, view, client }) => {
  await ack();
  try {
    const clientId =
      view.state.values.client_block.client_action.selected_option.value;
    const assigneeId =
      view.state.values.assignee_block.assignee_action.selected_option.value;

    const title =
      view.state.values.task_title_block.task_title_action.value;
    let descriptionRaw =
      view.state.values.description_block.description_action.value;
    const dueDate =
      view.state.values.due_date_block?.due_date_action?.selected_date;

    // Expandir menciones <@U…> -> @Nombre
    descriptionRaw = await expandMentionsToNames(descriptionRaw, client);

    // Recuperar metadatos y asegurar permalink
    let meta = {};
    try { meta = JSON.parse(body.view?.private_metadata || "{}"); } catch {}
    let { permalink, channelId, message_ts, teamId } = meta;

    if (!permalink && channelId && message_ts) {
      try {
        const r = await client.chat.getPermalink({ channel: channelId, message_ts });
        permalink = r?.permalink || "";
      } catch {
        // Fallback: link al cliente de Slack (no requiere domain)
        const tsCompact = String(message_ts || "").replace(".", "");
        if (teamId && channelId && tsCompact) {
          permalink = `https://app.slack.com/client/${teamId}/${channelId}/p${tsCompact}`;
        }
      }
    }

    const description = permalink
      ? `${(descriptionRaw || "").trim()}\n\n🔗 Slack message: ${permalink}`
      : descriptionRaw;

    await createTask(clientId, assigneeId, title, description, dueDate);

    // Aviso ephemeral si hay channelId
    try {
      if (channelId) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: body.user.id,
          text: `✅ Task creada en Keeper (clientId: ${clientId}).`,
        });
      }
    } catch {}
  } catch (err) {
    console.error("Error creando task en Keeper:", err?.message || err);
  }
});

const port = process.env.PORT || 3000;
receiver.app.listen(port, () => {
  console.log(`🚀 App running on port ${port}`);
});


