import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(__dirname));

// Rate limit map
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60000;
const MAX_REQUESTS = 10;

// === /api/weather ===
app.get('/api/weather', async (req, res) => {
  const { lat, lon } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: 'Missing coordinates' });
  try {
    const apiKey = process.env.WEATHER_API_KEY;
    const response = await fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${apiKey}&units=metric`);
    if (!response.ok) throw new Error('OpenWeather fetch failed');
    const data = await response.json();
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: 'Weather fetch failed' });
  }
});

// === /api/decide ===
app.post('/api/decide', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const rateData = rateLimitMap.get(ip) || { count: 0, resetTime: now + RATE_LIMIT_WINDOW_MS };
  if (now > rateData.resetTime) { rateData.count = 0; rateData.resetTime = now + RATE_LIMIT_WINDOW_MS; }
  rateData.count++;
  rateLimitMap.set(ip, rateData);
  if (rateData.count > MAX_REQUESTS) {
    return res.status(429).json({ error: 'Rate limit exceeded. Cool down.', id: `err_${now}`, category: 'system', text: 'Rate limit exceeded.', exp: 'Too many requests.', confidence: 0, isLife: false, rejected: [] });
  }
  const { systemPrompt } = req.body;
  if (!systemPrompt) return res.status(400).json({ error: 'Missing systemPrompt' });
  try {
    const apiKey = process.env.GROQ_API_KEY;
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages: [{ role: "system", content: systemPrompt }, { role: "user", content: "Generate directive via JSON." }], temperature: 0.6, response_format: { type: "json_object" } })
    });
    if (!response.ok) throw new Error(`Groq error: ${response.status}`);
    const data = await response.json();
    let parsed = JSON.parse(data.choices[0].message.content);
    parsed.id = "gen_" + Date.now();
    parsed.confidence = Math.min(parsed.confidence, 95);
    res.status(200).json(parsed);
  } catch (e) {
    console.error('LLM Error:', e.message);
    res.status(500).json({ id: `err_${Date.now()}`, category: 'system', text: 'Pause operations.', exp: 'API link severed.', confidence: 50, isLife: false, rejected: [] });
  }
});

app.listen(PORT, () => {
  console.log(`\n🧠 AI Life Decision Maker running at: http://localhost:${PORT}\n`);
});
