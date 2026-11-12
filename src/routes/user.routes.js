const express = require('express');
const users = require('../controllers/user.controller');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validate');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(authenticate);

router.get('/', users.listRules, validate, asyncHandler(users.listPublicUsers));
router.get('/me/skills', asyncHandler(users.mySkills));
router.get('/me/skill-suggestions', asyncHandler(users.skillSuggestions));
router.post('/me/skills', users.addSkillRules, validate, asyncHandler(users.addSkill));
router.delete('/me/skills/:id', users.idParam, validate, asyncHandler(users.removeSkill));
router.patch('/me', users.updateMeRules, validate, asyncHandler(users.updateMe));
router.get('/:id', users.idParam, validate, asyncHandler(users.getPublicUser));

module.exports = router;
