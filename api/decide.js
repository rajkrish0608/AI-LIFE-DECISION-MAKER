// Basic in-memory rate limiting map. 
// Note: In Vercel serverless, this memory clears when instances spin down.
// For true production, use Redis (e.g. Upstash).
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 10;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Basic IP Rate Limiting
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const currentTime = Date.now();
  
  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, { count: 1, resetTime: currentTime + RATE_LIMIT_WINDOW_MS });
  } else {
    const data = rateLimitMap.get(ip);
    if (currentTime > data.resetTime) {
      // Window expired, reset
      rateLimitMap.set(ip, { count: 1, resetTime: currentTime + RATE_LIMIT_WINDOW_MS });
    } else {
      data.count++;
      if (data.count > MAX_REQUESTS_PER_WINDOW) {
        return res.status(429).json({ 
          error: 'Rate limit exceeded.',
          id: `err_${Date.now()}`,
          category: 'system',
          text: 'Rate limit exceeded.',
          exp: 'You are requesting decisions too rapidly. Cool down.',
          confidence: 0,
          isLife: false,
          rejected: []  
        });
      }
    }
  }

  try {
    const { systemPrompt } = req.body;
    if (!systemPrompt) {
      return res.status(400).json({ error: 'Missing systemPrompt payload' });
    }

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      throw new Error("Missing GROQ_API_KEY in environment");
    }

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
      },
      body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: "Generate directive via JSON." }
          ],
          temperature: 0.6,
          response_format: { type: "json_object" }
      })
    });

    if (!response.ok) {
        throw new Error(`Groq API returned ${response.status}`);
    }
    
    const data = await response.json();
    const rawJson = data.choices[0].message.content;
    
    // Validate output structure safely
    let parsed = JSON.parse(rawJson);
    parsed.id = "gen_" + Date.now();
    parsed.confidence = Math.min(parsed.confidence, 95); 
    
    return res.status(200).json(parsed);

  } catch (error) {
    console.error("LLM Generation Failed (Backend):", error);
    return res.status(500).json({
      id: `err_${Date.now()}`,
      category: 'system',
      text: "Pause operations.",
      exp: "Server API neural link severed. Rest until bandwidth restores.",
      confidence: 50,
      isLife: false,
      rejected: [{text: "Continue working", reason: "API Error prevented compilation."}]
    });
  }
}
