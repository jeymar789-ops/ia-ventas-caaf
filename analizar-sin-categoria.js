// analizar-sin-categoria.js
// Solo LEE. Se enfoca en los productos que NO tienen categoría asignada,
// para saber qué son y poder clasificarlos.
// Córrelo con: node analizar-sin-categoria.js

const xmlrpc = require('xmlrpc');

const ODOO_URL = 'https://caaf-oil-services.odoo.com';
const ODOO_DB = 'caaf-oil-services';
const ODOO_USERNAME = 'jeymar789@gmail.com';
const ODOO_API_KEY = '70308a54b58b002cba27f12cc5abe88b41b96637';

const common = xmlrpc.createSecureClient({ url: ODOO_URL + '/xmlrpc/2/common' });
const models = xmlrpc.createSecureClient({ url: ODOO_URL + '/xmlrpc/2/object' });

let uid = null;

function autenticar() {
  return new Promise((resolve, reject) => {
    common.methodCall('authenticate', [ODOO_DB, ODOO_USERNAME, ODOO_API_KEY, {}], (err, id) => {
      if (err) return reject(err);
      if (!id) return reject(new Error('Autenticación fallida: revisa usuario y API key'));
      uid = id;
      resolve(id);
    });
  });
}

function ejecutar(modelo, metodo, args, kwargs = {}) {
  return new Promise((resolve, reject) => {
    models.methodCall(
      'execute_kw',
      [ODOO_DB, uid, ODOO_API_KEY, modelo, metodo, args, kwargs],
      (err, res) => (err ? reject(err) : resolve(res))
    );
  });
}

function familiaDe(nombre) {
  const primero = String(nombre || '').trim().split(/[\s\-_/]+/)[0];
  return primero.toUpperCase() || '(sin nombre)';
}

async function main() {
  await autenticar();
  console.log('Conectado. Leyendo el catálogo...\n');

  const todos = [];
  const LOTE = 500;
  let desplazamiento = 0;

  while (true) {
    const lote = await ejecutar('product.template', 'search_read', [[]], {
      fields: ['name', 'default_code', 'categ_id', 'type', 'list_price'],
      limit: LOTE,
      offset: desplazamiento,
    });
    if (lote.length === 0) break;
    todos.push(...lote);
    desplazamiento += lote.length;
    process.stdout.write(`  leídos ${desplazamiento}...\r`);
    if (lote.length < LOTE) break;
  }

  const sinCategoria = todos.filter((p) => !p.categ_id);

  console.log('                              \n');
  console.log('===== PRODUCTOS SIN CATEGORÍA:', sinCategoria.length, '=====\n');

  // ¿Son servicios o productos físicos?
  const porTipo = new Map();
  for (const p of sinCategoria) {
    const t = p.type || '(vacío)';
    porTipo.set(t, (porTipo.get(t) || 0) + 1);
  }
  console.log('--- Por tipo de producto en Odoo ---');
  [...porTipo.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([t, n]) => console.log(String(n).padStart(6), ' ', t));
  console.log('');

  // ¿El nombre empieza con número (código) o con letra (descripción)?
  const conCodigo = sinCategoria.filter((p) => /^\d/.test(String(p.name || '').trim()));
  const conTexto = sinCategoria.filter((p) => !/^\d/.test(String(p.name || '').trim()));

  console.log('--- Forma del nombre ---');
  console.log('Empiezan con NÚMERO (parecen código de pieza):', conCodigo.length);
  console.log('Empiezan con LETRA  (parecen descripción)   :', conTexto.length);
  console.log('');

  // Familias más comunes dentro de los que no tienen categoría
  const familias = new Map();
  for (const p of sinCategoria) {
    const f = familiaDe(p.name);
    familias.set(f, (familias.get(f) || 0) + 1);
  }

  console.log('--- 50 familias más comunes SIN categoría ---');
  [...familias.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50)
    .forEach(([f, n]) => console.log(String(n).padStart(6), ' ', f));
  console.log('');

  // Ejemplos reales, para ver cómo están escritos
  console.log('--- 30 ejemplos que empiezan con LETRA ---');
  conTexto.slice(0, 30).forEach((p) => {
    console.log(`  [${p.default_code || 'sin ref'}] ${p.name}  ($${p.list_price})`);
  });
  console.log('');

  console.log('--- 30 ejemplos que empiezan con NÚMERO ---');
  conCodigo.slice(0, 30).forEach((p) => {
    console.log(`  [${p.default_code || 'sin ref'}] ${p.name}  ($${p.list_price})`);
  });

  console.log('\nListo. Cópiame todo este resultado.');
}

main().catch((err) => {
  console.error('\nERROR:', err.message);
});
