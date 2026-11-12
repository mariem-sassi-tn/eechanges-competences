// Échappe % _ \ pour un LIKE sûr (sinon "100%" ou "_" matchent tout).
function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, '\\$&');
}

function slugify(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function pagination(query, { defaultLimit = 50, maxLimit = 100 } = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, offset: (page - 1) * limit };
}

// Découpe la bio et le CV en courts extraits (une idée par extrait) pour l'analyse par l'IA.
function profileSegments(bio, cv, { max = 40 } = {}) {
  const raw = [];
  const push = (value) => {
    if (typeof value === 'string') raw.push(value);
  };
  push(bio);
  if (cv && typeof cv === 'object') {
    push(cv.headline);
    push(cv.summary);
    (Array.isArray(cv.experiences) ? cv.experiences : []).forEach((e) => {
      push(e?.role);
      push(e?.description);
    });
    (Array.isArray(cv.educations) ? cv.educations : []).forEach((e) => push(e?.degree));
    (Array.isArray(cv.keywords) ? cv.keywords : []).forEach(push);
  }
  const seen = new Set();
  const out = [];
  for (const chunk of raw) {
    for (const part of chunk.split(/[\n.;•]+/)) {
      const text = part.trim().slice(0, 200);
      const key = text.toLowerCase();
      if (text.length >= 2 && !seen.has(key)) {
        seen.add(key);
        out.push(text);
      }
    }
  }
  return out.slice(0, max);
}

module.exports = { escapeLike, slugify, pagination, profileSegments };
