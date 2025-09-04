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
receiver.app.get("/health", (_req, res) =>
  res.status(200).json({ ok: true })
);

const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

/** ========= Utils: text normalization ========= **/

// 1) HTML entities
function decodeEntities(s) {
  return String(s || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// 2) Slack links: <url|Label> -> "Label (url)" ; <url> -> "url"
function convertSlackLinks(s) {
  return String(s || "")
    .replace(/<([^|>\s]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<([^|>]+)>/g, "$1");
}

// 3) Mentions: supports <@UXXXX> and @UXXXX (without < >)
async function expandSlackMentions(text, client) {
  const raw = String(text || "");

  const idsAngle = [...raw.matchAll(/<@([UW][A-Z0-9]+)>/g)].map(m => m[1]);
  const idsAt    = [...raw.matchAll(/(?<![A-Za-z0-9._%+-])@([UW][A-Z0-9]{8,})\b/g)].map(m => m[1]);
  const ids = Array.from(new Set([...idsAngle, ...idsAt]));
  if (!ids.length) return raw;

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
    } catch {
      nameById[id] = `@${id}`;
    }
  }

  let out = raw;
  out = out.replace(/<@([UW][A-Z0-9]+)>/g, (_m, id) => nameById[id] || `@${id}`);
  out = out.replace(/(?<![A-Za-z0-9._%+-])@([UW][A-Z0-9]{8,})\b/g, (_m, id) => nameById[id] || `@${id}`);
  return out;
}

// 4) Other mention types
function convertOtherMentions(s) {
  return String(s || "")
    .replace(/<#([A-Z0-9]+)\|([^>]+)>/g, (_m, _id, name) => `#${name}`)
    .replace(/<!here>/g, "@here")
    .replace(/<!channel>/g, "@channel")
    .replace(/<!everyone>/g, "@everyone");
}

// 5) Remove inline formatting (* _ ~ ` > etc.)
function stripFormatting(s) {
  let t = String(s || "");
  // quotes at the beginning of lines ( > and &gt; )
  t = t.replace(/(^|\n)\s*(?:>|&gt;)\s?/g, "$1");
  // **bold** or *bold*
  t = t.replace(/\*\*(.*?)\*\*/g, "$1").replace(/\*(.*?)\*/g, "$1");
  // __bold__ or _italic_
  t = t.replace(/__(.*?)__/g, "$1").replace(/_(.*?)_/g, "$1");
  // ~strikethrough~
  t = t.replace(/~(.*?)~/g, "$1");
  // `code` and ```blocks```
  t = t.replace(/```([\s\S]*?)```/g, "$1").replace(/`([^`]*)`/g, "$1");
  return t;
}

// 6) Whitespace
function normalizeWhitespace(s) {
  return String(s || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Full pipeline
async function toPlainText(text, client) {
  let s = decodeEntities(text);
  s = convertSlackLinks(s);
  s = await expandSlackMentions(s, client);
  s = convertOtherMentions(s);
  s = stripFormatting(s);
  s = normalizeWhitespace(s);
  return s;
}

/** ---------- Client preload (cache) ---------- */
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

/** ---------- external_select options (client_action) ---------- */
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

/** ---------- Shortcut: open modal ---------- */
slackApp.shortcut("send_to_keeper", async ({ shortcut, ack, client }) => {
  await ack();

  const original =
    shortcut?.message?.text ||
    shortcut?.message?.blocks?.[0]?.text?.text ||
    "";

  // Clean text with expanded mentions for the modal
  const initialMsg = await toPlainText(original, client);

  // Save channel and ts to build a permalink later
  const privateMeta = JSON.stringify({
    channel: shortcut?.channel?.id || shortcut?.channel,
    ts: shortcut?.message?.ts,
  });

  const users = await getUsers();

  await client.views.open({
    trigger_id: shortcut.trigger_id,
    view: {
      type: "modal",
      callback_id: "create_keeper_task",
      private_metadata: privateMeta,
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

/** ---------- Modal submit: create task ---------- */
slackApp.view("create_keeper_task", async ({ ack, body, view, client }) => {
  await ack();
  try {
    const clientId =
      view.state.values.client_block.client_action.selected_option.value;
    const assigneeId =
      view.state.values.assignee_block.assignee_action.selected_option.value;

    const title =
      view.state.values.task_title_block.task_title_action.value;

    let description =
      view.state.values.description_block.description_action.value;

    const dueDate =
      view.state.values.due_date_block?.due_date_action?.selected_date;

    // Re-clean in case the user edited with formatting
    description = await toPlainText(description, client);

    // Append original message permalink
    let permalink = "";
    try {
      const meta = JSON.parse(view.private_metadata || "{}");
      if (meta?.channel && meta?.ts) {
        const pl = await client.chat.getPermalink({
          channel: meta.channel,
          message_ts: meta.ts,
        });
        permalink = pl?.permalink;
      }
    } catch { /* noop */ }

    const finalDescription =
      permalink ? `${description}\n\nSlack message: ${permalink}` : description;

    await createTask(clientId, assigneeId, title, finalDescription, dueDate);
  } catch (err) {
    console.error("Error creating task in Keeper:", err?.data || err?.message || err);
  }
});

const port = process.env.PORT || 3000;
receiver.app.listen(port, () => {
  console.log(`🚀 App running on port ${port}`);
});




