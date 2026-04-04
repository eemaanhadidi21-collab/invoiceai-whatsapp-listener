const { Client, LocalAuth } = require("whatsapp-web.js");
const QRCode = require("qrcode");
const http = require("http");
const fs = require("fs");
const path = require("path");

const QR_PATH = "/tmp/qr.png";

const WEBHOOK_URL =
  "https://invoiceai-dashboard-575.netlify.app/api/webhook";

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: "./session" }),
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

client.on("ready", () => {
  console.log("WhatsApp client is ready");
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

client.on("message", async (msg) => {
  try {
    const chat = await msg.getChat();
    const contact = await msg.getContact();

    const payload = {
      from: msg.from,
      to: msg.to,
      body: msg.body,
      timestamp: msg.timestamp,
      type: msg.type,
      isGroup: chat.isGroup,
      chatName: chat.name,
      contactName: contact.pushname || contact.name || msg.from,
      messageId: msg.id._serialized,
    };

    if (msg.hasMedia) {
      const media = await msg.downloadMedia();
      if (media) {
        payload.media = {
          mimetype: media.mimetype,
          filename: media.filename || null,
          data: media.data,
        };
      }
    }

    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      console.error(`Webhook error ${res.status}: ${await res.text()}`);
    } else {
      console.log(`Forwarded message from ${payload.contactName}`);
    }
  } catch (err) {
    console.error("Failed to forward message:", err.message);
  }
});

const server = http.createServer((req, res) => {
  if (req.url === "/qr") {
    if (fs.existsSync(QR_PATH)) {
      res.writeHead(200, { "Content-Type": "image/png" });
      fs.createReadStream(QR_PATH).pipe(res);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("QR code not yet generated");
    }
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
});

server.listen(3000, () => {
  console.log("QR server running at http://localhost:3000/qr");
});

client.initialize();
