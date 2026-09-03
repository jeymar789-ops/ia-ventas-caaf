// clientes-por-cotizacion.js
// Muestra QUIÉN es el cliente de cada cotización de embobinado, para poder
// comparar los precios que se le dan a cada tipo de cliente.
// Solo LEE, no modifica nada.
//
// Córrelo con: node clientes-por-cotizacion.js

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

// Saca la capacidad del texto: "BOBINADO DE MOTOR 10HP" -> 10 HP
function sacarCapacidad(texto) {
  const t = String(texto || '').toUpperCase();
  const hp = t.match(/(\d+(?:[.,]\d+)?)\s*(?:HP|CP)/);
  if (hp) return { valor: parseFloat(hp[1].replace(',', '.')), unidad: 'HP' };
  const kw = t.match(/(\d+(?:[.,]\d+)?)\s*KW/);
  if (kw) return { valor: parseFloat(kw[1].replace(',', '.')), unidad: 'KW' };
  const kva = t.match(/(\d+(?:[.,]\d+)?)\s*KVA/);
  if (kva) return { valor: parseFloat(kva[1].replace(',', '.')), unidad: 'KVA' };
  return null;
}

async function main() {
  await autenticar();
  console.log('Conectado. Buscando cotizaciones de embobinado...\n');

  // Líneas de bobinado / embobinado
  const dominio = ['|', '|',
    ['name', 'ilike', 'BOBINADO'],
    ['name', 'ilike', 'EMBOBINAD'],
    ['name', 'ilike', 'REBOBINAD'],
  ];

  const lineas = await ejecutar('sale.order.line', 'search_read', [dominio], {
    fields: ['order_id', 'name', 'price_unit', 'product_uom_qty'],
    limit: 2000,
  });

  console.log(`${lineas.length} líneas de embobinado encontradas\n`);

  // Datos de las cotizaciones (cliente, fecha, estado)
  const ordenIds = [...new Set(lineas.map((l) => l.order_id && l.order_id[0]).filter(Boolean))];

  const ordenes = new Map();
  const LOTE = 80;
  for (let i = 0; i < ordenIds.length; i += LOTE) {
    const trozo = ordenIds.slice(i, i + LOTE);
    const datos = await ejecutar('sale.order', 'read', [
      trozo,
      ['name', 'partner_id', 'date_order', 'state', 'amount_total'],
    ]);
    datos.forEach((o) => ordenes.set(o.id, o));
  }

  // Armamos el listado
  const filas = [];
  for (const l of lineas) {
    const o = ordenes.get(l.order_id[0]);
    if (!o) continue;

    const cap = sacarCapacidad(l.name);
    filas.push({
      folio: o.name,
      fecha: String(o.date_order || '').slice(0, 10),
      cliente: o.partner_id ? o.partner_id[1] : '(sin cliente)',
      estado: o.state,
      capacidad: cap ? `${cap.valor} ${cap.unidad}` : '?',
      orden: cap ? cap.valor : 9999,
      precio: l.price_unit,
      concepto: String(l.name).replace(/\s+/g, ' ').trim().slice(0, 55),
    });
  }

  filas.sort((a, b) => a.orden - b.orden || a.precio - b.precio);

  console.log('='.repeat(120));
  console.log(
    'CAPACIDAD'.padEnd(12) + 'PRECIO'.padStart(11) + '  ' +
    'FECHA'.padEnd(12) + 'FOLIO'.padEnd(9) + 'CLIENTE'
  );
  console.log('='.repeat(120));

  filas.forEach((f) => {
    console.log(
      f.capacidad.padEnd(12) +
      ('$' + Number(f.precio).toLocaleString('es-MX')).padStart(11) + '  ' +
      f.fecha.padEnd(12) +
      f.folio.padEnd(9) +
      f.cliente.slice(0, 45)
    );
  });

  // Resumen por cliente
  console.log('\n' + '='.repeat(60));
  console.log('CUÁNTOS EMBOBINADOS POR CLIENTE');
  console.log('='.repeat(60));
  const porCliente = new Map();
  filas.forEach((f) => porCliente.set(f.cliente, (porCliente.get(f.cliente) || 0) + 1));
  [...porCliente.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([c, n]) => console.log(String(n).padStart(4) + '  ' + c));

  const cols = ['capacidad', 'precio', 'fecha', 'folio', 'cliente', 'estado', 'concepto'];
  const csv = [cols.join(',')];
  filas.forEach((f) => {
    csv.push(cols.map((c) => `"${String(f[c] ?? '').replace(/"/g, '""')}"`).join(','));
  });
  fs.writeFileSync('embobinados-por-cliente.csv', '\uFEFF' + csv.join('\n'), 'utf8');

  console.log('\nDetalle en: embobinados-por-cliente.csv');
}

main().catch((err) => {
  console.error('\nERROR:', err.message);
});
