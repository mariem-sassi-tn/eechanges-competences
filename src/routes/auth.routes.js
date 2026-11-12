const express = require('express');
const auth = require('../controllers/auth.controller');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validate');
const limits = require('../middleware/rateLimit');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

router.post('/register', limits.auth, auth.registerRules, validate, asyncHandler(auth.register));
router.post('/login', limits.auth, auth.loginRules, validate, asyncHandler(auth.login));
router.get('/me', authenticate, asyncHandler(auth.me));

router.post('/forgot-password', limits.reset, auth.forgotRules, validate, asyncHandler(auth.forgotPassword));
router.post('/reset-password', limits.reset, auth.resetRules, validate, asyncHandler(auth.resetPassword));

module.exports = router;
