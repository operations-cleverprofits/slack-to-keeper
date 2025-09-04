// index.js
require("dotenv").config();
const { App, ExpressReceiver } = require("@slack/bolt");
const { getAllClients, getUsers, createTask } = require("./keeper");

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse: true,
});

// Healthchecks
receiver.app.get("/", (_req, res) => res.status(200).send("OK - Slack Keeper Integration"));
receiver.app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

/** ---------- Utils ---------- */
// Convierte <@U123|...> a @Display Name para mostrar bonito en el modal (y opcionalmente en Keeper)
async function expandUserMentionsToNames(text, client) {
  if (!text) return "";
  const regex = /<@([A-Z0-9]+)(?:\|[^>]+)?>/g;
  const ids = [...new Set([...text.matchAll(regex)].map(m => m[1]))];
  if (ids.length === 0) return text;

  const nameById = {};
  for (const id of ids) {
    try {
      const info = await client.users.info({ user: id });
      const prof = info?.user?.profile || {};
      const name =
        prof.display_name_normalized ||
        prof.display_name ||
        info?.user?.real_name ||
        info?.user?.name ||
        id;
      nameById[id] = `@${name}`;
    } catch { /* ignore */ }
  }
  return text.replace(regex, (_m, id) => nameById[id] || `@${id}`);
}

// Convierte <#C123|canal> a #canal y <!here> etc. a @here (opcional, por estética)
function tidyOtherMentions(text) {
  return String(text || "")
    .replace(/<#([A-Z0-9]+)\|([^>]+)>/g, (_m, _id, name) => `#${name}`)
    .replace(/<!here>/g, "@here")
    .replace(/<!channel>/g, "@channel")
    .replace(/<!everyone>/g, "@everyone");
}

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
      ctx?.options?.value ??
      ctx?.payload?.value ??
      (ctx?.body?.value || "");
    const query = String(raw || "").toLowerCase();

    if (!cachedClients.length) await preloadClients();

    const pool = query
      ? cachedClients.filter(c => c.name && c.name.toLowerCase().includes(query))
      : cachedClients.slice(0, 50);

    const options = pool.slice(0, 100).map(c => ({
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

  // Usuarios para el dropdown
  const users = await getUsers();

  // Texto original del mensaje de Slack
  const rawMsg =
    shortcut?.message?.text ||
    shortcut?.message?.blocks?.[0]?.text?.text ||
    "";

  // ⇩⇩ NUEVO: expandir menciones a @Nombre SOLO para mostrar en el modal
  const prettyMsg = tidyOtherMentions(await expandUserMentionsToNames(rawMsg, client));

  await client.views.open({
    trigger_id: shortcut.trigger_id,
    view: {
      type: "modal",
      callback_id: "create_keeper_task",
      title: { type: "plain_text", text: "Send to Keeper" },
      submit: { type: "plain_text", text: "Create Task" },
      close: { type: "plain_text", text: "Cancel" },
      private_metadata: JSON.stringify({
        channel: shortcut?.channel?.id || shortcut?.channel?.id,
        ts: shortcut?.message?.ts,
      }),
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
            options: users.slice(0, 100).map(u => ({
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
            initial_value: prettyMsg, // ← ya con @Nombre
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

    // Descripción que escribe la persona (podría tener menciones nuevas)
    const rawDesc =
      view.state.values.description_block.description_action.value;

    // Bonito con nombres para Keeper
    const prettyDesc = tidyOtherMentions(await expandUserMentionsToNames(rawDesc, client));

    // Añadir link del mensaje original al final (solo para Keeper)
    let finalDesc = prettyDesc;
    try {
      const meta = JSON.parse(body.view?.private_metadata || "{}");
      if (meta.channel && meta.ts) {
        const { permalink } = await client.chat.getPermalink({
          channel: meta.channel,
          message_ts: meta.ts,
        });
        if (permalink) {
          finalDesc += `\n\n:link: Slack message: ${permalink}`;
        }
      }
    } catch { /* ignore */ }

    const dueDate =
      view.state.values.due_date_block?.due_date_action?.selected_date;

    await createTask(clientId, assigneeId, title, finalDesc, dueDate);

    try {
      await client.chat.postEphemeral({
        channel: body.user?.id, // si no hay canal del mensaje, mandar al usuario
        user: body.user.id,
        text: `✅ Task creada en Keeper (clientId: ${clientId}).`,
      });
    } catch {}
  } catch (err) {
    console.error("Error creando task en Keeper:", err?.message || err);
  }
});

const port = process.env.PORT || 3000;
receiver.app.listen(port, () => {
  console.log(`🚀 App running on port ${port}`);
});


