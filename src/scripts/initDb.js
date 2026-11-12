const config = require('../config/env');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

async function init() {
  const connection = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    multipleStatements: true
  });

  const dbName = config.db.name;
  await connection.query(
    `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await connection.query(`USE \`${dbName}\``);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      first_name VARCHAR(80) NOT NULL,
      last_name VARCHAR(80) NOT NULL,
      email VARCHAR(160) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      role ENUM('user', 'admin') NOT NULL DEFAULT 'user',
      bio TEXT NULL,
      city VARCHAR(120) NULL,
      avatar_url LONGTEXT NULL,
      cv_data LONGTEXT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(80) NOT NULL,
      slug VARCHAR(80) NOT NULL UNIQUE,
      icon VARCHAR(16) DEFAULT '✦'
    );

    CREATE TABLE IF NOT EXISTS skills (
      id INT AUTO_INCREMENT PRIMARY KEY,
      category_id INT NOT NULL,
      name VARCHAR(120) NOT NULL,
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE,
      UNIQUE KEY unique_skill (category_id, name)
    );

    CREATE TABLE IF NOT EXISTS user_skills (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      skill_id INT NOT NULL,
      type ENUM('offer', 'need') NOT NULL,
      level ENUM('beginner', 'intermediate', 'expert') NOT NULL DEFAULT 'intermediate',
      description TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE,
      UNIQUE KEY unique_user_skill (user_id, skill_id, type)
    );

    CREATE TABLE IF NOT EXISTS exchanges (
      id INT AUTO_INCREMENT PRIMARY KEY,
      requester_id INT NOT NULL,
      partner_id INT NOT NULL,
      offered_user_skill_id INT NULL,
      requested_user_skill_id INT NULL,
      message TEXT NULL,
      status ENUM('pending', 'accepted', 'rejected', 'in_progress', 'completed', 'cancelled') NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (requester_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (partner_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (offered_user_skill_id) REFERENCES user_skills(id) ON DELETE SET NULL,
      FOREIGN KEY (requested_user_skill_id) REFERENCES user_skills(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      exchange_id INT NOT NULL,
      sender_id INT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (exchange_id) REFERENCES exchanges(id) ON DELETE CASCADE,
      FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id INT AUTO_INCREMENT PRIMARY KEY,
      exchange_id INT NOT NULL,
      reviewer_id INT NOT NULL,
      reviewee_id INT NOT NULL,
      rating TINYINT NOT NULL,
      comment TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (exchange_id) REFERENCES exchanges(id) ON DELETE CASCADE,
      FOREIGN KEY (reviewer_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (reviewee_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE KEY unique_review (exchange_id, reviewer_id)
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      admin_id INT NULL,
      action VARCHAR(60) NOT NULL,
      target_type VARCHAR(40) NOT NULL,
      target_id INT NULL,
      details TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS support_messages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      sender_id INT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Journal des recommandations : ce qui a été montré (impression) et ce qui a suivi (click, propose).
    -- Sert à mesurer plus tard si le score prédit bien les échanges réellement proposés.
    CREATE TABLE IF NOT EXISTS recommendation_events (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      candidate_id INT NOT NULL,
      event_type ENUM('impression', 'click', 'propose') NOT NULL,
      score TINYINT UNSIGNED NULL,
      model_version VARCHAR(120) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (candidate_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // Migrations idempotentes (compatibles MySQL 8 ET MariaDB/WAMP : pas de "ADD COLUMN IF NOT EXISTS").
  const columnExists = async (table, column) => {
    const [rows] = await connection.query(
      'SELECT 1 FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name = ?',
      [dbName, table, column]
    );
    return rows.length > 0;
  };
  const indexExists = async (table, name) => {
    const [rows] = await connection.query(
      'SELECT 1 FROM information_schema.statistics WHERE table_schema = ? AND table_name = ? AND index_name = ?',
      [dbName, table, name]
    );
    return rows.length > 0;
  };
  const ensureColumn = async (table, column, ddl) => {
    if (!(await columnExists(table, column))) await connection.query(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`);
  };
  const ensureIndex = async (table, name, columns) => {
    if (!(await indexExists(table, name))) await connection.query(`CREATE INDEX \`${name}\` ON \`${table}\` (${columns})`);
  };

  await connection.query('ALTER TABLE users MODIFY avatar_url LONGTEXT NULL');
  await ensureColumn('users', 'cv_data', 'cv_data LONGTEXT NULL');
  await ensureColumn('users', 'reset_code', 'reset_code VARCHAR(64) NULL');
  await ensureColumn('users', 'reset_code_expires', 'reset_code_expires DATETIME NULL');
  await ensureColumn('users', 'reset_attempts', 'reset_attempts TINYINT NOT NULL DEFAULT 0');
  // Le code de réinitialisation est désormais stocké haché (SHA-256 = 64 caractères).
  await connection.query('ALTER TABLE users MODIFY reset_code VARCHAR(64) NULL');

  // Index pour les requêtes fréquentes (listes d'échanges, messages, avis, support).
  await ensureIndex('exchanges', 'idx_exchanges_requester', 'requester_id, status');
  await ensureIndex('exchanges', 'idx_exchanges_partner', 'partner_id, status');
  await ensureIndex('exchanges', 'idx_exchanges_status', 'status, created_at');
  await ensureIndex('messages', 'idx_messages_exchange', 'exchange_id, created_at');
  await ensureIndex('reviews', 'idx_reviews_reviewee', 'reviewee_id');
  await ensureIndex('support_messages', 'idx_support_user', 'user_id, created_at');
  await ensureIndex('user_skills', 'idx_user_skills_user', 'user_id, type');
  await ensureIndex('audit_logs', 'idx_audit_created', 'created_at');
  await ensureIndex('recommendation_events', 'idx_reco_user', 'user_id, candidate_id, event_type, id');
  await ensureIndex('recommendation_events', 'idx_reco_created', 'created_at');

  // S'assure qu'une catégorie unique "Nouvelles compétences" existe pour le catalogue simplifié
  const [defaultCat] = await connection.query("SELECT id FROM categories WHERE slug = 'nouvelles-competences'");
  if (!defaultCat.length) {
    await connection.query(
      "INSERT INTO categories (name, slug, icon) VALUES ('Nouvelles compétences', 'nouvelles-competences', '✨')"
    );
  }

  const [admins] = await connection.query("SELECT id FROM users WHERE email = 'admin@echanges.local'");
  if (config.isProd) {
    console.log('Production : données de démonstration ignorées (créez un admin via une requête SQL sécurisée).');
  } else if (!admins.length) {
    const adminHash = await bcrypt.hash('Admin123!', 10);
    const userHash = await bcrypt.hash('User1234!', 10);
    await connection.query(
      `INSERT INTO users (first_name, last_name, email, password_hash, role, city, bio) VALUES
       ('Amina', 'Khelifi', 'admin@echanges.local', ?, 'admin', 'Tunis', 'Administratrice de la plateforme.'),
       ('Yassine', 'Ben Ali', 'yassine@echanges.local', ?, 'user', 'Sfax', 'Designer UI et photographe amateur.'),
       ('Sara', 'Mansour', 'sara@echanges.local', ?, 'user', 'Tunis', 'Professeure d’anglais et coach oral.'),
       ('Nour', 'Trabelsi', 'nour@echanges.local', ?, 'user', 'Sousse', 'Développeuse web fullstack.')`,
      [adminHash, userHash, userHash, userHash]
    );

    await connection.query(`
      INSERT INTO categories (name, slug, icon) VALUES
      ('Langues', 'langues', 'Aa'),
      ('Design', 'design', '◇'),
      ('Développement', 'developpement', '</>'),
      ('Musique', 'musique', '♪'),
      ('Business', 'business', '◎')
    `);

    await connection.query(`
      INSERT INTO skills (category_id, name) VALUES
      (1, 'Anglais'), (1, 'Français'), (1, 'Espagnol'),
      (2, 'UI Design'), (2, 'Figma'), (2, 'Photographie'),
      (3, 'Angular'), (3, 'Node.js'), (3, 'MySQL'),
      (4, 'Piano'), (4, 'Guitare'),
      (5, 'Marketing digital'), (5, 'Gestion de projet')
    `);

    await connection.query(`
      INSERT INTO user_skills (user_id, skill_id, type, level, description) VALUES
      (2, 4, 'offer', 'expert', 'Cours Figma et UI pour débutants et intermédiaires.'),
      (2, 6, 'offer', 'intermediate', 'Initiation photo portrait et lumière naturelle.'),
      (2, 1, 'need', 'beginner', 'Je cherche à progresser à l’oral en anglais.'),
      (3, 1, 'offer', 'expert', 'Anglais conversationnel, TOEIC, préparation entretien.'),
      (3, 2, 'offer', 'expert', 'Remise à niveau en français écrit.'),
      (3, 5, 'need', 'beginner', 'Je veux apprendre Figma pour mes supports de cours.'),
      (4, 7, 'offer', 'expert', 'Angular avancé, architecture et bonnes pratiques.'),
      (4, 8, 'offer', 'expert', 'APIs Express, JWT, MySQL.'),
      (4, 10, 'need', 'beginner', 'Je voudrais des bases de piano.')
    `);

    await connection.query(`
      INSERT INTO exchanges (requester_id, partner_id, offered_user_skill_id, requested_user_skill_id, message, status)
      VALUES (3, 2, 4, 1, 'Je t’enseigne l’anglais, tu me montres Figma ?', 'accepted')
    `);

    await connection.query(`
      INSERT INTO messages (exchange_id, sender_id, content) VALUES
      (1, 3, 'Salut Yassine, dispo ce week-end pour un premier échange ?'),
      (1, 2, 'Oui, samedi 10h en visio ça te va ?')
    `);
  }

  await connection.end();
  console.log(`Base ${dbName} initialisée.`);
  if (!config.isProd) {
    console.log('Admin : admin@echanges.local / Admin123!');
    console.log('User  : sara@echanges.local / User1234!');
  }
}

init().catch((error) => {
  console.error(error);
  process.exit(1);
});
