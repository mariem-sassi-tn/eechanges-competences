const express = require('express');
const ex = require('../controllers/exchange.controller');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validate');
const asyncHandler = require('../utils/asyncHandler');
const limits = require('../middleware/rateLimit');

const router = express.Router();
router.use(authenticate);

router.get('/', asyncHandler(ex.listMine));
router.post('/', ex.createRules, validate, asyncHandler(ex.create));
router.post('/draft-message', limits.ai, ex.draftRules, validate, asyncHandler(ex.draftMessage));
// Audio brut (WAV) : corps binaire, limité à 1 Mo, avant les routes /:id.
router.post('/transcribe', limits.ai, express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '1mb' }), asyncHandler(ex.transcribe));
router.get('/:id', ex.idParam, validate, asyncHandler(ex.getOne));
router.patch('/:id/status', ex.statusRules, validate, asyncHandler(ex.updateStatus));
router.post('/:id/messages', ex.messageRules, validate, asyncHandler(ex.addMessage));
router.post('/:id/ai-chat', limits.ai, ex.aiChatRules, validate, asyncHandler(ex.aiChat));
router.post('/:id/reviews', ex.reviewRules, validate, asyncHandler(ex.addReview));

module.exports = router;
