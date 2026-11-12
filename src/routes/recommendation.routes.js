const express = require('express');
const reco = require('../controllers/recommendation.controller');
const { authenticate, requireRole } = require('../middleware/auth');
const validate = require('../middleware/validate');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(authenticate, requireRole('user'));

router.get('/', asyncHandler(reco.list));
router.post('/events', reco.eventRules, validate, asyncHandler(reco.track));

module.exports = router;
