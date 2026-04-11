export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { lat, lon } = req.query;
  if (!lat || !lon) {
    return res.status(400).json({ error: 'Missing coordinates' });
  }

  try {
    const apiKey = process.env.WEATHER_API_KEY;
    if (!apiKey) {
      throw new Error("Missing WEATHER_API_KEY in environment");
    }

    const response = await fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${apiKey}&units=metric`);
    
    if (!response.ok) {
      throw new Error("Failed to fetch from OpenWeatherMap");
    }
    
    const data = await response.json();
    return res.status(200).json(data);
  } catch (error) {
    console.error("Weather API Error:", error);
    return res.status(500).json({ error: 'Failed to fetch weather data' });
  }
}
