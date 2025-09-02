// index.js
require("dotenv").config();
const { App, ExpressReceiver } = require("@slack/bolt");
const { getAllClients, getUsers, createTask, getClients } = require("./keeper");

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
// refresco periódico
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
      : cachedClients.slice(0, 50); // primeras 50 al abrir sin escribir

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
  // carga usuarios para el dropdown de asignatario
  const users = await getUsers();
  const initialMsg =
    shortcut?.message?.text ||
    shortcut?.message?.blocks?.[0]?.text?.text ||
    "";

  await client.views.open({
    trigger_id: shortcut.trigger_id,
    view: {
      type: "modal",
      callback_id: "create_keeper_task",
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
            options: users.slice(0, 100).map(u => ({
              text: { type: "plain_text", text: u.name },
              value: String(u.id),
            })),
          },
        },
        {
          type: "input",
          block_id: "message_block",
          label: { type: "plain_text", text: "Task Description" },
          element: {
            type: "plain_text_input",
            action_id: "message_action",
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
    const clientId = view.state.values.client_block.client_action.selected_option.value;
    const assigneeId = view.state.values.assignee_block.assignee_action.selected_option.value;
    const message = view.state.values.message_block.message_action.value;
    const dueDate = view.state.values.due_date_block?.due_date_action?.selected_date;

    await createTask(clientId, assigneeId, message, dueDate);

    // aviso al usuario (ephemeral); puede fallar si no hay canal
    try {
      await client.chat.postEphemeral({
        channel: body.view?.private_metadata || body.user?.team_id,
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

