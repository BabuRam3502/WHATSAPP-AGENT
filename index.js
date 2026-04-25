// whatsapp-agent.js
import express from "express";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
app.use(express.json());

//push

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── In-memory conversation store (swap for Redis in production) ───────────────
// Structure: { [phoneNumber]: [ {role, content}, ... ] }
const conversationHistory = new Map();
const MAX_HISTORY = 20; // keep last 20 turns per user

function getHistory(phone) {
  return conversationHistory.get(phone) || [];
}

function addToHistory(phone, role, content) {
  const history = getHistory(phone);
  history.push({ role, content });
  // Trim to last MAX_HISTORY messages
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

// ─── Tool definitions ──────────────────────────────────────────────────────────
const tools = [
  {
    type: "web_search_20250305",
    name: "web_search",
  },
];

// ─── Core: call Claude with history + tools ────────────────────────────────────
async function getAgentReply(phone, userMessage) {
  // Add user message to history
  addToHistory(phone, "user", userMessage);

  const messages = getHistory(phone);

  // Agentic loop: keep calling Claude until it stops using tools
  let response;
  let loopMessages = [...messages];

  while (true) {
    response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools,
      messages: loopMessages,
    });

    if (response.stop_reason === "end_turn") {
      // Claude is done — extract final text reply
      break;
    }

    if (response.stop_reason === "tool_use") {
      // Claude wants to use a tool — add its response + tool results and loop
      const assistantMsg = { role: "assistant", content: response.content };
      loopMessages.push(assistantMsg);

      // Build tool_result blocks for each tool_use block
      const toolResults = response.content
        .filter((block) => block.type === "tool_use")
        .map((block) => ({
          type: "tool_result",
          tool_use_id: block.id,
          // Web search results are returned automatically by the API —
          // we just pass back an empty result here as a placeholder;
          // the SDK handles injecting search results.
          content: "",
        }));

      loopMessages.push({ role: "user", content: toolResults });
    } else {
      break; // unexpected stop reason — exit loop
    }
  }

  // Extract the final text reply
  const replyText = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  // Save assistant reply to history
  addToHistory(phone, "assistant", replyText);

  return replyText;
}

// ─── WhatsApp sender ───────────────────────────────────────────────────────────
async function sendWhatsAppMessage(to, text) {
  const url = `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`;
  await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });
}

// ─── Webhook verification ──────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  if (req.query["hub.verify_token"] === process.env.VERIFY_TOKEN) {
    res.send(req.query["hub.challenge"]);
  } else {
    res.sendStatus(403);
  }
});

// ─── Incoming messages ─────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  // Acknowledge immediately — Meta requires a fast 200
  res.sendStatus(200);

  const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!message || message.type !== "text") return;

  const from = message.from;
  const userText = message.text.body;

  console.log(`[${from}] ${userText}`);

  try {
    // Handle "forget" command to reset conversation
    if (userText.trim().toLowerCase() === "/forget") {
      conversationHistory.delete(from);
      await sendWhatsAppMessage(from, "Memory cleared! Starting fresh.");
      return;
    }

    const reply = await getAgentReply(from, userText);
    await sendWhatsAppMessage(from, reply);
    console.log(`[→ ${from}] ${reply}`);
  } catch (err) {
    console.error("Error:", err);
    await sendWhatsAppMessage(from, "Sorry, something went wrong. Try again in a moment.");
  }
});

app.listen(3000, () => console.log("WhatsApp agent running on :3000"));