// analizar-catalogo.js
// Solo LEE tu catálogo de Odoo y te dice cómo está. No modifica nada.
// Pega tu API key y córrelo con: node analizar-catalogo.js

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

// De "6205-2RS-C3 TIMKEN" saca "6205". De "NU2210-E" saca "NU2210".
function familiaDe(nombre) {
  const primero = String(nombre || '').trim().split(/[\s\-_/]+/)[0];
  return primero.toUpperCase() || '(sin nombre)';
}

// Cuenta cuántas veces aparece cada valor y regresa la lista ordenada.
function contar(mapa, clave) {
  mapa.set(clave, (mapa.get(clave) || 0) + 1);
}

function ordenar(mapa) {
  return [...mapa.entries()].sort((a, b) => b[1] - a[1]);
}

async function main() {
  await autenticar();
  console.log('Conectado a Odoo. Leyendo el catálogo, tarda un poco...\n');

  const categorias = new Map();
  const familias = new Map();

  let total = 0;
  let vendibles = 0;
  let sinCodigo = 0;
  let sinCategoria = 0;

  const LOTE = 500;
  let desplazamiento = 0;

  while (true) {
    const lote = await ejecutar('product.template', 'search_read', [[]], {
      fields: ['name', 'default_code', 'categ_id', 'sale_ok'],
      limit: LOTE,
      offset: desplazamiento,
    });
    if (lote.length === 0) break;

    for (const p of lote) {
      total++;
      if (p.sale_ok) vendibles++;
      if (!p.default_code) sinCodigo++;

      if (p.categ_id) {
        contar(categorias, p.categ_id[1]);
      } else {
        sinCategoria++;
        contar(categorias, '(sin categoría)');
      }

      contar(familias, familiaDe(p.name));
    }

    desplazamiento += lote.length;
    process.stdout.write(`  leídos ${desplazamiento}...\r`);
    if (lote.length < LOTE) break;
  }

  console.log('                              \n');
  console.log('=========== RESUMEN GENERAL ===========');
  console.log('Productos en total      :', total);
  console.log('Marcados como vendibles :', vendibles);
  console.log('SIN referencia interna  :', sinCodigo);
  console.log('SIN categoría asignada  :', sinCategoria);
  console.log('');

  console.log('=========== CATEGORÍAS ACTUALES ===========');
  ordenar(categorias).forEach(([nombre, cuantos]) => {
    console.log(String(cuantos).padStart(6), ' ', nombre);
  });
  console.log('');

  const fam = ordenar(familias);
  console.log('=========== 40 FAMILIAS MÁS COMUNES ===========');
  console.log('(la primera palabra del nombre, que suele ser el código base)\n');
  fam.slice(0, 40).forEach(([nombre, cuantos]) => {
    console.log(String(cuantos).padStart(6), ' ', nombre);
  });

  console.log('\nFamilias distintas en total:', fam.length);
  console.log('\nListo. Cópiame todo este resultado.');
}

main().catch((err) => {
  console.error('\nERROR:', err.message);
});