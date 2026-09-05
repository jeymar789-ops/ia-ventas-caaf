// que-falta-de-schaeffler.js
// Compara la lista completa de Schaeffler contra tu catálogo de Odoo
// y te dice qué familias de producto NO tienes dadas de alta.
// Solo LEE, no modifica nada.
//
// Necesita el archivo de Schaeffler en esta misma carpeta.
// Córrelo con: node que-falta-de-schaeffler.js

const xmlrpc = require('xmlrpc');
const XLSX = require('xlsx');
const fs = require('fs');

const ARCHIVO_SCHAEFFLER = 'L_P_SCHAEFFLER_2025-VENTA.xlsx';

const ODOO_URL = 'https://caaf-oil-services.odoo.com';
const ODOO_DB = 'caaf-oil-services';
const ODOO_USERNAME = 'jeymar789@gmail.com';
const ODOO_API_KEY = 'bfdd0d58b21d3f0fe2e6b40bb6ec9b0afd8faab7';

const FACTOR = 25.5; // USD x 0.75 de descuento x 17 de tipo de cambio x 2

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

// Saca la familia del código: "UC205-16" -> "UC", "6205-2RSR" -> "62",
// "NU2210-E" -> "NU". Es para agrupar por tipo de rodamiento.
function familiaDe(desc) {
  const t = String(desc || '').toUpperCase().trim();
  const letras = t.match(/^([A-Z]{2,5})\d/);
  if (letras) return letras[1];
  const numeros = t.match(/^(\d{2})/);
  if (numeros) return 'serie ' + numeros[1] + 'xx';
  return '(otros)';
}

async function main() {
  if (!fs.existsSync(ARCHIVO_SCHAEFFLER)) {
    throw new Error(`No encontré "${ARCHIVO_SCHAEFFLER}" en esta carpeta.`);
  }

  console.log('Leyendo la lista de Schaeffler...');
  const libro = XLSX.readFile(ARCHIVO_SCHAEFFLER);
  const hoja = libro.Sheets[libro.SheetNames[0]];
  const filas = XLSX.utils.sheet_to_json(hoja, { range: 2, defval: null });

  const catalogo = [];
  for (const f of filas) {
    const sap = String(f['No. SAP'] || '').trim();
    const desc = String(f['Material Description'] || '').trim();
    const usd = Number(f['PRECIOS NUEVOS  2025']);
    if (sap && desc && isFinite(usd) && usd > 0) {
      catalogo.push({ sap, desc, usd, marca: f['Brand'] });
    }
  }
  console.log(`  ${catalogo.length} productos en la lista oficial\n`);

  await autenticar();
  console.log('Leyendo tu catálogo de Odoo...');

  const misSap = new Set();
  const LOTE = 500;
  let off = 0;
  while (true) {
    const lote = await ejecutar('product.template', 'search_read', [[['default_code', '!=', false]]], {
      fields: ['default_code'],
      limit: LOTE,
      offset: off,
    });
    if (lote.length === 0) break;
    lote.forEach((p) => misSap.add(String(p.default_code).trim()));
    off += lote.length;
    process.stdout.write(`  leídos ${off}...\r`);
    if (lote.length < LOTE) break;
  }
  console.log(`  ${misSap.size} referencias en tu Odoo          \n`);

  // ¿Qué tengo y qué me falta?
  const tengo = [];
  const faltan = [];
  for (const p of catalogo) {
    (misSap.has(p.sap) ? tengo : faltan).push(p);
  }

  console.log('=============== RESUMEN ===============');
  console.log('Productos de Schaeffler         :', catalogo.length);
  console.log('Ya los tienes en Odoo           :', tengo.length);
  console.log('NO los tienes dados de alta     :', faltan.length);
  console.log('');

  // Agrupamos lo que falta por familia
  const porFamilia = new Map();
  for (const p of faltan) {
    const f = familiaDe(p.desc);
    const a = porFamilia.get(f) || { cuantos: 0, ejemplos: [], sumaUsd: 0 };
    a.cuantos++;
    a.sumaUsd += p.usd;
    if (a.ejemplos.length < 3) a.ejemplos.push(p);
    porFamilia.set(f, a);
  }

  // Y también contamos cuántas de cada familia SÍ tienes
  const tengoPorFamilia = new Map();
  for (const p of tengo) {
    const f = familiaDe(p.desc);
    tengoPorFamilia.set(f, (tengoPorFamilia.get(f) || 0) + 1);
  }

  const orden = [...porFamilia.entries()].sort((a, b) => b[1].cuantos - a[1].cuantos);

  console.log('=== 30 FAMILIAS CON MÁS PRODUCTOS QUE TE FALTAN ===\n');
  console.log('FALTAN'.padStart(7) + '  ' + 'TIENES'.padStart(7) + '  FAMILIA   EJEMPLO');
  console.log('-'.repeat(85));

  orden.slice(0, 30).forEach(([familia, a]) => {
    const tiene = tengoPorFamilia.get(familia) || 0;
    const ej = a.ejemplos[0];
    const precio = (ej.usd * FACTOR).toFixed(2);
    console.log(
      String(a.cuantos).padStart(7) + '  ' +
      String(tiene).padStart(7) + '  ' +
      familia.padEnd(9) + ' ' +
      `${ej.desc.slice(0, 28).padEnd(30)} $${precio}`
    );
  });

  console.log('\n=== FAMILIAS QUE NO TIENES NI UNA SOLA ===\n');
  const cero = orden.filter(([f]) => !tengoPorFamilia.has(f));
  cero.slice(0, 25).forEach(([familia, a]) => {
    const ej = a.ejemplos[0];
    console.log(
      String(a.cuantos).padStart(6) + '  ' + familia.padEnd(9) + ' ' +
      `${ej.desc.slice(0, 30).padEnd(32)} $${(ej.usd * FACTOR).toFixed(2)}`
    );
  });

  const cols = ['sap', 'desc', 'usd', 'precio_mxn', 'familia', 'marca'];
  const csv = [cols.join(',')];
  faltan.forEach((p) => {
    const fila = {
      sap: p.sap,
      desc: p.desc,
      usd: p.usd,
      precio_mxn: (p.usd * FACTOR).toFixed(2),
      familia: familiaDe(p.desc),
      marca: p.marca,
    };
    csv.push(cols.map((c) => `"${String(fila[c] ?? '').replace(/"/g, '""')}"`).join(','));
  });
  fs.writeFileSync('faltan-de-schaeffler.csv', '\uFEFF' + csv.join('\n'), 'utf8');

  console.log('\nDetalle completo en: faltan-de-schaeffler.csv');
}

main().catch((err) => {
  console.error('\nERROR:', err.message);
});
