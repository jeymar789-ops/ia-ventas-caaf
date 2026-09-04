// codigos-barras.js
// Le pone código de barras a los alambres y cables que no lo tengan.
//
// Los códigos son numéricos de 13 dígitos, tipo EAN-13, para que cualquier
// lector los lea sin problema:
//
//   2 0001 00001 X   -> alambres magneto
//   2 0002 00001 X   -> cables
//
// El 2 al inicio marca que es un código de uso interno, no comercial.
// El último dígito es de control, calculado como manda el estándar EAN-13.
//
// La primera vez déjalo en SIMULAR = true para ver qué haría.
// Cuando lo revises, cámbialo a false y vuelve a correrlo.
//
// Córrelo con: node codigos-barras.js

const xmlrpc = require('xmlrpc');
const fs = require('fs');

// ============ CONFIGURACIÓN ============

const SIMULAR = false; // <<<<<< cámbialo a false para aplicar de verdad

const ODOO_URL = 'https://caaf-oil-services.odoo.com';
const ODOO_DB = 'caaf-oil-services';
const ODOO_USERNAME = 'jeymar789@gmail.com';
const ODOO_API_KEY = '81a4aa6702454703508e11710103c61d10ee279a';

// Qué productos incluir y con qué familia numerarlos
const GRUPOS = [
  { familia: '0001', etiqueta: 'ALAMBRE MAGNETO', palabras: ['ALAMBRE'] },
  { familia: '0002', etiqueta: 'CABLE', palabras: ['CABLE'] },
];

// =======================================

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

// El dígito de control del EAN-13: se multiplican las posiciones impares
// por 1 y las pares por 3, se suman, y se completa a la decena siguiente.
function digitoControl(doce) {
  let suma = 0;
  for (let i = 0; i < 12; i++) {
    suma += Number(doce[i]) * (i % 2 === 0 ? 1 : 3);
  }
  return String((10 - (suma % 10)) % 10);
}

function armarCodigo(familia, consecutivo) {
  const base = '2' + familia + String(consecutivo).padStart(7, '0');
  return base + digitoControl(base);
}

async function main() {
  await autenticar();
  console.log(SIMULAR ? '=== SIMULACIÓN: no se modifica nada ===\n' : '=== MODO REAL: se escribe en Odoo ===\n');

  // Códigos que ya existen, para no repetir ninguno
  const conCodigo = await ejecutar(
    'product.product',
    'search_read',
    [[['barcode', '!=', false]]],
    { fields: ['id', 'barcode'], limit: 5000 }
  );
  const yaUsados = new Set(conCodigo.map((p) => String(p.barcode)));
  console.log(`Ya hay ${yaUsados.size} productos con código de barras\n`);

  const asignados = [];

  for (const grupo of GRUPOS) {
    const dominio = [];
    grupo.palabras.forEach((_, i) => { if (i > 0) dominio.push('|'); });
    grupo.palabras.forEach((p) => dominio.push(['name', 'ilike', p]));

    const productos = await ejecutar('product.product', 'search_read', [dominio], {
      fields: ['id', 'name', 'barcode', 'qty_available', 'uom_id', 'type'],
      limit: 500,
    });

    // Palabras que delatan que NO es material a granel sino otra cosa:
    // un servicio, una herramienta o un accesorio que solo menciona la palabra.
    const NO_APLICA = [
      'SERVICIO', 'INSTALACION', 'INSTALACIÓN', 'COLOCACION', 'COLOCACIÓN',
      'CAMBIO DE', 'SUMINISTRO DE', 'RESTRUCTURACION', 'RESTRUCTURACIÓN',
      'CEPILLO', 'PINZAS', 'BANDA', 'GANCHO', 'MALACATE', 'SENSOR',
    ];

    const sinCodigo = productos
      .filter((p) => !p.barcode)
      // Solo bienes físicos, nada de servicios
      .filter((p) => p.type !== 'service')
      // Y que el nombre no traiga palabras que lo delaten
      .filter((p) => {
        const nombre = String(p.name).toUpperCase();
        return !NO_APLICA.some((mala) => nombre.includes(mala));
      })
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));

    const descartados = productos.filter((p) => !p.barcode).length - sinCodigo.length;
    if (descartados > 0) {
      console.log(`  (se descartaron ${descartados} que son servicios o accesorios)`);
    }

    console.log(`========== ${grupo.etiqueta} ==========`);
    console.log(`  ${productos.length} encontrados, ${sinCodigo.length} sin código\n`);

    let consecutivo = 1;

    for (const p of sinCodigo) {
      // Buscamos un consecutivo que no esté ocupado
      let codigo = armarCodigo(grupo.familia, consecutivo);
      while (yaUsados.has(codigo)) {
        consecutivo++;
        codigo = armarCodigo(grupo.familia, consecutivo);
      }
      yaUsados.add(codigo);
      consecutivo++;

      const unidad = p.uom_id ? p.uom_id[1] : '';
      console.log(`  ${codigo}   ${String(p.name).slice(0, 45).padEnd(47)} ${p.qty_available} ${unidad}`);

      asignados.push({ id: p.id, nombre: p.name, codigo, grupo: grupo.etiqueta });
    }
    console.log('');
  }

  if (asignados.length === 0) {
    console.log('Todos los alambres y cables ya tienen código de barras.');
    return;
  }

  // Guardamos la lista para tenerla a la mano
  const csv = ['codigo,nombre,grupo'];
  asignados.forEach((a) => {
    csv.push([a.codigo, a.nombre, a.grupo].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
  });
  fs.writeFileSync('codigos-barras.csv', '\uFEFF' + csv.join('\n'), 'utf8');
  console.log(`Lista guardada en: codigos-barras.csv (${asignados.length} productos)\n`);

  if (SIMULAR) {
    console.log('Esto fue una simulación, NO se modificó nada en Odoo.');
    console.log('Si los códigos se ven bien, pon SIMULAR = false y vuelve a correrlo.');
    return;
  }

  console.log('Escribiendo en Odoo...');
  let hechos = 0;
  for (const a of asignados) {
    try {
      await ejecutar('product.product', 'write', [[a.id], { barcode: a.codigo }]);
      hechos++;
      process.stdout.write(`  ${hechos} de ${asignados.length}...\r`);
    } catch (err) {
      console.error(`\n  Falló ${a.nombre}: ${err.message}`);
    }
  }

  console.log(`\n\nListo. Se asignaron ${hechos} códigos de barras.`);
  console.log('Ahora en Odoo: Inventario -> Productos, selecciónalos y usa');
  console.log('Acciones -> Imprimir etiquetas, con el formato 2 x 7.');
}

main().catch((err) => {
  console.error('\nERROR:', err.message);
});