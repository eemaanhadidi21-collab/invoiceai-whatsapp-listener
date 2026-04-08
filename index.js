const { Client, LocalAuth } = require("whatsapp-web.js");
const QRCode = require("qrcode");
const http = require("http");
const fs = require("fs");
const path = require("path");

const QR_PATH = "/tmp/qr.png";

const WEBHOOK_URL =
  "https://invoiceai-dashboard-575.netlify.app/api/webhook";

// Clean up Chromium lock files from previous runs
const SESSION_DIR = "/data/session";
try {
  const cleanLocks = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) cleanLocks(full);
      else if (entry.name === "SingletonLock" || entry.name === "SingletonCookie" || entry.name === "SingletonSocket") {
        fs.unlinkSync(full);
        console.log(`Removed lock file: ${full}`);
      }
    }
  };
  cleanLocks(SESSION_DIR);
} catch (err) {
  console.error("Lock cleanup error:", err.message);
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: "/data/session" }),
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process",
    ],
  },
});

client.on("qr", async (qr) => {
  await QRCode.toFile(QR_PATH, qr, { width: 300 });
  console.log(`QR code saved to ${QR_PATH} — view at http://localhost:3000/qr`);
});

client.on("ready", async () => {
  console.log("WhatsApp client is ready");
  try {
    const chats = await client.getChats();
    const groups = chats.filter((c) => c.isGroup);
    console.log(`Found ${groups.length} group chats:`);
    groups.forEach((g) => {
      console.log(`  [GROUP] "${g.name}" → ${g.id._serialized}`);
    });
  } catch (err) {
    console.error("Failed to list group chats:", err.message);
  }
});

client.on("authenticated", () => {
  console.log("Authenticated successfully");
});

client.on("auth_failure", (msg) => {
  console.error("Authentication failed:", msg);
});

client.on("disconnected", (reason) => {
  console.log("Client disconnected:", reason);
  process.exit(1);
});

const TARGET_GROUP = "Invoice AI Ops";

const COMPLETION_PHRASES = [
  "done",
  "did it",
  "finished",
  "completed",
  "it's done",
  "its done",
];

function isCompletionPhrase(text) {
  const normalized = text.trim().toLowerCase().replace(/[.!?,]/g, "");
  return COMPLETION_PHRASES.includes(normalized);
}

async function handleMessage(msg) {
  try {
    // Guard against undefined / malformed messages (system events, status updates, etc.)
    if (!msg || !msg.body || !msg.from) {
      console.log("[skip] message missing body/from:", {
        hasMsg: !!msg,
        type: msg && msg.type,
        hasBody: !!(msg && msg.body),
        hasFrom: !!(msg && msg.from),
      });
      return;
    }

    // Only handle plain text chat messages
    if (msg.type && msg.type !== "chat") {
      return;
    }

    let chat;
    try {
      chat = await msg.getChat();
    } catch (chatErr) {
      console.error("Failed to get chat for message:", chatErr.message);
      return;
    }

    if (!chat || chat.name !== TARGET_GROUP) return;

    let contact;
    try {
      contact = await msg.getContact();
    } catch (contactErr) {
      console.error("Failed to get contact:", contactErr.message);
      contact = null;
    }

    const senderName =
      (contact && (contact.pushname || contact.name)) || msg.from;
    const phone = String(msg.from).replace("@c.us", "");

    const hasQuotedMsg = !!msg.hasQuotedMsg;
    const isCompletion = isCompletionPhrase(msg.body) || hasQuotedMsg;

    let referencedMessage = msg.body;
    if (hasQuotedMsg) {
      try {
        const quoted = await msg.getQuotedMessage();
        if (quoted && quoted.body) referencedMessage = quoted.body;
      } catch (quotedErr) {
        console.error("Failed to get quoted message:", quotedErr.message);
      }
    }

    const message = {
      type: "text",
      text: { body: msg.body },
      from: phone,
    };

    if (isCompletion) {
      message.action = "complete";
      message.referencedMessage = referencedMessage;
    }

    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [message],
                contacts: [
                  {
                    profile: { name: senderName },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      console.error(`Webhook error ${res.status}: ${await res.text()}`);
    } else {
      console.log(`Forwarded: "${msg.body}" from ${senderName}`);
    }
  } catch (err) {
    console.error("Message handler error:", err && err.stack ? err.stack : err);
    try {
      console.error(
        "Offending msg snapshot:",
        JSON.stringify(
          {
            type: msg && msg.type,
            from: msg && msg.from,
            to: msg && msg.to,
            hasBody: !!(msg && msg.body),
            hasId: !!(msg && msg.id),
            fromMe: msg && msg.fromMe,
          },
          null,
          2
        )
      );
    } catch {}
  }
}

client.on("message", handleMessage);
client.on("message_create", handleMessage);

const server = http.createServer((req, res) => {
  if (req.url === "/qr" && req.method === "GET") {
    if (fs.existsSync(QR_PATH)) {
      res.writeHead(200, { "Content-Type": "image/png" });
      fs.createReadStream(QR_PATH).pipe(res);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("QR code not yet generated");
    }
  } else if (req.url === "/send" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { to, message } = JSON.parse(body);
        if (!to || !message) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "to and message are required" }));
          return;
        }
        await client.sendMessage(to, message);
        console.log(`Sent message to ${to}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "sent" }));
      } catch (err) {
        console.error("Send error:", err.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
});

server.listen(3000, () => {
  console.log("QR server running at http://localhost:3000/qr");
});

client.initialize();
