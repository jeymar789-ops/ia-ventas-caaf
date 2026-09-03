// historial-rodamientos.js
// Busca en tus cotizaciones y ventas pasadas qué rodamientos se usaron
// en cada motor, para armar una tabla de referencia con datos reales.
// Solo LEE, no modifica nada.
//
// Córrelo con: node historial-rodamientos.js

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

// ¿Esta línea parece un rodamiento? (6205, 6312-C3, NU2210, 6205-2RSR...)
function esRodamiento(texto) {
  const t = String(texto || '').toUpperCase().trim();
  return /^(6\d{3}|6\d{2}\b|N[UJ]P?\d{3,}|2\d{4}|3\d{4}|32\d{2}|22\d{3})/.test(t);
}

// Saca los HP mencionados: "MOTOR 25HP", "motor de 7.5 hp", "10 CP"
function sacarHP(texto) {
  const t = String(texto || '').toUpperCase();
  const m = t.match(/(\d+(?:[.,]\d+)?)\s*(?:HP|CP|C\.P\.|H\.P\.)/);
  return m ? m[1].replace(',', '.') : null;
}

// Saca las RPM si vienen mencionadas
function sacarRPM(texto) {
  const t = String(texto || '').toUpperCase();
  const m = t.match(/(\d{3,4})\s*(?:RPM|R\.P\.M\.)/);
  return m ? m[1] : null;
}

// Saca el armazón si viene: 324T, 256T, 143T
function sacarArmazon(texto) {
  const t = String(texto || '').toUpperCase();
  const m = t.match(/\b(\d{3}[TS]{1,2})\b/);
  return m ? m[1] : null;
}

async function main() {
  await autenticar();
  console.log('Conectado. Buscando trabajos de cambio de rodamientos...\n');

  // 1) Líneas que hablan de cambio de rodamientos / baleros
  const palabras = ['RODAMIENTO', 'BALERO', 'CAMBIO'];
  const dominio = [];
  palabras.forEach((_, i) => { if (i > 0) dominio.push('|'); });
  palabras.forEach((p) => dominio.push(['name', 'ilike', p]));

  const lineasServicio = await ejecutar('sale.order.line', 'search_read', [dominio], {
    fields: ['order_id', 'name'],
    limit: 5000,
  });

  const ordenIds = [...new Set(lineasServicio.map((l) => l.order_id && l.order_id[0]).filter(Boolean))];
  console.log(`Encontré ${lineasServicio.length} líneas en ${ordenIds.length} cotizaciones\n`);

  if (ordenIds.length === 0) {
    console.log('No hay historial suficiente para armar la tabla.');
    return;
  }

  // 2) Todas las líneas de esas cotizaciones
  const todasLasLineas = [];
  const LOTE = 80;
  for (let i = 0; i < ordenIds.length; i += LOTE) {
    const trozo = ordenIds.slice(i, i + LOTE);
    const lineas = await ejecutar(
      'sale.order.line',
      'search_read',
      [[['order_id', 'in', trozo]]],
      { fields: ['order_id', 'name', 'product_id', 'product_uom_qty'], limit: 5000 }
    );
    todasLasLineas.push(...lineas);
    process.stdout.write(`  leídas ${todasLasLineas.length} líneas...\r`);
  }
  console.log(`  ${todasLasLineas.length} líneas en total          \n`);

  // 3) Agrupamos por cotización
  const porOrden = new Map();
  for (const l of todasLasLineas) {
    const id = l.order_id[0];
    if (!porOrden.has(id)) porOrden.set(id, { folio: l.order_id[1], lineas: [] });
    porOrden.get(id).lineas.push(l);
  }

  // 4) De cada cotización sacamos: HP/rpm/armazón + los rodamientos que llevó
  const casos = [];

  for (const [, orden] of porOrden) {
    let hp = null;
    let rpm = null;
    let armazon = null;
    const rodamientos = [];

    for (const l of orden.lineas) {
      const nombreProducto = l.product_id ? l.product_id[1] : '';
      const texto = `${l.name} ${nombreProducto}`;

      if (!hp) hp = sacarHP(texto);
      if (!rpm) rpm = sacarRPM(texto);
      if (!armazon) armazon = sacarArmazon(texto);

      // El nombre del producto en Odoo viene como "[REF] NOMBRE"
      const limpio = nombreProducto.replace(/^\[.*?\]\s*/, '').trim();
      if (esRodamiento(limpio)) {
        rodamientos.push({ nombre: limpio, cantidad: l.product_uom_qty });
      }
    }

    if ((hp || armazon) && rodamientos.length > 0) {
      casos.push({ folio: orden.folio, hp, rpm, armazon, rodamientos });
    }
  }

  console.log(`=== ${casos.length} trabajos con motor identificado y rodamientos ===\n`);

  // 5) Agrupamos por HP
  const porHP = new Map();
  for (const c of casos) {
    const clave = c.hp ? `${c.hp} HP` : `armazón ${c.armazon}`;
    if (!porHP.has(clave)) porHP.set(clave, []);
    porHP.get(clave).push(c);
  }

  const ordenadas = [...porHP.entries()].sort((a, b) => {
    const n = (s) => parseFloat(s) || 9999;
    return n(a[0]) - n(b[0]);
  });

  for (const [clave, lista] of ordenadas) {
    // Contamos qué rodamientos se repiten en ese tamaño de motor
    const cuenta = new Map();
    for (const c of lista) {
      for (const r of c.rodamientos) {
        const base = r.nombre.split(/[\s\-]/)[0];
        cuenta.set(base, (cuenta.get(base) || 0) + 1);
      }
    }
    const top = [...cuenta.entries()].sort((a, b) => b[1] - a[1]);

    console.log(`--- ${clave}  (${lista.length} trabajo/s) ---`);
    console.log('    ' + top.map(([r, n]) => `${r} x${n}`).join('  '));
    // Un ejemplo concreto para que se vea el caso real
    const ej = lista[0];
    console.log(`    ej. ${ej.folio}: ${ej.rodamientos.map((r) => r.nombre).join(' + ')}`);
    console.log('');
  }

  // 6) CSV con el detalle
  const lineasCsv = ['folio,hp,rpm,armazon,rodamientos'];
  for (const c of casos) {
    lineasCsv.push(
      [c.folio, c.hp || '', c.rpm || '', c.armazon || '', c.rodamientos.map((r) => r.nombre).join(' + ')]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(',')
    );
  }
  fs.writeFileSync('historial-rodamientos.csv', '\uFEFF' + lineasCsv.join('\n'), 'utf8');
  console.log('Detalle completo en: historial-rodamientos.csv');
}

main().catch((err) => {
  console.error('\nERROR:', err.message);
});
