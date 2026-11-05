const mysql = require('mysql2/promise');
const fs = require('fs');
const pw = fs.readFileSync('/Users/openclaw-user/.openclaw/secrets/mysql.env','utf8')
  .split('\n').find(l => l.startsWith('MYSQL_PASSWORD')).split('=').slice(1).join('=').trim();

(async () => {
  const conn = await mysql.createConnection({
    host:'127.0.0.1', port:3307, user:'FDB_SteveConnect',
    password: ***,
    database:'production', dateStrings:true
  });

  // Beverage SKUs in the SKU mapping and FlavorSchedule
  const [bevSkus] = await conn.query(`
    SELECT DISTINCT fs.SKU, fs.Item_Name, fs.Item_Category, fs.Sales_Month, fs.Sales_Year
    FROM FlavorSchedule fs
    WHERE fs.Item_Category IN ('Coffee','Espresso Beverages','Beverages','Drinks')
      AND fs.Sales_Year = 2026
    ORDER BY fs.Sales_Year DESC, fs.Sales_Month DESC, fs.Item_Category, fs.SKU
    LIMIT 50
  `);
  console.log('=== Beverages in FlavorSchedule (2026) ===');
  console.log(JSON.stringify(bevSkus, null, 2));

  // What beverage-like categories exist in FlavorSchedule at all?
  const [cats] = await conn.query(`
    SELECT DISTINCT Item_Category FROM FlavorSchedule
    WHERE Item_Category NOT IN (
      'Hundred Layer Donuts','Mini Hundred Layer Donuts','Paleo',
      'Yeast Raised Donuts','Rolls','Pastries','Breakfast','Cookies'
    )
    ORDER BY Item_Category
  `);
  console.log('\n=== Non-pastry categories in FlavorSchedule ===');
  console.log(cats.map(r => r.Item_Category).join('\n'));

  await conn.end();
})().catch(e => console.error('ERR:', e.message));
