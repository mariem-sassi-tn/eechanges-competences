// Machine à états des échanges.
// Chaque transition précise QUI peut la déclencher :
//   partner   = destinataire de la demande
//   requester = celui qui a proposé l'échange
//   party     = l'un des deux
//   admin     = modération (toujours autorisé)
const TRANSITIONS = {
  pending: { accepted: 'partner', rejected: 'partner', cancelled: 'requester' },
  accepted: { in_progress: 'party', cancelled: 'party' },
  in_progress: { completed: 'party', cancelled: 'party' },
  rejected: {},
  completed: {},
  cancelled: {}
};

const STATUSES = Object.keys(TRANSITIONS);

function roleOf(exchange, user) {
  if (user.role === 'admin') return 'admin';
  if (exchange.partner_id === user.id) return 'partner';
  if (exchange.requester_id === user.id) return 'requester';
  return null;
}

// Retourne { ok: true } ou { ok: false, status, message }
function checkTransition(exchange, nextStatus, user) {
  if (!STATUSES.includes(nextStatus)) {
    return { ok: false, status: 422, message: 'Statut invalide.' };
  }
  const actor = roleOf(exchange, user);
  if (!actor) {
    return { ok: false, status: 403, message: 'Action non autorisée.' };
  }
  const rule = (TRANSITIONS[exchange.status] || {})[nextStatus];
  if (!rule) {
    return {
      ok: false,
      status: 409,
      message: `Transition impossible : « ${exchange.status} » vers « ${nextStatus} ».`
    };
  }
  const allowed = actor === 'admin' || rule === 'party' || rule === actor;
  if (!allowed) {
    return { ok: false, status: 403, message: 'Vous ne pouvez pas effectuer cette action sur cet échange.' };
  }
  return { ok: true };
}

module.exports = { TRANSITIONS, STATUSES, checkTransition, roleOf };
