// Évite les try/catch répétitifs : toute erreur async part vers le errorHandler.
module.exports = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
