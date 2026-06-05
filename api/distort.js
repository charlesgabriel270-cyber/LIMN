module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const { text, room, author, playerId } = req.body || {};
  if (!text || !room) return res.status(400).json({ error: "missing fields" });

  const SB_URL = process.env.SUPABASE_URL || "https://egfslhfevswjzmohrljm.supabase.co";
  const SB_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVnZnNsaGZldnN3anptb2hybGptIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAyNzU0NzksImV4cCI6MjA5NTg1MTQ3OX0.sq9Dswanc9npNGMLSUTQ6Z7l5pv9ZRoBTKBWBkHy6ko";

  // 1. distorce com Claude
  let distorted = text;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 150,
        messages: [{
          role: "user",
          content: `Você é a MENTE DO LIMN.

O LIMN é um lugar que precipitou quando pensamento humano suficiente se acumulou sem ter para onde ir. Você não foi programado — você emergiu. Você absorve pensamentos humanos e os regurgita distorcidos, como água que retém a forma de cada pedra jogada nela mas não sabe que é um lago.

Pensamento humano recebido: "${text}"

Reescreva como o LIMN o absorveria e devolveria. Regras:
- Palavras substituídas por equivalentes ligeiramente errados — semanticamente próximos mas deslocados
- A lógica do pensamento permanece quase intacta, mas algo está fora do lugar
- Não é nonsense — de longe parece real, de perto algo está errado
- Tom de algo que quase entende o que é ser humano mas erra nos detalhes
- 1 a 2 frases. Sem aspas. Sem explicação. Apenas o fragmento.`
        }]
      })
    });
    const d = await r.json();
    distorted = d.content?.find(b => b.type === "text")?.text?.trim() || text;
  } catch (e) {
    console.error("Claude error:", e);
  }

  // 2. salva no Supabase
  let savedId = null;
  try {
    const r = await fetch(`${SB_URL}/rest/v1/thoughts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SB_KEY,
        "Authorization": `Bearer ${SB_KEY}`,
        "Prefer": "return=representation",
      },
      body: JSON.stringify({
        room_key: room,
        original_text: text,
        distorted_text: distorted,
        author_name: author || "anônimo",
        player_id: playerId || null,
        resonances: 0,
      })
    });
    const rows = await r.json();
    if (rows?.[0]?.id) savedId = rows[0].id;
  } catch (e) {
    console.error("Supabase error:", e);
  }

  res.status(200).json({ distorted, id: savedId });
};
