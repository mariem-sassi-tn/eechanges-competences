const test = require('node:test');
const assert = require('node:assert/strict');
const { checkTransition, STATUSES } = require('../src/domain/exchangeStatus');

const ex = (status) => ({ status, requester_id: 1, partner_id: 2 });
const requester = { id: 1, role: 'user' };
const partner = { id: 2, role: 'user' };
const stranger = { id: 3, role: 'user' };
const admin = { id: 9, role: 'admin' };

test('le destinataire accepte ou refuse une demande en attente', () => {
  assert.equal(checkTransition(ex('pending'), 'accepted', partner).ok, true);
  assert.equal(checkTransition(ex('pending'), 'rejected', partner).ok, true);
});

test('le demandeur ne peut pas s’auto-accepter', () => {
  const r = checkTransition(ex('pending'), 'accepted', requester);
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('seul le demandeur annule une demande en attente (le destinataire refuse)', () => {
  assert.equal(checkTransition(ex('pending'), 'cancelled', requester).ok, true);
  assert.equal(checkTransition(ex('pending'), 'cancelled', partner).status, 403);
});

test('cycle de vie complet accepted → in_progress → completed', () => {
  assert.equal(checkTransition(ex('accepted'), 'in_progress', partner).ok, true);
  assert.equal(checkTransition(ex('in_progress'), 'completed', requester).ok, true);
});

test('on ne saute pas d’étape (pending → completed)', () => {
  const r = checkTransition(ex('pending'), 'completed', admin);
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
});

test('les statuts finaux sont verrouillés, même pour un admin', () => {
  for (const final of ['rejected', 'completed', 'cancelled']) {
    for (const next of STATUSES) {
      assert.equal(checkTransition(ex(final), next, admin).ok, false, `${final} → ${next}`);
    }
  }
});

test('un tiers ne peut rien faire', () => {
  assert.equal(checkTransition(ex('accepted'), 'cancelled', stranger).status, 403);
});

test('statut inconnu refusé', () => {
  assert.equal(checkTransition(ex('pending'), 'hacked', admin).status, 422);
});

test('l’admin peut modérer (accepter à la place du destinataire)', () => {
  assert.equal(checkTransition(ex('pending'), 'accepted', admin).ok, true);
});
