import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import twilio from "twilio";

const app = express();

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ─── Clients ───────────────────────────────────────────────────────────────────
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Conversation memory ───────────────────────────────────────────────────────
const conversationHistory = new Map();
const MAX_HISTORY = 20;

function getHistory(phone) {
  return conversationHistory.get(phone) || [];
}

function addToHistory(phone, role, content) {
  const history = getHistory(phone);
  history.push({ role, content });
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  conversationHistory.set(phone, history);
}

// ─── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a helpful, friendly personal assistant responding via WhatsApp.

Guidelines:
- Keep responses concise and conversational — this is a chat app, not email.
- Use plain text. Avoid markdown like **bold** or bullet points with dashes; 
  prefer short paragraphs or numbered lists if structure is needed.
- If asked something you don't know or that requires current info, use the web_search tool.
- Remember context from earlier in the conversation and refer back to it naturally.
- Be warm, direct, and useful.`;

// ─── Tools ─────────────────────────────────────────────────────────────────────
const tools = [
  {
    type: "web_search_20250305",
    name: "web_search",
  },
];

// ─── Claude agent ──────────────────────────────────────────────────────────────
async function getAgentReply(phone, userMessage) {
  addToHistory(phone, "user", userMessage);

  let loopMessages = [...getHistory(phone)];
  let response;

  while (true) {
    response = await anthropicClient.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools,
      messages: loopMessages,
    });

    if (response.stop_reason === "end_turn") {
      break;
    }

    if (response.stop_reason === "tool_use") {
      const assistantMsg = { role: "assistant", content: response.content };
      loopMessages.push(assistantMsg);

      const toolResults = response.content
        .filter((block) => block.type === "tool_use")
        .map((block) => ({
          type: "tool_result",
          tool_use_id: block.id,
          content: "",
        }));

      loopMessages.push({ role: "user", content: toolResults });
    } else {
      break;
    }
  }

  const replyText = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  addToHistory(phone, "assistant", replyText);

  return replyText;
}

// ─── Webhook ───────────────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  console.log("RAW BODY:", JSON.stringify(req.body));

  const from = req.body?.From;
  const userText = req.body?.Body;

  console.log("From:", from);
  console.log("Text:", userText);

  // Always respond 200 immediately to Twilio
  res.sendStatus(200);

  if (!from || !userText) {
    console.log("Missing from or body — ignoring");
    return;
  }

  try {
    if (userText.trim().toLowerCase() === "/forget") {
      conversationHistory.delete(from);
      await twilioClient.messages.create({
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to: from,
        body: "Memory cleared! Starting fresh.",
      });
      return;
    }

    const reply = await getAgentReply(from, userText);
    console.log("Reply:", reply);

    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: from,
      body: reply,
    });
  } catch (err) {
    console.error("Error:", err.message);
  }
});

// ─── Health check ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("WhatsApp agent is running!");
});

// ─── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`WhatsApp agent running on :${PORT}`));