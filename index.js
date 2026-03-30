import { execSync } from "child_process";
import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg;
import qrcode from "qrcode-terminal";
import Anthropic from "@anthropic-ai/sdk";
import ExcelJS from "exceljs";

const START_OF_2025 = new Date("2025-01-01T00:00:00");
let anthropic;

function promptForKey() {
  if (process.env.ANTHROPIC_API_KEY) {
    console.log("Found ANTHROPIC_API_KEY in environment.\n");
    anthropic = new Anthropic();
    return;
  }
  process.stdout.write("Paste your Anthropic API key: ");
  const key = execSync("read -r line && echo $line", {
    encoding: "utf-8",
    stdio: ["inherit", "pipe", "pipe"],
  }).trim();
  if (!key) {
    console.error("No API key provided. Exiting.");
    process.exit(1);
  }
  process.env.ANTHROPIC_API_KEY = key;
  anthropic = new Anthropic();
  console.log("API key set.\n");
}

async function analyzeConversation(messages) {
  const sample = messages.slice(0, 50).map((m) => m.body).filter(Boolean).join("\n");
  if (!sample.trim()) return null;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 50,
    messages: [
      {
        role: "user",
        content: `Analyze this WhatsApp conversation and answer in exactly this JSON format, nothing else:
{"is_lead": true/false, "status": "customer|hot|warm|cold|not_lead", "language": "Hebrew|English"}

Rules:
- "is_lead" = true if the person shows ANY sign of being a customer, potential customer, business lead, someone asking about services/products/pricing, or someone you've done business with.
- "is_lead" = false if this is clearly a personal/family/friend chat with zero business context.
- "status": "customer" = existing/past customer, "hot" = actively interested, "warm" = showed some interest, "cold" = minimal interest but still a lead, "not_lead" = personal contact.
- "language": primary language of the conversation.

Conversation:
${sample}`,
      },
    ],
  });

  try {
    return JSON.parse(response.content[0].text.trim());
  } catch {
    return null;
  }
}

function extractEmails(messages) {
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const emails = new Set();
  for (const msg of messages) {
    const found = msg.body?.match(emailRegex);
    if (found) found.forEach((e) => emails.add(e));
  }
  return [...emails].join(", ");
}

async function main() {
  promptForKey();

  console.log("Starting WhatsApp Web client...");
  console.log("Looking for cached session in .wwebjs_auth/...\n");

  const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      headless: true,
      args: ["--no-sandbox"],
      protocolTimeout: 3600000,
    },
  });

  client.on("qr", (qr) => {
    console.log("No cached session found. Scan this QR code with WhatsApp:\n");
    qrcode.generate(qr, { small: true });
  });

  client.on("authenticated", () => {
    console.log("\nAuthenticated successfully!");
  });

  await new Promise((resolve, reject) => {
    client.on("ready", resolve);
    client.on("auth_failure", reject);
    client.initialize();
  });

  console.log("WhatsApp Web client is ready!\n");
  console.log("Fetching chats (this may take a few minutes)...\n");
  console.log("Scrolling chat list to load older conversations...\n");

  // Force WhatsApp Web to load more chats by scrolling the chat list
  const page = client.pupPage;
  let prevCount = 0;
  let stableRounds = 0;

  for (let scroll = 0; scroll < 300; scroll++) {
    await page.evaluate(() => {
      const chatListEl = document.querySelector('[data-tab="3"]') ||
        document.querySelector("#pane-side") ||
        document.querySelector("[data-testid='chat-list']");
      if (chatListEl) {
        chatListEl.scrollTop = chatListEl.scrollHeight;
      }
    });
    await new Promise((r) => setTimeout(r, 800));

    // Check count every 5 scrolls to avoid slowdown
    if ((scroll + 1) % 5 === 0) {
      const currentCount = (await client.getChats()).length;
      if (currentCount === prevCount) {
        stableRounds++;
        if (stableRounds >= 3) {
          console.log(`Chat list fully loaded after ${scroll + 1} scrolls (${currentCount} chats).`);
          break;
        }
      } else {
        stableRounds = 0;
        console.log(`  Scroll ${scroll + 1}: ${currentCount} chats loaded...`);
      }
      prevCount = currentCount;
    }
  }

  const chats = await client.getChats();
  const directChats = chats.filter((c) => !c.isGroup);
  console.log(`\nFound ${chats.length} total chats (${directChats.length} direct, ${chats.length - directChats.length} groups).\n`);

  const rows = [];
  const total = directChats.length;

  for (let i = 0; i < directChats.length; i++) {
    const chat = directChats[i];
    const contact = await chat.getContact();
    const name = contact.pushname || contact.name || chat.name || "Unknown";
    const phone = contact.number || chat.id.user || "";

    console.log(`[${i + 1}/${total}] ${name} (${phone})`);

    let allMessages = [];
    try {
      // Fetch in batches to get messages going back to 2025
      let messages = await chat.fetchMessages({ limit: 500 });
      allMessages = messages;

      // If oldest message is still in 2025+, try to load more
      if (messages.length === 500) {
        const oldest = messages[0];
        if (oldest && oldest.timestamp * 1000 >= START_OF_2025.getTime()) {
          try {
            const moreMessages = await chat.fetchMessages({ limit: 1000 });
            allMessages = moreMessages;
          } catch {
            // stick with what we have
          }
        }
      }
    } catch (err) {
      console.log(`  Skipped — failed to fetch messages: ${err.message}`);
      continue;
    }

    const recentMessages = allMessages.filter(
      (m) => m.timestamp * 1000 >= START_OF_2025.getTime()
    );

    if (recentMessages.length === 0) {
      console.log(`  Skipped — no messages in 2025`);
      continue;
    }

    console.log(`  Found ${recentMessages.length} messages in 2025`);

    const textMessages = recentMessages.filter((m) => m.body?.trim());

    if (textMessages.length === 0) {
      console.log(`  Skipped — no text messages`);
      continue;
    }

    let analysis;
    try {
      analysis = await analyzeConversation(textMessages);
    } catch (err) {
      console.error(`  Analysis failed: ${err.message}`);
      continue;
    }

    if (!analysis || !analysis.is_lead) {
      console.log(`  Skipped — not a lead/customer`);
      continue;
    }

    const email = extractEmails(recentMessages);

    rows.push({ name, phone, email, language: analysis.language || "Unknown", status: analysis.status || "Unknown" });
    console.log(`  -> ${analysis.status.toUpperCase()} | ${analysis.language}${email ? ` | Email: ${email}` : ""}`);
  }

  console.log(`\nProcessed ${rows.length} contacts. Writing Excel file...`);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("WhatsApp Contacts");

  sheet.columns = [
    { header: "Name", key: "name", width: 25 },
    { header: "Phone Number", key: "phone", width: 20 },
    { header: "Email", key: "email", width: 35 },
    { header: "Language", key: "language", width: 15 },
    { header: "Status", key: "status", width: 15 },
  ];

  sheet.getRow(1).font = { bold: true };

  for (const row of rows) {
    sheet.addRow(row);
  }

  const filename = "whatsapp_contacts.xlsx";
  await workbook.xlsx.writeFile(filename);
  console.log(`\nDone! Saved to ${filename}`);

  await client.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
