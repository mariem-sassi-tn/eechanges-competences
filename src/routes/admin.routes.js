const express = require('express');
const admin = require('../controllers/admin.controller');
const { authenticate, requireRole } = require('../middleware/auth');
const validate = require('../middleware/validate');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(authenticate, requireRole('admin'));

router.get('/dashboard', asyncHandler(admin.dashboard));
router.get('/users', admin.listUsersRules, validate, asyncHandler(admin.listUsers));
router.patch('/users/:id', admin.updateUserRules, validate, asyncHandler(admin.updateUser));
router.post('/users', admin.createAdminRules, validate, asyncHandler(admin.createAdmin));
router.post('/categories', admin.categoryRules, validate, asyncHandler(admin.createCategory));
router.post('/skills', admin.skillRules, validate, asyncHandler(admin.createSkill));
router.get('/catalog-duplicates', admin.duplicatesRules, validate, asyncHandler(admin.catalogDuplicates));
router.post('/skills/merge', admin.mergeSkillsRules, validate, asyncHandler(admin.mergeSkills));
router.delete('/skills/:id', admin.idParam, validate, asyncHandler(admin.deleteSkill));
router.get('/exchanges', admin.listExchangesRules, validate, asyncHandler(admin.listExchanges));
router.get('/matching-stats', admin.matchingStatsRules, validate, asyncHandler(admin.matchingStats));
router.get('/audit-logs', asyncHandler(admin.listAuditLogs));

module.exports = router;
