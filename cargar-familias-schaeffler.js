// cargar-familias-schaeffler.js
// Da de alta en Odoo las familias de rodamiento comercial que te faltan,
// dejando fuera lo especializado y lo muy caro.
//
// Calcula el precio igual que los demás: USD x 25.50
// (0.75 de descuento x 17.00 de tipo de cambio x 2 de margen)
// y llena también el costo y el precio en dólares.
//
// La primera vez déjalo en SIMULAR = true.
//
// ANTES: npm install xlsx  y el archivo de Schaeffler en esta carpeta.
// Córrelo con: node cargar-familias-schaeffler.js

const xmlrpc = require('xmlrpc');
const XLSX = require('xlsx');
const fs = require('fs');

// ============ CONFIGURACIÓN ============

const SIMULAR = false; // <<<<<< cámbialo a false para cargar de verdad

const ARCHIVO_SCHAEFFLER = 'L_P_SCHAEFFLER_2025-VENTA.xlsx';

const ODOO_URL = 'https://caaf-oil-services.odoo.com';
const ODOO_DB = 'caaf-oil-services';
const ODOO_USERNAME = 'jeymar789@gmail.com';
const ODOO_API_KEY = 'bfdd0d58b21d3f0fe2e6b40bb6ec9b0afd8faab7';

const DESCUENTO = 0.75;
const TIPO_CAMBIO = 17.0;
const MARGEN = 2;
const CAMPO_USD = 'x_precio_usd_lista';

// No cargamos piezas más caras que esto: son de maquinaria pesada y
// no se piden en el taller. Si alguien las pide, el bot te avisa.
const PRECIO_MAXIMO = 15000;

// Las familias que sí se venden en tu mercado
// La clave del SAT depende de si el rodamiento es de BOLAS o de RODILLOS:
//   31171504  Ball bearings   (bolas)
//   31171505  Roller bearings (rodillos, incluye cónicos y agujas)
const FAMILIAS = [
  { nombre: 'Chumaceras UC/UK', categoria: 'Chumaceras', sat: 'bolas', patron: /^(UC|UK)\d/ },
  { nombre: 'Soportes de chumacera', categoria: 'Soportes de chumacera', sat: 'bolas', patron: /^(PASE|PCJ|RCJ|PME|RASE|RAE|GRAE|GYE|PCJT|RCJT|PCJY|RCJY|FLCTE|PSHE|PSFE|RSHE|RALE)/ },
  { nombre: 'Cónicos', categoria: 'Conicos', sat: 'rodillos', patron: /^3[023]\d{3}($|-)/ },
  { nombre: 'Contacto angular', categoria: 'Contacto angular', sat: 'bolas', patron: /^7[23]\d{2}($|-)/ },
  { nombre: 'Axiales de bolas', categoria: 'Axiales', sat: 'bolas', patron: /^51\d{3}($|-)/ },
  { nombre: 'Autoalineantes', categoria: 'Autoalineantes', sat: 'bolas', patron: /^(12|22)\d{2}($|-)/ },
  { nombre: 'Agujas', categoria: 'Agujas', sat: 'rodillos', patron: /^(HK|BK)\d/ },
];

const CLAVE_SAT_RODILLOS = '31171505';

// De aquí copiamos la unidad de medida y la clave del SAT, para que los
// productos nuevos queden igual que los que ya tienes bien capturados.
const PRODUCTO_DE_REFERENCIA = '038896630-0030'; // 6205-2RSR-L038-C3

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

const pesos = (n) => '$' + Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Lee de un producto ya bien capturado la unidad de medida, la clave del
// SAT y la categoría padre, para que los nuevos queden igual.
async function leerPlantilla() {
  const campos = ['id', 'name', 'uom_id', 'categ_id'];

  // La clave del SAT solo existe si tienes la localización mexicana
  let tieneUnspsc = false;
  try {
    const campo = await ejecutar(
      'ir.model.fields',
      'search_read',
      [[['model', '=', 'product.template'], ['name', '=', 'unspsc_code_id']]],
      { fields: ['id'], limit: 1 }
    );
    tieneUnspsc = campo.length > 0;
    if (tieneUnspsc) campos.push('unspsc_code_id');
  } catch (err) {
    console.error('No pude revisar el campo de clave SAT:', err.message);
  }

  const ref = await ejecutar(
    'product.template',
    'search_read',
    [[['default_code', '=', PRODUCTO_DE_REFERENCIA]]],
    { fields: campos, limit: 1 }
  );

  if (ref.length === 0) {
    console.log('⚠ No encontré el producto de referencia. Los nuevos van a quedar');
    console.log('  con la unidad y la clave SAT por omisión, revísalos después.\n');
    return { uom: null, unspsc: null, categoriaPadre: null, tieneUnspsc };
  }

  const p = ref[0];
  const uom = p.uom_id ? p.uom_id[0] : null;
  const unspsc = tieneUnspsc && p.unspsc_code_id ? p.unspsc_code_id[0] : null;

  console.log('Plantilla tomada de:', p.name);
  console.log('  Unidad de medida :', p.uom_id ? p.uom_id[1] : '(ninguna)');
  console.log('  Clave del SAT    :', tieneUnspsc && p.unspsc_code_id ? p.unspsc_code_id[1] : '(no configurada)');
  console.log('  Categoría        :', p.categ_id ? p.categ_id[1] : '(ninguna)');
  console.log('');

  // El padre de la categoría de rodamientos, para colgar ahí las nuevas
  let categoriaPadre = null;
  if (p.categ_id) {
    const cat = await ejecutar('product.category', 'read', [[p.categ_id[0]], ['parent_id']]);
    if (cat[0] && cat[0].parent_id) {
      const abuelo = await ejecutar('product.category', 'read', [[cat[0].parent_id[0]], ['parent_id', 'name']]);
      categoriaPadre = abuelo[0] && abuelo[0].parent_id ? abuelo[0].parent_id[0] : cat[0].parent_id[0];
    }
  }

  return { uom, unspsc, categoriaPadre, tieneUnspsc };
}

// Busca en Odoo la clave del SAT de rodamientos de rodillos
async function buscarClaveRodillos() {
  try {
    const r = await ejecutar(
      'product.unspsc.code',
      'search_read',
      [[['code', '=', CLAVE_SAT_RODILLOS]]],
      { fields: ['id', 'name', 'code'], limit: 1 }
    );
    if (r.length > 0) {
      console.log(`  Clave para rodillos: ${r[0].code} ${r[0].name}`);
      return r[0].id;
    }
    console.log(`  ⚠ No encontré la clave ${CLAVE_SAT_RODILLOS} en Odoo.`);
    console.log('    Los cónicos y agujas van a llevar la misma clave que los de bolas.');
    return null;
  } catch (err) {
    console.error('  No pude buscar la clave de rodillos:', err.message);
    return null;
  }
}

// Busca o crea la categoría de cada familia
const categoriasCache = new Map();
async function obtenerCategoria(nombre, padreId) {
  if (categoriasCache.has(nombre)) return categoriasCache.get(nombre);

  const dominio = [['name', '=', nombre]];
  if (padreId) dominio.push(['parent_id', '=', padreId]);

  const existentes = await ejecutar('product.category', 'search_read', [dominio], {
    fields: ['id'],
    limit: 1,
  });

  let id;
  if (existentes.length > 0) {
    id = existentes[0].id;
  } else {
    const datos = { name: nombre };
    if (padreId) datos.parent_id = padreId;
    id = await ejecutar('product.category', 'create', [datos]);
    console.log(`  Categoría creada: ${nombre}`);
  }

  categoriasCache.set(nombre, id);
  return id;
}

async function main() {
  if (!fs.existsSync(ARCHIVO_SCHAEFFLER)) {
    throw new Error(`No encontré "${ARCHIVO_SCHAEFFLER}" en esta carpeta.`);
  }

  console.log(SIMULAR ? '=== SIMULACIÓN: no se carga nada ===\n' : '=== MODO REAL: se van a crear productos en Odoo ===\n');

  // ---- Lista oficial ----
  console.log('Leyendo la lista de Schaeffler...');
  const libro = XLSX.readFile(ARCHIVO_SCHAEFFLER);
  const hoja = libro.Sheets[libro.SheetNames[0]];
  const filas = XLSX.utils.sheet_to_json(hoja, { range: 2, defval: null });

  const candidatos = [];
  for (const f of filas) {
    const sap = String(f['No. SAP'] || '').trim();
    const desc = String(f['Material Description'] || '').trim();
    const usd = Number(f['PRECIOS NUEVOS  2025']);
    if (!sap || !desc || !isFinite(usd) || usd <= 0) continue;

    const arriba = desc.toUpperCase();
    const familia = FAMILIAS.find((g) => g.patron.test(arriba));
    if (!familia) continue;

    const precio = +(usd * DESCUENTO * TIPO_CAMBIO * MARGEN).toFixed(2);
    if (precio > PRECIO_MAXIMO) continue;

    candidatos.push({
      sap,
      desc,
      usd,
      categoria: familia.categoria,
      sat: familia.sat,
      costo: +(usd * DESCUENTO * TIPO_CAMBIO).toFixed(2),
      precio,
      familia: familia.nombre,
      marca: f['Brand'],
    });
  }
  console.log(`  ${candidatos.length} productos de las familias elegidas, dentro del tope de ${pesos(PRECIO_MAXIMO)}\n`);

  // ---- Qué ya tienes ----
  await autenticar();
  console.log('Revisando cuáles ya están en Odoo...');

  const yaEstan = new Set();
  const LOTE = 500;
  let off = 0;
  while (true) {
    const lote = await ejecutar('product.template', 'search_read', [[['default_code', '!=', false]]], {
      fields: ['default_code'],
      limit: LOTE,
      offset: off,
    });
    if (lote.length === 0) break;
    lote.forEach((p) => yaEstan.add(String(p.default_code).trim()));
    off += lote.length;
    if (lote.length < LOTE) break;
  }

  const nuevos = candidatos.filter((p) => !yaEstan.has(p.sap));
  console.log(`  ${candidatos.length - nuevos.length} ya los tienes, ${nuevos.length} son nuevos\n`);

  const plantilla = await leerPlantilla();

  let claveRodillos = null;
  if (plantilla.tieneUnspsc) {
    claveRodillos = await buscarClaveRodillos();
    console.log('');
  }

  // ---- Resumen por familia ----
  const porFamilia = new Map();
  nuevos.forEach((p) => {
    const a = porFamilia.get(p.familia) || { cuantos: 0, min: Infinity, max: 0, ejemplo: p };
    a.cuantos++;
    a.min = Math.min(a.min, p.precio);
    a.max = Math.max(a.max, p.precio);
    porFamilia.set(p.familia, a);
  });

  console.log('=============== LO QUE SE VA A CARGAR ===============\n');
  console.log('CANT'.padStart(6) + '  ' + 'FAMILIA'.padEnd(24) + 'DESDE'.padStart(12) + 'HASTA'.padStart(13));
  console.log('-'.repeat(58));
  [...porFamilia.entries()]
    .sort((a, b) => b[1].cuantos - a[1].cuantos)
    .forEach(([nombre, a]) => {
      console.log(
        String(a.cuantos).padStart(6) + '  ' + nombre.padEnd(24) +
        pesos(a.min).padStart(12) + pesos(a.max).padStart(13)
      );
    });
  console.log('-'.repeat(58));
  console.log(String(nuevos.length).padStart(6) + '  TOTAL\n');

  console.log('=== 15 EJEMPLOS ===\n');
  nuevos.slice(0, 15).forEach((p) => {
    console.log(`  [${p.sap}] ${p.desc.slice(0, 32).padEnd(34)} ${pesos(p.precio)}`);
  });

  // ---- Guardar la lista ----
  const cols = ['sap', 'desc', 'familia', 'usd', 'costo', 'precio', 'marca'];
  const csv = [cols.join(',')];
  nuevos.forEach((p) => {
    csv.push(cols.map((c) => `"${String(p[c] ?? '').replace(/"/g, '""')}"`).join(','));
  });
  fs.writeFileSync('nuevos-productos.csv', '\uFEFF' + csv.join('\n'), 'utf8');
  console.log(`\nLista completa en: nuevos-productos.csv`);

  if (SIMULAR) {
    console.log('\n=== CÓMO QUEDARÍAN LOS PRODUCTOS ===');
    console.log('  Unidad de medida : ' + (plantilla.uom ? 'copiada de tu producto de referencia' : 'la que ponga Odoo por omisión'));
    const cuantosRodillos = nuevos.filter((x) => x.sat === 'rodillos').length;
    console.log('  Clave del SAT    : bolas (31171504) para ' + (nuevos.length - cuantosRodillos) + ' productos');
    console.log('                     rodillos (' + CLAVE_SAT_RODILLOS + ') para ' + cuantosRodillos + ' (cónicos y agujas)');
    if (!claveRodillos && plantilla.tieneUnspsc) {
      console.log('                     ⚠ la de rodillos no se encontró, irían todos con la de bolas');
    }
    console.log('  Categoría        : una por familia, colgada de tu árbol de rodamientos');
    console.log('\nEsto fue una simulación, NO se creó nada en Odoo.');
    console.log('Revisa el CSV y, si estás de acuerdo, pon SIMULAR = false.');
    return;
  }

  // ---- Cargar ----
  console.log('\nCreando productos en Odoo...');
  let hechos = 0;
  let fallidos = 0;

  for (const p of nuevos) {
    const datos = {
      name: p.desc,
      default_code: p.sap,
      type: 'consu',
      is_storable: true,
      list_price: p.precio,
      standard_price: p.costo,
      sale_ok: true,
      purchase_ok: true,
      [CAMPO_USD]: p.usd,
    };

    // Unidad de medida y clave del SAT, copiadas de tus productos buenos
    if (plantilla.uom) datos.uom_id = plantilla.uom;
    // Los cónicos y las agujas son de rodillos, llevan otra clave del SAT
    if (p.sat === 'rodillos' && claveRodillos) {
      datos.unspsc_code_id = claveRodillos;
    } else if (plantilla.unspsc) {
      datos.unspsc_code_id = plantilla.unspsc;
    }

    // Categoría según la familia
    try {
      datos.categ_id = await obtenerCategoria(p.categoria, plantilla.categoriaPadre);
    } catch (err) {
      console.error(`  No se pudo asignar categoría a ${p.desc}: ${err.message}`);
    }

    try {
      await ejecutar('product.template', 'create', [datos]);
      hechos++;
    } catch (err) {
      // Si is_storable no existe en esta versión, lo intentamos sin ese campo
      try {
        delete datos.is_storable;
        await ejecutar('product.template', 'create', [datos]);
        hechos++;
      } catch (err2) {
        fallidos++;
        if (fallidos <= 3) console.error(`\n  Falló ${p.desc}: ${err2.message.slice(0, 120)}`);
      }
    }

    if ((hechos + fallidos) % 25 === 0) {
      process.stdout.write(`  ${hechos + fallidos} de ${nuevos.length}...\r`);
    }
  }

  console.log(`\n\nListo. Se crearon ${hechos} productos.`);
  if (fallidos > 0) console.log(`${fallidos} fallaron, revisa los mensajes de arriba.`);
  console.log('\nRevísalos en Odoo: Inventario -> Productos, ordenando por fecha de creación.');
}

main().catch((err) => {
  console.error('\nERROR:', err.message);
});