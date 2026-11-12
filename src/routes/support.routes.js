const express = require('express');
const support = require('../controllers/support.controller');
const { authenticate, requireRole } = require('../middleware/auth');
const validate = require('../middleware/validate');
const asyncHandler = require('../utils/asyncHandler');
const limits = require('../middleware/rateLimit');

const router = express.Router();

// Assistant IA : accessible aux utilisateurs connectés
router.post('/ai-chat', authenticate, requireRole('user'), limits.ai, asyncHandler(support.aiChat));

// Utilisateur : sa conversation avec l'administration
router.get('/me', authenticate, asyncHandler(support.myThread));
router.post('/me', authenticate, requireRole('user'), support.sendRules, validate, asyncHandler(support.sendMine));

// Administrateur : gestion des conversations de support
router.get('/threads', authenticate, requireRole('admin'), asyncHandler(support.listThreads));
router.get('/threads/:userId', authenticate, requireRole('admin'), support.threadRules, validate, asyncHandler(support.getThread));
router.post('/threads/:userId/draft-reply', authenticate, requireRole('admin'), limits.ai, support.threadRules, validate, asyncHandler(support.draftReply));
router.post('/threads/:userId', authenticate, requireRole('admin'), support.replyRules, validate, asyncHandler(support.replyThread));

module.exports = router;
