// inventario.js
// Te dice qué tienes en almacén, cuánto vale a costo y cuánto a precio de venta.
// Solo LEE, no modifica nada.
//
// Córrelo con: node inventario.js

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

const pesos = (n) =>
  '$' + Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  await autenticar();
  console.log('Conectado. Leyendo el inventario...\n');

  const productos = [];
  const LOTE = 500;
  let off = 0;

  while (true) {
    const lote = await ejecutar('product.product', 'search_read', [[]], {
      fields: ['name', 'default_code', 'qty_available', 'standard_price', 'list_price', 'categ_id'],
      limit: LOTE,
      offset: off,
    });
    if (lote.length === 0) break;
    productos.push(...lote);
    off += lote.length;
    process.stdout.write(`  leídos ${off}...\r`);
    if (lote.length < LOTE) break;
  }

  console.log(`  ${productos.length} productos revisados          \n`);

  const conStock = productos
    .filter((p) => Number(p.qty_available) > 0)
    .map((p) => {
      const cantidad = Number(p.qty_available) || 0;
      const costo = Number(p.standard_price) || 0;
      const venta = Number(p.list_price) || 0;
      return {
        referencia: p.default_code || '',
        nombre: p.name,
        categoria: p.categ_id ? p.categ_id[1] : '',
        cantidad,
        costo_unitario: costo,
        valor_costo: +(cantidad * costo).toFixed(2),
        precio_venta: venta,
        valor_venta: +(cantidad * venta).toFixed(2),
      };
    })
    .sort((a, b) => b.valor_costo - a.valor_costo);

  const totalCosto = conStock.reduce((s, p) => s + p.valor_costo, 0);
  const totalVenta = conStock.reduce((s, p) => s + p.valor_venta, 0);
  const totalPiezas = conStock.reduce((s, p) => s + p.cantidad, 0);
  const sinCosto = conStock.filter((p) => p.costo_unitario === 0);

  console.log('================ TU INVENTARIO ================');
  console.log('Productos con existencia :', conStock.length);
  console.log('Piezas en total          :', totalPiezas.toLocaleString('es-MX'));
  console.log('');
  console.log('Valor a COSTO            :', pesos(totalCosto));
  console.log('Valor a PRECIO DE VENTA  :', pesos(totalVenta));
  console.log('Ganancia si lo vendes    :', pesos(totalVenta - totalCosto));
  console.log('');

  if (sinCosto.length > 0) {
    console.log(`⚠ ${sinCosto.length} productos con existencia NO tienen costo capturado,`);
    console.log('  así que el valor a costo sale más bajo de lo real.\n');
  }

  console.log('=== LOS 30 QUE MÁS DINERO TIENES PARADO ===\n');
  console.log(
    'CANT'.padStart(6) + '  ' + 'VALOR COSTO'.padStart(14) + '  ' +
    'C/U'.padStart(11) + '  PRODUCTO'
  );
  console.log('-'.repeat(95));

  conStock.slice(0, 30).forEach((p) => {
    console.log(
      String(p.cantidad).padStart(6) + '  ' +
      pesos(p.valor_costo).padStart(14) + '  ' +
      pesos(p.costo_unitario).padStart(11) + '  ' +
      p.nombre.slice(0, 45)
    );
  });

  // Resumen por categoría
  const porCategoria = new Map();
  conStock.forEach((p) => {
    const c = p.categoria || '(sin categoría)';
    const a = porCategoria.get(c) || { costo: 0, piezas: 0, productos: 0 };
    a.costo += p.valor_costo;
    a.piezas += p.cantidad;
    a.productos++;
    porCategoria.set(c, a);
  });

  console.log('\n=== POR CATEGORÍA ===\n');
  [...porCategoria.entries()]
    .sort((a, b) => b[1].costo - a[1].costo)
    .forEach(([c, a]) => {
      console.log(pesos(a.costo).padStart(15) + '   ' + String(a.piezas).padStart(6) + ' pzas   ' + c);
    });

  const cols = ['referencia', 'nombre', 'categoria', 'cantidad', 'costo_unitario', 'valor_costo', 'precio_venta', 'valor_venta'];
  const csv = [cols.join(',')];
  conStock.forEach((p) => {
    csv.push(cols.map((c) => `"${String(p[c] ?? '').replace(/"/g, '""')}"`).join(','));
  });
  fs.writeFileSync('inventario.csv', '\uFEFF' + csv.join('\n'), 'utf8');

  console.log('\nDetalle completo en: inventario.csv');
}

main().catch((err) => {
  console.error('\nERROR:', err.message);
});
