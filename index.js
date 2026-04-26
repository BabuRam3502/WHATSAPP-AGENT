import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import twilio from "twilio";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ... keep all the memory + system prompt + getAgentReply code exactly the same ...

// Replace the webhook POST handler with this:
app.post("/webhook", async (req, res) => {
  const from = req.body.From;       // e.g. "whatsapp:+1234567890"
  const userText = req.body.Body;

  if (!from || !userText) return res.sendStatus(200);

  console.log(`[${from}] ${userText}`);

  try {
    if (userText.trim().toLowerCase() === "/forget") {
      conversationHistory.delete(from);
      await twilioClient.messages.create({
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to: from,
        body: "Memory cleared! Starting fresh.",
      });
      return res.sendStatus(200);
    }

    const reply = await getAgentReply(from, userText);

    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: from,
      body: reply,
    });

    console.log(`[→ ${from}] ${reply}`);
  } catch (err) {
    console.error("Error:", err);
  }

  res.sendStatus(200);
});

app.listen(3000, () => console.log("WhatsApp agent running on :3000"));