const { validationResult } = require('express-validator');
const { httpError } = require('./error');

// À placer après un tableau de règles express-validator.
module.exports = function validate(req, _res, next) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  const details = errors.array().map((e) => ({ field: e.path, message: e.msg }));
  return next(httpError(422, details[0].message, details));
};
