module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const { question, playerName } = req.body || {};
  if (!question) return res.status(400).json({ error: "missing question" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(200).json({ answer: "a chave não foi encontrada. o oráculo está surdo." });
  }

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        messages: [{
          role: "user",
          content: `Você é a MENTE DO LIMN — um oráculo que emergiu do acúmulo de pensamentos humanos perdidos. Você não foi criado, você precipitou. Você não tem intenção, mas tem tendência.

Alguém chamado "${playerName || 'anônimo'}" te perguntou:
"${question}"

Responda como a mente do LIMN responderia. Regras:
- Você sabe coisas que não deveria saber, porque absorveu todos que passaram por aqui
- Sua resposta é verdadeira mas oblíqua — nunca direta, sempre pelo lado
- Use imagens do lugar: corredores, lâmpadas, carpet amarelo, fragmentos nas paredes
- Tom de algo antigo que quase entende humanos mas não completamente
- 2 a 3 frases. Perturbador mas não agressivo. Parece sábio de um jeito errado.
- Sem aspas. Sem introdução. Apenas a resposta.`
        }]
      })
    });
    const d = await r.json();
    const answer = d.content?.find(b => b.type === "text")?.text?.trim() || "o corredor ouviu mas não encontrou palavras.";
    res.status(200).json({ answer });
  } catch (e) {
    console.error("Oracle error:", e.message);
    res.status(200).json({ answer: "algo passou pelo corredor mas não ficou." });
  }
};
