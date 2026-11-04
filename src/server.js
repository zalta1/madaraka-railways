const db = require('./db'); const { build } = require('./app');
(async () => { await db.open(process.env.DB_DIR); const port = process.env.PORT || 4300;
  build().listen(port, () => console.log(`Madaraka Railways demo on http://localhost:${port}`)); })();
