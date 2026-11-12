// Jeu de données de démonstration pour la recommandation : 18 membres aux profils variés.
// Idempotent (peut être relancé sans doublons) et ignoré en production.
// Lancé automatiquement par docker-compose après initDb.js ; manuel : npm run db:seed-demo
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const config = require('../config/env');

const CATEGORIES = [
  ['Langues', 'langues', 'Aa'],
  ['Design', 'design', '◇'],
  ['Développement', 'developpement', '</>'],
  ['Musique', 'musique', '♪'],
  ['Business', 'business', '◎'],
  ['Nouvelles compétences', 'nouvelles-competences', '✨']
];

// [slug de catégorie, nom] — les compétences déjà présentes sont ignorées.
const SKILLS = [
  ['langues', 'Anglais'], ['langues', 'Français'], ['langues', 'Espagnol'], ['langues', 'Arabe'], ['langues', 'Allemand'],
  ['design', 'UI Design'], ['design', 'Figma'], ['design', 'Photographie'], ['design', 'Photoshop'], ['design', 'Montage vidéo'],
  ['developpement', 'Angular'], ['developpement', 'Node.js'], ['developpement', 'MySQL'],
  ['developpement', 'Python'], ['developpement', 'React'], ['developpement', 'JavaScript'],
  ['musique', 'Piano'], ['musique', 'Guitare'], ['musique', 'Chant'],
  ['business', 'Marketing digital'], ['business', 'Gestion de projet'], ['business', 'SEO'],
  ['business', 'Comptabilité'], ['business', 'Excel'], ['business', 'Rédaction'],
  ['nouvelles-competences', 'Cuisine tunisienne'], ['nouvelles-competences', 'Yoga']
];

// offers / needs : [compétence, niveau]  (niveau pour les besoins : beginner par défaut)
const MEMBERS = [
  ['Rania', 'Jebali', 'Tunis', 'Designer produit, je donne des cours de Figma.', [['Figma', 'expert'], ['Photoshop', 'intermediate']], ['Anglais', 'Angular']],
  ['Mehdi', 'Gharbi', 'Sousse', 'UX/UI freelance.', [['UI Design', 'expert']], ['Anglais', 'Français']],
  ['Ines', 'Bouaziz', 'Tunis', 'Traductrice, passionnée de langues.', [['Anglais', 'expert'], ['Espagnol', 'intermediate']], ['Figma']],
  ['Karim', 'Dridi', 'Sfax', 'Data analyst, fan de Python.', [['Python', 'expert'], ['MySQL', 'intermediate']], ['Piano', 'Guitare']],
  ['Salma', 'Chaabane', 'Nabeul', 'Pianiste et professeure de chant.', [['Piano', 'expert'], ['Chant', 'expert']], ['Angular', 'Node.js']],
  ['Omar', 'Fourati', 'Tunis', 'Guitariste, je cherche à me lancer dans le marketing.', [['Guitare', 'expert'], ['Piano', 'beginner']], ['Marketing digital']],
  ['Lina', 'Hammami', 'Bizerte', 'Responsable marketing digital.', [['Marketing digital', 'expert'], ['SEO', 'intermediate']], ['Photographie', 'Figma']],
  ['Walid', 'Sassi', 'Sousse', 'Photographe et vidéaste.', [['Photographie', 'expert'], ['Montage vidéo', 'intermediate']], ['Anglais']],
  ['Yasmine', 'Karray', 'Tunis', 'Enseignante de français et d’arabe.', [['Français', 'expert'], ['Arabe', 'expert']], ['Allemand', 'Anglais']],
  ['Hatem', 'Ayari', 'Gabès', 'Chef de projet IT.', [['Gestion de projet', 'expert'], ['Excel', 'expert']], ['Python']],
  ['Eya', 'Mejri', 'Monastir', 'Développeuse front-end.', [['React', 'expert'], ['JavaScript', 'expert']], ['UI Design', 'Figma']],
  ['Bilel', 'Naceur', 'Sfax', 'Comptable, à l’aise avec Excel.', [['Comptabilité', 'expert'], ['Excel', 'intermediate']], ['Anglais', 'Espagnol']],
  ['Mariem', 'Tlili', 'Tunis', 'Professeure d’espagnol et d’anglais.', [['Espagnol', 'expert'], ['Anglais', 'intermediate']], ['Piano']],
  ['Aymen', 'Zouari', 'Kairouan', 'Développeur back-end.', [['Node.js', 'expert'], ['MySQL', 'expert']], ['Figma', 'UI Design']],
  ['Ghada', 'Ben Salah', 'Ariana', 'Rédactrice web et SEO.', [['Rédaction', 'expert'], ['SEO', 'expert']], ['Photoshop', 'Marketing digital']],
  ['Firas', 'Mansouri', 'Tunis', 'Ingénieur ayant vécu en Allemagne.', [['Allemand', 'expert']], ['Python', 'Anglais']],
  ['Nesrine', 'Bahri', 'Sousse', 'Passionnée de cuisine traditionnelle.', [['Cuisine tunisienne', 'expert']], ['Anglais']],
  ['Sofiane', 'Hajji', 'Tunis', 'Prof de yoga, curieux de technologie.', [['Yoga', 'expert']], ['JavaScript', 'Excel']]
];

async function seed() {
  if (config.isProd) {
    console.log('Production : membres de démonstration ignorés.');
    return;
  }
  const connection = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.name
  });

  for (const [name, slug, icon] of CATEGORIES) {
    await connection.query('INSERT IGNORE INTO categories (name, slug, icon) VALUES (?, ?, ?)', [name, slug, icon]);
  }
  const [cats] = await connection.query('SELECT id, slug FROM categories');
  const catId = new Map(cats.map((c) => [c.slug, c.id]));
  for (const [slug, name] of SKILLS) {
    // Ajoutée seulement si ce nom n'existe pas déjà (quelle que soit sa catégorie) : pas de doublons dans le catalogue.
    await connection.query(
      'INSERT INTO skills (category_id, name) SELECT ?, ? FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM skills WHERE name = ?)',
      [catId.get(slug), name, name]
    );
  }
  const [skillRows] = await connection.query('SELECT MIN(id) AS id, name FROM skills GROUP BY name');
  const skillId = new Map(skillRows.map((s) => [s.name, s.id]));

  const hash = await bcrypt.hash('User1234!', 10);
  let created = 0;
  for (const [first, last, city, bio, offers, needs] of MEMBERS) {
    const email = `${first}.${last}`.toLowerCase().normalize('NFD').replace(/[^a-z.]/g, '') + '@demo.echanges.local';
    const [res] = await connection.query(
      `INSERT IGNORE INTO users (first_name, last_name, email, password_hash, role, city, bio)
       VALUES (?, ?, ?, ?, 'user', ?, ?)`,
      [first, last, email, hash, city, bio]
    );
    created += res.affectedRows;
    const [[user]] = await connection.query('SELECT id FROM users WHERE email = ?', [email]);
    const rows = [
      ...offers.map(([n, level]) => [user.id, skillId.get(n), 'offer', level]),
      ...needs.map((n) => [user.id, skillId.get(n), 'need', 'beginner'])
    ];
    for (const row of rows) {
      if (!row[1]) throw new Error(`Compétence inconnue pour ${email}`);
    }
    await connection.query('INSERT IGNORE INTO user_skills (user_id, skill_id, type, level) VALUES ?', [rows]);
  }

  await connection.end();
  console.log(`Membres de démonstration : ${created} créé(s), ${MEMBERS.length - created} déjà présent(s). Mot de passe : User1234!`);
}

seed().catch((error) => {
  console.error(error);
  process.exit(1);
});
