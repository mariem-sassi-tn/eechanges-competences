// Appel au modèle de langage (Google Gemini gratuit, ou OpenAI) via l'API compatible OpenAI.
// Partagé par : assistant du support, message d'ouverture d'un échange, brouillon de réponse admin.
const { httpError } = require('../middleware/error');

const clean = (v) => (v || '').trim().replace(/^["']|["']$/g, '').trim();

function settings() {
  const geminiKey = clean(process.env.GEMINI_API_KEY);
  const useGemini = Boolean(geminiKey);
  const apiKey = geminiKey || clean(process.env.OPENAI_API_KEY);
  const endpoint =
    clean(process.env.AI_BASE_URL) ||
    (useGemini
      ? 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
      : 'https://api.openai.com/v1/chat/completions');
  const wanted = clean(process.env.AI_MODEL) || (useGemini ? '' : clean(process.env.OPENAI_MODEL) || 'gpt-4o-mini');
  // Gemini : si un modèle n'existe plus, on essaie automatiquement les suivants.
  const models = useGemini
    ? [...new Set([wanted, 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-flash-latest', 'gemini-2.0-flash'].filter(Boolean))]
    : [wanted];
  return { apiKey, endpoint, models };
}

function isConfigured() {
  return Boolean(settings().apiKey);
}

function errorText(raw) {
  try {
    const j = JSON.parse(raw);
    return (Array.isArray(j) ? j[0] : j)?.error?.message || raw;
  } catch {
    return raw;
  }
}

/**
 * Envoie une conversation au modèle et retourne le texte de la réponse.
 * Lève une httpError (503 si non configuré, 502 sinon) avec un message exploitable.
 */
async function chat({ system, messages, maxTokens = 2048, temperature = 0.4 }) {
  const { apiKey, endpoint, models } = settings();
  if (!apiKey) {
    throw httpError(503, "L'assistant IA n'est pas encore configuré. Ajoutez GEMINI_API_KEY (gratuit) dans le fichier .env puis redémarrez le serveur.");
  }

  const call = (model) =>
    fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: maxTokens,
        messages: [{ role: 'system', content: system }, ...messages]
      }),
      signal: AbortSignal.timeout(30000)
    });

  let response;
  let details = '';
  for (const model of models) {
    try {
      response = await call(model);
    } catch (err) {
      console.error('AI network error:', err.name, err.message);
      throw httpError(502, 'Impossible de joindre le service IA (réseau ou délai dépassé). Réessayez dans quelques instants.');
    }
    if (response.ok) break;
    details = errorText(await response.text().catch(() => ''));
    console.error('AI error:', model, response.status, String(details).slice(0, 500));
    const modelProblem =
      response.status === 404 || (/model/i.test(details) && /not found|not supported|unavailable|deprecated/i.test(details));
    if (!modelProblem) break; // autre cause : inutile d'essayer un autre modèle
  }

  if (!response.ok) {
    // Gemini renvoie 400 (et non 401) quand la clé est invalide.
    if (response.status === 401 || response.status === 403 || /api key|permission|unauthenticated/i.test(details)) {
      throw httpError(502, "Clé API refusée : vérifiez GEMINI_API_KEY dans le .env (clé Gemini 'AIza...', sans espace ni guillemets), puis redémarrez avec : docker compose up -d --build");
    }
    if (response.status === 429) {
      throw httpError(502, 'Quota atteint ou trop de requêtes : attendez une minute (Gemini gratuit) ou vérifiez les crédits (OpenAI).');
    }
    throw httpError(502, `Erreur du service IA (${response.status}) : ${String(details).slice(0, 200)}`);
  }

  const data = await response.json();
  const reply = data.choices?.[0]?.message?.content?.trim();
  if (!reply) throw httpError(502, "L'assistant IA n'a pas pu générer de réponse.");
  return reply;
}

// Extrait un objet JSON d'une réponse de modèle (qui l'entoure parfois de texte ou de ```json).
function parseJsonObject(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

module.exports = { chat, isConfigured, parseJsonObject };
