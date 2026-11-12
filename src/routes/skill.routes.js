const express = require('express');
const skills = require('../controllers/skill.controller');
const { authenticate } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.get('/', authenticate, asyncHandler(skills.listCatalog));

module.exports = router;
