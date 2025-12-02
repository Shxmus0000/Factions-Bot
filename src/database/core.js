// src/database/core.js
// Promise helpers over sqlite3 Database so repos can use await.

const { getDb } = require('./connection');

function run(sql, params = []) {
  const db = getDb();
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this); // has lastID / changes
    });
  });
}

function get(sql, params = []) {
  const db = getDb();
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

function all(sql, params = []) {
  const db = getDb();
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

module.exports = {
  run,
  get,
  all,
};
