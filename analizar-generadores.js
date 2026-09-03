// analizar-generadores.js
// Busca en tu catálogo y en tus cotizaciones lo que tengas de generadores:
// embobinados de estator, excitatriz, campo, rotor, y sus precios.
// Solo LEE, no modifica nada.
//
// Córrelo con: node analizar-generadores.js

const xmlrpc = require('xmlrpc');
const fs = require('fs');

const ODOO_URL = 'https://caaf-oil-services.odoo.com';
const ODOO_DB = 'caaf-oil-services';
const ODOO_USERNAME = 'jeymar789@gmail.com';
const ODOO_API_KEY = '81a4aa6702454703508e11710103c61d10ee279a';

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

function dominioOr(campo, palabras) {
  const d = [];
  palabras.forEach((_, i) => { if (i > 0) d.push('|'); });
  palabras.forEach((p) => d.push([campo, 'ilike', p]));
  return d;
}

const PALABRAS_GENERADOR = [
  'GENERADOR', 'ALTERNADOR', 'PLANTA DE LUZ', 'ESTATOR', 'EXCITATRIZ',
  'EXITATRIZ', 'EXCITACION', 'EXITACION', 'KVA', 'ROTOR',
];

async function main() {
  await autenticar();
  console.log('Conectado.\n');

  // ---- 1) Productos relacionados con generadores ----
  const productos = await ejecutar(
    'product.template',
    'search_read',
    [dominioOr('name', PALABRAS_GENERADOR)],
    { fields: ['id', 'name', 'list_price', 'type', 'categ_id'], limit: 400 }
  );

  console.log(`========== PRODUCTOS DE GENERADOR (${productos.length}) ==========\n`);
  productos
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .forEach((p) => {
      const tipo = p.type === 'service' ? 'servicio' : 'bien    ';
      console.log(`  ${tipo}  $${String(p.list_price).padEnd(12)} ${p.name}`);
    });
  console.log('');

  // ---- 2) Cotizaciones que hablen de generadores ----
  const lineas = await ejecutar(
    'sale.order.line',
    'search_read',
    [dominioOr('name', PALABRAS_GENERADOR)],
    { fields: ['order_id'], limit: 2000 }
  );

  const ordenIds = [...new Set(lineas.map((l) => l.order_id && l.order_id[0]).filter(Boolean))];
  console.log(`========== COTIZACIONES CON GENERADORES: ${ordenIds.length} ==========\n`);

  if (ordenIds.length === 0) {
    console.log('No hay historial de generadores en Odoo.');
    console.log('Habrá que armar la tabla de precios desde cero.');
    return;
  }

  const detalle = [];

  for (const id of ordenIds.slice(0, 20)) {
    const todas = await ejecutar('sale.order.line', 'search_read', [[['order_id', '=', id]]], {
      fields: ['order_id', 'name', 'product_uom_qty', 'price_unit', 'price_subtotal'],
      limit: 100,
    });
    if (todas.length === 0) continue;

    console.log(`--- ${todas[0].order_id[1]} ---`);
    todas.forEach((l) => {
      const nombre = String(l.name).replace(/\s+/g, ' ').trim().slice(0, 75);
      console.log(`   ${String(l.product_uom_qty).padStart(5)} x $${String(l.price_unit).padEnd(12)} ${nombre}`);
      detalle.push({
        folio: todas[0].order_id[1],
        cantidad: l.product_uom_qty,
        precio: l.price_unit,
        concepto: nombre,
      });
    });
    console.log('');
  }

  const cols = ['folio', 'cantidad', 'precio', 'concepto'];
  const csv = [cols.join(',')];
  detalle.forEach((d) => {
    csv.push(cols.map((c) => `"${String(d[c] ?? '').replace(/"/g, '""')}"`).join(','));
  });
  fs.writeFileSync('generadores.csv', '\uFEFF' + csv.join('\n'), 'utf8');

  console.log('Detalle en: generadores.csv');
  console.log('\nListo. Cópiame todo este resultado.');
}

main().catch((err) => {
  console.error('\nERROR:', err.message);
});
