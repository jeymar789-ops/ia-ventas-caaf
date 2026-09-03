// preparar-precios.js
// 1) Crea en Odoo el campo "Precio lista USD" (una sola vez)
// 2) Lo llena con el precio de Schaeffler, cruzando por No. SAP
// 3) Calcula y actualiza el COSTO y el PRECIO DE VENTA con el tipo de cambio de hoy
//
// ANTES DE CORRERLO:
//   1) npm install xlsx
//   2) Copia el archivo de Schaeffler a esta carpeta
//
// La primera vez déjalo en SIMULAR = true: no toca nada, solo te enseña qué haría.
// Cuando revises y estés de acuerdo, cámbialo a false y vuelve a correrlo.
//
// Córrelo con: node preparar-precios.js

const xmlrpc = require('xmlrpc');
const XLSX = require('xlsx');
const fs = require('fs');

const SIMULAR = false;// ============ CONFIGURACIÓN ============

// <<<<<< cámbialo a false cuando quieras aplicar de verdad

const ARCHIVO_SCHAEFFLER = 'L_P_SCHAEFFLER_2025-VENTA.xlsx';

const ODOO_URL = 'https://caaf-oil-services.odoo.com';
const ODOO_DB = 'caaf-oil-services';
const ODOO_USERNAME = 'jeymar789@gmail.com';
const ODOO_API_KEY = '70308a54b58b002cba27f12cc5abe88b41b96637';

const DESCUENTO = 0.75; // te dan 25% de descuento sobre lista
const MARGEN = 2; // vendes al doble del costo

// Déjalo en null para que consulte el tipo de cambio del día.
// Si prefieres fijarlo tú, pon el número: TIPO_CAMBIO_MANUAL = 17.00


const CAMPO_USD = 'x_precio_usd_lista';

// =======================================
const TIPO_CAMBIO_MANUAL = 17.00;
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

async function obtenerTipoDeCambio() {
  if (TIPO_CAMBIO_MANUAL) {
    console.log(`Tipo de cambio fijado a mano: ${TIPO_CAMBIO_MANUAL}\n`);
    return TIPO_CAMBIO_MANUAL;
  }
  const r = await fetch('https://open.er-api.com/v6/latest/USD');
  const d = await r.json();
  const tc = d?.rates?.MXN;
  if (!tc) throw new Error('No pude obtener el tipo de cambio. Usa TIPO_CAMBIO_MANUAL.');
  console.log(`Tipo de cambio de hoy: ${tc.toFixed(4)} MXN por dólar\n`);
  return tc;
}

// Se asegura de que exista el campo del precio en dólares
async function asegurarCampo() {
  const existe = await ejecutar(
    'ir.model.fields',
    'search_read',
    [[['model', '=', 'product.template'], ['name', '=', CAMPO_USD]]],
    { fields: ['id'], limit: 1 }
  );

  if (existe.length > 0) {
    console.log(`El campo ${CAMPO_USD} ya existe en Odoo.\n`);
    return true;
  }

  if (SIMULAR) {
    console.log(`[SIMULACIÓN] Se crearía el campo ${CAMPO_USD} en Odoo.\n`);
    return true;
  }

  const modelo = await ejecutar('ir.model', 'search_read', [[['model', '=', 'product.template']]], {
    fields: ['id'],
    limit: 1,
  });

  try {
    await ejecutar('ir.model.fields', 'create', [
      {
        name: CAMPO_USD,
        field_description: 'Precio lista USD (Schaeffler)',
        model_id: modelo[0].id,
        ttype: 'float',
        state: 'manual',
      },
    ]);
    console.log(`Campo ${CAMPO_USD} creado en Odoo.\n`);
    return true;
  } catch (err) {
    console.error('\nNo se pudo crear el campo automáticamente:', err.message);
    console.error('Créalo a mano en Odoo con Studio, en Productos:');
    console.error(`  Nombre técnico: ${CAMPO_USD}`);
    console.error('  Tipo: Número decimal');
    console.error('  Etiqueta: Precio lista USD (Schaeffler)\n');
    return false;
  }
}

async function main() {
  if (!fs.existsSync(ARCHIVO_SCHAEFFLER)) {
    throw new Error(`No encontré "${ARCHIVO_SCHAEFFLER}" en esta carpeta.`);
  }

  console.log(SIMULAR ? '=== MODO SIMULACIÓN: no se modifica nada ===\n' : '=== MODO REAL: se va a escribir en Odoo ===\n');

  // ---- Lista oficial ----
  console.log('Leyendo la lista de Schaeffler...');
  const libro = XLSX.readFile(ARCHIVO_SCHAEFFLER);
  const hoja = libro.Sheets[libro.SheetNames[0]];
  const filas = XLSX.utils.sheet_to_json(hoja, { range: 2, defval: null });

  const porSap = new Map();
  for (const f of filas) {
    const sap = String(f['No. SAP'] || '').trim();
    const usd = Number(f['PRECIOS NUEVOS  2025']);
    if (sap && isFinite(usd) && usd > 0) porSap.set(sap, usd);
  }
  console.log(`  ${porSap.size} referencias con precio\n`);

  await autenticar();
  const tipoCambio = await obtenerTipoDeCambio();
  const ok = await asegurarCampo();
  if (!ok) return;

  // ---- Catálogo ----
  console.log('Leyendo tu catálogo de Odoo...');
  const productos = [];
  const LOTE = 500;
  let off = 0;
  while (true) {
    const lote = await ejecutar('product.template', 'search_read', [[['default_code', '!=', false]]], {
      fields: ['name', 'default_code', 'list_price', 'standard_price'],
      limit: LOTE,
      offset: off,
    });
    if (lote.length === 0) break;
    productos.push(...lote);
    off += lote.length;
    process.stdout.write(`  leídos ${off}...\r`);
    if (lote.length < LOTE) break;
  }
  console.log(`  ${productos.length} productos con referencia interna\n`);

  // ---- Calcular ----
  const cambios = [];
  let sinMatch = 0;

  for (const p of productos) {
    const usd = porSap.get(String(p.default_code).trim());
    if (!usd) {
      sinMatch++;
      continue;
    }

    const costo = +(usd * DESCUENTO * tipoCambio).toFixed(2);
    const precio = +(costo * MARGEN).toFixed(2);

    cambios.push({
      id: p.id,
      nombre: p.name,
      ref: p.default_code,
      usd,
      precioAntes: Number(p.list_price) || 0,
      precioDespues: precio,
      costoAntes: Number(p.standard_price) || 0,
      costoDespues: costo,
    });
  }

  console.log('=============== RESUMEN ===============');
  console.log('Productos que SÍ son Schaeffler   :', cambios.length);
  console.log('Con referencia pero no en la lista:', sinMatch);
  console.log('');

  const suben = cambios.filter((c) => c.precioDespues > c.precioAntes + 0.01);
  const bajan = cambios.filter((c) => c.precioDespues < c.precioAntes - 0.01);
  const igual = cambios.length - suben.length - bajan.length;

  console.log('Les SUBE el precio :', suben.length);
  console.log('Les BAJA el precio :', bajan.length);
  console.log('Se quedan igual    :', igual);
  console.log('');

  const mayores = [...cambios]
    .sort((a, b) => Math.abs(b.precioDespues - b.precioAntes) - Math.abs(a.precioDespues - a.precioAntes))
    .slice(0, 20);

  console.log('=== 20 CAMBIOS MÁS GRANDES ===\n');
  mayores.forEach((c) => {
    const dif = c.precioDespues - c.precioAntes;
    console.log(
      `${dif > 0 ? '+' : '-'}$${String(Math.abs(dif).toFixed(2)).padEnd(10)} ` +
        `${String(c.precioAntes).padEnd(10)} -> ${String(c.precioDespues).padEnd(10)} ${c.nombre}`
    );
  });
  console.log('');

  // ---- Guardar reporte ----
  const cols = ['id', 'ref', 'nombre', 'usd', 'costoAntes', 'costoDespues', 'precioAntes', 'precioDespues'];
  const lineas = [cols.join(',')];
  for (const c of cambios) {
    lineas.push(cols.map((k) => `"${String(c[k] ?? '').replace(/"/g, '""')}"`).join(','));
  }
  fs.writeFileSync('cambios-precios.csv', '\uFEFF' + lineas.join('\n'), 'utf8');
  console.log('Detalle completo en: cambios-precios.csv\n');

  if (SIMULAR) {
    console.log('Esto fue una simulación, NO se modificó nada en Odoo.');
    console.log('Revisa el CSV y, si estás de acuerdo, pon SIMULAR = false y vuelve a correrlo.');
    return;
  }

  // ---- Aplicar, agrupando los que quedan con los mismos valores ----
  console.log('Aplicando cambios en Odoo...');
  const grupos = new Map();
  for (const c of cambios) {
    const clave = `${c.usd}`;
    if (!grupos.has(clave)) grupos.set(clave, { ids: [], c });
    grupos.get(clave).ids.push(c.id);
  }

  let hechos = 0;
  for (const { ids, c } of grupos.values()) {
    await ejecutar('product.template', 'write', [
      ids,
      {
        [CAMPO_USD]: c.usd,
        standard_price: c.costoDespues,
        list_price: c.precioDespues,
      },
    ]);
    hechos += ids.length;
    process.stdout.write(`  actualizados ${hechos} de ${cambios.length}...\r`);
  }

  console.log(`\n\nListo. Se actualizaron ${hechos} productos.`);
  console.log('De aquí en adelante, la actualización mensual ya no necesita el Excel.');
}

main().catch((err) => {
  console.error('\nERROR:', err.message);
});
