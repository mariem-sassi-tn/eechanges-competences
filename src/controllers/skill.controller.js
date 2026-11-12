const { query } = require('../config/db');

async function listCatalog(_req, res) {
  const categories = await query('SELECT * FROM categories ORDER BY name');
  const skills = await query(
    `SELECT s.*, c.name AS categoryName
     FROM skills s JOIN categories c ON c.id = s.category_id
     ORDER BY c.name, s.name`
  );
  res.json({ categories, skills });
}

module.exports = { listCatalog };
