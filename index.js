import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg;
import qrcode from "qrcode-terminal";
import ExcelJS from "exceljs";

const START_OF_2025 = new Date("2025-01-01T00:00:00");

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
      let messages = await chat.fetchMessages({ limit: 500 });
      allMessages = messages;

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
      console.log(`  Skipped — no messages since Jan 2025`);
      continue;
    }

    const messageCount = recentMessages.length;
    const lastMsg = recentMessages[recentMessages.length - 1];
    const lastMessageDate = new Date(lastMsg.timestamp * 1000).toISOString().split("T")[0];
    const email = extractEmails(recentMessages);

    rows.push({ name, phone, email, messageCount, lastMessageDate });
    console.log(`  ${messageCount} messages | last: ${lastMessageDate}${email ? ` | ${email}` : ""}`);
  }

  console.log(`\nExporting ${rows.length} contacts to Excel...`);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("WhatsApp Contacts");

  sheet.columns = [
    { header: "Name", key: "name", width: 25 },
    { header: "Phone Number", key: "phone", width: 20 },
    { header: "Email", key: "email", width: 35 },
    { header: "Messages (since Jan 2025)", key: "messageCount", width: 25 },
    { header: "Last Message Date", key: "lastMessageDate", width: 20 },
  ];

  sheet.getRow(1).font = { bold: true };

  for (const row of rows) {
    sheet.addRow(row);
  }

  const filename = "whatsapp_contacts.xlsx";
  await workbook.xlsx.writeFile(filename);
  console.log(`\nDone! Saved ${rows.length} contacts to ${filename}`);

  await client.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
