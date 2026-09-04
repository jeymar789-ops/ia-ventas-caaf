const express = require('express');
const xmlrpc = require('xmlrpc');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(express.json());

// ===== BASE DE DATOS EN DISCO =====
//
// Antes todo esto vivía en la memoria del servidor y se perdía en cada
// reinicio. Ahora vive en un archivo del disco de Render, así que sobrevive
// a los despliegues y a los reinicios.

const CARPETA_DATOS = fs.existsSync('/var/data') ? '/var/data' : __dirname;
const ARCHIVO_DATOS = path.join(CARPETA_DATOS, 'bot-datos.json');

// Las conversaciones se guardan 90 días y después se borran solas
const DIAS_QUE_SE_GUARDAN = 90;
const MS_POR_DIA = 24 * 60 * 60 * 1000;

let datos = {
  conversaciones: {}, // numero -> { mensajes: [], actualizado: fecha }
  modoHumano: {},     // numero -> fecha en que se activó
  telegram: {},       // id del mensaje de Telegram -> numero del cliente
  procesados: {},     // id del mensaje de WhatsApp -> fecha, para no repetir
};

function cargarDatos() {
  try {
    if (fs.existsSync(ARCHIVO_DATOS)) {
      const crudo = fs.readFileSync(ARCHIVO_DATOS, 'utf8');
      const guardado = JSON.parse(crudo);
      datos = {
        conversaciones: guardado.conversaciones || {},
        modoHumano: guardado.modoHumano || {},
        telegram: guardado.telegram || {},
        procesados: guardado.procesados || {},
      };
      console.log(
        `Datos cargados del disco: ${Object.keys(datos.conversaciones).length} conversaciones, ` +
          `${Object.keys(datos.modoHumano).length} en atención humana`
      );
    } else {
      console.log(`Sin datos previos. Se creará ${ARCHIVO_DATOS}`);
    }
  } catch (err) {
    console.error('No se pudieron leer los datos guardados:', err.message);
    console.error('Se arranca de cero para no quedar detenidos.');
  }
}

// Guardamos con un pequeño retraso para no escribir en disco a cada rato
let guardadoPendiente = null;
function guardarDatos() {
  if (guardadoPendiente) return;
  guardadoPendiente = setTimeout(() => {
    guardadoPendiente = null;
    try {
      // Escribimos primero en un archivo temporal y luego lo renombramos.
      // Así, si el servidor se cae a medio guardado, no se corrompe nada.
      const temporal = ARCHIVO_DATOS + '.tmp';
      fs.writeFileSync(temporal, JSON.stringify(datos), 'utf8');
      fs.renameSync(temporal, ARCHIVO_DATOS);
    } catch (err) {
      console.error('No se pudieron guardar los datos:', err.message);
    }
  }, 1500);
}

// Borra lo que ya pasó de los 90 días
function limpiarViejo() {
  const limite = Date.now() - DIAS_QUE_SE_GUARDAN * MS_POR_DIA;
  let borradas = 0;

  for (const [numero, conv] of Object.entries(datos.conversaciones)) {
    if (!conv.actualizado || conv.actualizado < limite) {
      delete datos.conversaciones[numero];
      delete datos.modoHumano[numero];
      borradas++;
    }
  }

  // Los enlaces de Telegram de conversaciones que ya no existen
  for (const [idMensaje, numero] of Object.entries(datos.telegram)) {
    if (!datos.conversaciones[numero]) delete datos.telegram[idMensaje];
  }

  // Los ids de mensajes ya atendidos solo hacen falta unas horas
  const limiteIds = Date.now() - 6 * 60 * 60 * 1000;
  for (const [id, cuando] of Object.entries(datos.procesados)) {
    if (cuando < limiteIds) delete datos.procesados[id];
  }

  if (borradas > 0) {
    console.log(`Limpieza: ${borradas} conversaciones de más de ${DIAS_QUE_SE_GUARDAN} días borradas`);
  }
  guardarDatos();
}

cargarDatos();
limpiarViejo();
setInterval(limpiarViejo, 12 * 60 * 60 * 1000); // revisa dos veces al día


// Este token lo inventas TÚ (cualquier palabra/número). Debe ser
// EXACTAMENTE el mismo que pongas en Meta, en "Token de verificación"
const VERIFY_TOKEN = 'caaf-oil-verify-2026';

// Variables de entorno (configuradas en Render)
// El .trim() recorta espacios sobrantes al inicio y al final, para que
// un espacio invisible al copiar/pegar no vuelva a tumbar la conexión.
const ANTHROPIC_API_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const WHATSAPP_TOKEN = (process.env.WHATSAPP_TOKEN || '').trim();
const WHATSAPP_PHONE_ID = (process.env.WHATSAPP_PHONE_ID || '').trim();

const ODOO_URL = (process.env.ODOO_URL || '').trim(); // ej: https://caaf-oil-services.odoo.com
const ODOO_DB = (process.env.ODOO_DB || '').trim(); // ej: caaf-oil-services
const ODOO_USERNAME = (process.env.ODOO_USERNAME || '').trim();
const ODOO_API_KEY = (process.env.ODOO_API_KEY || '').trim();

// Telegram: por aquí te avisa el bot y por aquí le contestas al cliente
const TELEGRAM_TOKEN = (process.env.TELEGRAM_TOKEN || '').trim();
const TELEGRAM_CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();

console.log('=== Revisión de variables de Odoo en Render ===');
console.log('URL     largo:', ODOO_URL.length);
console.log('DB      largo:', ODOO_DB.length);
console.log('USUARIO largo:', ODOO_USERNAME.length);
console.log('API KEY largo:', ODOO_API_KEY.length);
console.log('==============================================');

// ===== CONEXIÓN A ODOO (XML-RPC) =====
const commonClient = xmlrpc.createSecureClient({ url: `${ODOO_URL}/xmlrpc/2/common` });
const objectClient = xmlrpc.createSecureClient({ url: `${ODOO_URL}/xmlrpc/2/object` });

let odooUid = null; // se guarda una vez autenticado, para no repetir el login en cada consulta

function odooAutenticar() {
  return new Promise((resolve, reject) => {
    if (odooUid) return resolve(odooUid);
    commonClient.methodCall(
      'authenticate',
      [ODOO_DB, ODOO_USERNAME, ODOO_API_KEY, {}],
      (error, uid) => {
        if (error) return reject(error);
        if (!uid) return reject(new Error('Autenticación con Odoo falló (usuario o API key incorrectos)'));
        odooUid = uid;
        resolve(uid);
      }
    );
  });
}

function odooEjecutar(modelo, metodo, args, kwargs = {}) {
  return new Promise((resolve, reject) => {
    objectClient.methodCall(
      'execute_kw',
      [ODOO_DB, odooUid, ODOO_API_KEY, modelo, metodo, args, kwargs],
      (error, resultado) => {
        if (error) return reject(error);
        resolve(resultado);
      }
    );
  });
}

// ===== BÚSQUEDA DE PRODUCTOS =====

// Palabras que la gente escribe pero que NO aparecen en el nombre del
// producto en Odoo. Si se las mandamos a la búsqueda, no encuentra nada.
const PALABRAS_IGNORADAS = new Set([
  // tipos de pieza
  'rodamiento', 'rodamientos', 'balero', 'baleros', 'chumacera', 'chumaceras',
  'motor', 'motores', 'banda', 'bandas', 'reten', 'retenes', 'sello', 'sellos',
  'pieza', 'piezas', 'refaccion', 'refacciones', 'producto', 'productos',
  // verbos y muletillas
  'tienes', 'tiene', 'tienen', 'hay', 'necesito', 'ocupo', 'quiero', 'busco',
  'buscar', 'dame', 'das', 'venden', 'vende', 'manejan', 'maneja', 'consigues',
  'cotizar', 'cotizacion', 'cotización', 'cotizame', 'checar', 'checame',
  // precio y stock
  'precio', 'precios', 'cuanto', 'cuánto', 'cuesta', 'cuestan', 'vale', 'valen',
  'stock', 'existencia', 'existencias', 'disponible', 'disponibles', 'inventario',
  // conectores
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'al',
  'para', 'con', 'sin', 'por', 'y', 'o', 'en', 'me', 'mi', 'su', 'que', 'qué',
  'favor', 'porfavor', 'gracias', 'hola', 'buenas', 'buenos', 'dias', 'días',
  'tardes', 'noches', 'marca',
]);

// Convierte lo que escribió el cliente en un término limpio de búsqueda.
// "Tienes rodamiento 6205-2RS-C3 TIMKEN?" -> "6205-2rs-c3 timken"
function limpiarQuery(texto) {
  return String(texto || '')
    .toLowerCase()
    .replace(/[¿?¡!.,;:()"']/g, ' ')
    .split(/\s+/)
    .filter((palabra) => palabra && !PALABRAS_IGNORADAS.has(palabra))
    .join(' ')
    .trim();
}

// Arma la lista de intentos, del más específico al más general.
function construirIntentos(query) {
  const original = String(query || '').trim();
  const limpio = limpiarQuery(original);
  const intentos = [];

  if (original) intentos.push(original);
  if (limpio) intentos.push(limpio);

  // Del término limpio, sacamos las palabras que traen números
  // (los códigos de pieza siempre traen números).
  const tokens = limpio.split(' ').filter(Boolean);
  const conNumero = tokens.filter((t) => /\d/.test(t));

  if (conNumero.length > 0) {
    // El código más largo suele ser el más específico: "6205-2rs-c3"
    const principal = [...conNumero].sort((a, b) => b.length - a.length)[0];
    intentos.push(principal);

    // Y por último el código base: "6205" de "6205-2rs-c3"
    const base = principal.match(/^[a-z]*\d{3,}/);
    if (base) intentos.push(base[0]);
  }

  // Quitamos repetidos conservando el orden
  return [...new Set(intentos.map((t) => t.trim()).filter(Boolean))];
}

// Busca productos en Odoo. Prueba varios términos, del más específico
// al más general, y se queda con el primero que dé resultados.
async function buscarProductoOdoo(query) {
  await odooAutenticar();

  const campos = {
    fields: ['id', 'name', 'list_price', 'qty_available', 'default_code'],
    limit: 80, // traemos bastantes para no perder de vista los que sí tienen stock
  };

  const intentos = construirIntentos(query);
  console.log(`Odoo: términos a probar para "${query}":`, intentos);

  for (const termino of intentos) {
    const encontrados = await odooEjecutar(
      'product.product',
      'search_read',
      [[
        '&',
        '&',
        ['sale_ok', '=', true],
        // Los de $0 y $1 son precios sin capturar: los escondemos del bot.
        // En cuanto se corrija el precio en Odoo, vuelven a aparecer solos.
        ['list_price', '>', 1],
        '|',
        ['name', 'ilike', termino],
        ['default_code', 'ilike', termino],
      ]],
      campos
    );

    console.log(`Odoo: busqué "${termino}" -> ${encontrados.length} resultado(s)`);

    if (encontrados.length > 0) {
      // Ordenamos poniendo primero los que SÍ tienen existencia
      const ordenados = [...encontrados].sort(
        (a, b) => (b.qty_available || 0) - (a.qty_available || 0)
      );
      const conExistencia = ordenados.filter((p) => (p.qty_available || 0) > 0);
      const MOSTRAR = 15;

      console.log(`Odoo: ${conExistencia.length} de ${encontrados.length} tienen existencia`);

      return {
        termino_usado: termino,
        total_encontrados: encontrados.length,
        cuantos_con_existencia: conExistencia.length,
        nota:
          encontrados.length > MOSTRAR
            ? `Se encontraron ${encontrados.length} variantes. Aquí van las primeras ${MOSTRAR}, ordenadas poniendo primero las que SÍ tienen existencia en almacén.`
            : undefined,
        productos: ordenados.slice(0, MOSTRAR),
      };
    }
  }

  console.log(`Odoo: sin resultados para "${query}"`);
  return {
    termino_usado: null,
    total_encontrados: 0,
    cuantos_con_existencia: 0,
    productos: [],
    nota: 'No se encontró ningún producto con esos términos en el catálogo.',
  };
}

// ===== ESTIMACIÓN DE RODAMIENTOS POR HP =====

// Tabla armada con trabajos reales del taller. "real" significa que ese dato
// salió de una cotización pasada; "estimado" es el escalón de arriba, para
// que la cotización nunca quede corta.
const TABLA_RODAMIENTOS = [
  { hastaHP: 2, la: '6205', lo: '6204', origen: 'real' },
  { hastaHP: 3, la: '6305', lo: '6205', origen: 'real' },
  { hastaHP: 5, la: '6206', lo: '6205', origen: 'real' },
  { hastaHP: 7.5, la: '6208', lo: '6206', origen: 'L.A. real, L.O. estimado' },
  { hastaHP: 10, la: '6307', lo: '6206', origen: 'real' },
  { hastaHP: 15, la: '6309', lo: '6207', origen: 'estimado' },
  { hastaHP: 20, la: '6309', lo: '6207', origen: 'real' },
  { hastaHP: 25, la: '6310', lo: '6210', origen: 'L.A. real, L.O. estimado' },
  { hastaHP: 30, la: '6312', lo: '6212', origen: 'estimado' },
  { hastaHP: 40, la: '6312', lo: '6212', origen: 'real' },
  { hastaHP: 50, la: '6312', lo: '6212', origen: 'real' },
];

const HP_MAXIMO_ESTIMABLE = 50;

// Busca en Odoo la mejor variante de un código de rodamiento.
// Si el motor va a 3600 rpm, prefiere las de juego C3/C4.
// Entre las candidatas se queda con la MÁS CARA, igual que hacen en el taller.
async function buscarRodamientoEstimado(codigo, necesitaJuego) {
  const candidatos = await odooEjecutar(
    'product.product',
    'search_read',
    [[
      '&',
      '&',
      ['sale_ok', '=', true],
      ['list_price', '>', 1],
      ['name', 'ilike', codigo],
    ]],
    { fields: ['id', 'name', 'list_price', 'qty_available'], limit: 60 }
  );

  // Nos quedamos solo con los que EMPIEZAN con ese código, para que un
  // "6205" no nos traiga el "16205".
  const delCodigo = candidatos.filter((p) =>
    String(p.name).toUpperCase().replace(/[^A-Z0-9]/g, '').startsWith(codigo)
  );
  if (delCodigo.length === 0) return null;

  const tieneJuego = (n) => /\bC[34]\b|C3$|C4$/i.test(String(n).replace(/[^A-Za-z0-9]/g, ' '));

  // Variantes especiales que un motor común NO lleva y que cuestan hasta
  // catorce veces más: jaula de latón (M, MA, MB), TB, TVP2, ranura de
  // anillo (NR), alta temperatura, cerámicas.
  const esEspecial = (nombre) => {
    const t = String(nombre).toUpperCase().replace(/[^A-Z0-9]/g, ' ');
    return /(^| )(M|MA|MB|M1|M1A|TB|TVP2|TVH|NR|J30PC|HLC|HLU|XL)( |$)/.test(t);
  };

  const normales = delCodigo.filter((p) => !esEspecial(p.name));
  const base = normales.length > 0 ? normales : delCodigo;

  let elegibles = base.filter((p) =>
    necesitaJuego ? tieneJuego(p.name) : !tieneJuego(p.name)
  );
  // Si no hay del tipo que buscamos, usamos cualquiera del código
  if (elegibles.length === 0) elegibles = base;

  // De las variantes normales, la más cara, que es como estiman en el taller
  elegibles.sort((a, b) => Number(b.list_price) - Number(a.list_price));
  return elegibles[0];
}

// Herramienta completa: recibe HP y rpm, regresa los dos rodamientos con precio.
async function estimarRodamientos(input) {
  await odooAutenticar();

  const hp = Number(input?.hp);
  const rpm = Number(input?.rpm) || null;

  if (!isFinite(hp) || hp <= 0) {
    return { error: 'Falta saber de cuántos HP es el motor.' };
  }

  if (hp > HP_MAXIMO_ESTIMABLE) {
    return {
      error: 'MOTOR_MUY_GRANDE',
      nota: `No hay datos suficientes para estimar motores de más de ${HP_MAXIMO_ESTIMABLE} HP. NO inventes rodamientos ni precios. Usa avisar_a_humano para que un asesor lo cotice.`,
    };
  }

  const fila = TABLA_RODAMIENTOS.find((f) => hp <= f.hastaHP);
  if (!fila) return { error: 'No encontré ese rango de HP en la tabla.' };

  // A 3600 rpm el rodamiento calienta más y necesita juego C3 o C4
  const necesitaJuego = rpm !== null && rpm >= 3000;

  const [productoLA, productoLO] = await Promise.all([
    buscarRodamientoEstimado(fila.la, necesitaJuego),
    buscarRodamientoEstimado(fila.lo, necesitaJuego),
  ]);

  console.log(
    `Estimación ${hp} HP${rpm ? ' a ' + rpm + ' rpm' : ''}: ` +
      `L.A. ${fila.la} -> ${productoLA ? productoLA.name : 'no encontrado'} | ` +
      `L.O. ${fila.lo} -> ${productoLO ? productoLO.name : 'no encontrado'}`
  );

  const armar = (p, lado, codigo) =>
    p
      ? {
          lado,
          producto_id: p.id,
          nombre: p.name,
          precio: p.list_price,
          existencia: p.qty_available,
        }
      : { lado, error: `No hay ${codigo} en el catálogo.` };

  return {
    hp,
    rpm,
    juego: necesitaJuego ? 'C3 o C4 (motor de alta velocidad)' : 'estándar',
    confianza: fila.origen,
    rodamientos: [
      armar(productoLA, 'L.A. (lado acoplamiento)', fila.la),
      armar(productoLO, 'L.O. (lado opuesto)', fila.lo),
    ],
    nota:
      'Esto es una ESTIMACIÓN basada en el tamaño del motor. Díselo al cliente con esas palabras: ' +
      'el rodamiento definitivo se confirma al abrir el motor. Recuérdale también que además de las ' +
      'piezas va el servicio de cambio de rodamientos L.A. y L.O., que un asesor le cotiza.',
  };
}

// ===== COTIZACIÓN DE REBOBINADO =====

// Costo del kilo de alambre magneto de cobre, SIN IVA.
// Cuando suba el cobre, cambia SOLO este número y todos los precios
// de rebobinado se recalculan solos.
const COSTO_KILO_COBRE = 460;

// El costo con el que se armó la tabla de abajo. No lo muevas: sirve para
// separar cuánto de cada precio era material y cuánto mano de obra.
const COBRE_BASE_TABLA = 460;

// Catálogo de precios de embobinado del taller.
// hp, polos, kilos de alambre, precio con el cobre a COBRE_BASE_TABLA.
const TABLA_EMBOBINADO = [
  // hp, kilos de alambre, precio con el cobre a COBRE_BASE_TABLA.
  // Precios sacados del historial real de cotizaciones a clientes de precio
  // abierto (Ingenio, Ajemex, Acuagranjas, Vimifos, Público General).
  // NO incluye a Embotelladora Mexicana / Coca-Cola, que va por contrato aparte.
  { hp: 0.5, kg: 2.0, precioBase: 2700 },
  { hp: 1, kg: 2.5, precioBase: 3200 },
  { hp: 2, kg: 3.5, precioBase: 3600 },
  { hp: 3, kg: 3.5, precioBase: 4500 },
  { hp: 4, kg: 5.0, precioBase: 5000 },
  { hp: 5, kg: 6.0, precioBase: 6800 },
  { hp: 7.5, kg: 8.0, precioBase: 9500 },
  { hp: 10, kg: 8.5, precioBase: 9800 },
  { hp: 15, kg: 15.0, precioBase: 15500 },
  { hp: 20, kg: 18.0, precioBase: 18000 },
  { hp: 25, kg: 22.0, precioBase: 19800 },
  { hp: 30, kg: 25.0, precioBase: 23500 },
  { hp: 40, kg: 30.0, precioBase: 28500 },
  { hp: 50, kg: 32.0, precioBase: 36000 },
  { hp: 60, kg: 50.0, precioBase: 50000 },
  { hp: 75, kg: 55.0, precioBase: 60000 },
  { hp: 100, kg: 60.0, precioBase: 78000 },
  { hp: 125, kg: 60.0, precioBase: 95000 },
];

const HP_MAXIMO_REBOBINADO = 125;

// Descripción que se imprime en la cotización del cliente.
// NUNCA menciones aquí el costo del alambre ni el cálculo interno.
// {HP} y {POLOS} se sustituyen solos.
function descripcionRebobinado(hp, polos) {
  return (
    `Rebobinado de motor eléctrico de ${hp} HP, ${polos} polos. ` +
    'Incluye retiro del devanado dañado, limpieza de ranuras, suministro y ' +
    'colocación de alambre magneto de cobre nuevo, aislamiento, amarre y ' +
    'conexión, impregnación con barniz aislante y pruebas eléctricas finales.'
  );
}

// Busca la unidad de medida "SERVICIO" para que la cotización no diga KILOS
let uomServicioId = null;
async function obtenerUomServicio() {
  if (uomServicioId !== null) return uomServicioId;
  try {
    const r = await odooEjecutar(
      'uom.uom',
      'search_read',
      [['|', ['name', 'ilike', 'SERVICIO'], ['name', 'ilike', 'UNIDAD']]],
      { fields: ['id', 'name'], limit: 5 }
    );
    const servicio = r.find((u) => /SERVICIO/i.test(u.name)) || r[0];
    uomServicioId = servicio ? servicio.id : false;
  } catch (err) {
    console.error('No pude buscar la unidad de medida:', err.message);
    uomServicioId = false;
  }
  return uomServicioId;
}

// Las rpm de placa nunca son las teóricas: un motor de 4 polos a 60 Hz
// anda en 1750-1800, no en 1800 exacto. Por eso vamos por rangos.
function polosDesdeRPM(rpm) {
  const r = Number(rpm);
  if (!isFinite(r) || r <= 0) return null;
  if (r >= 2500) return 2;
  if (r >= 1500) return 4;
  if (r >= 850) return 6;
  return 8; // más lento que eso, no está en la tabla
}

// Busca en Odoo el servicio de rebobinado de esa capacidad. Si no existe,
// lo da de alta con el precio calculado, para poder cotizarlo formalmente.
async function obtenerServicioRebobinado(hp, polos, precio) {
  const nombre = `REBOBINADO MOTOR ${hp} HP ${polos} POLOS`;

  const existentes = await odooEjecutar(
    'product.product',
    'search_read',
    [[['name', '=', nombre]]],
    { fields: ['id', 'name', 'list_price', 'description_sale'], limit: 1 }
  );

  if (existentes.length > 0) {
    const p = existentes[0];

    // Si quedó con la descripción vieja (la que enseñaba el costo del cobre),
    // la corregimos para que el cliente no la vea.
    if (!p.description_sale || /alambre de cobre a \$/i.test(p.description_sale)) {
      await odooEjecutar('product.product', 'write', [
        [p.id],
        { description_sale: descripcionRebobinado(hp, polos) },
      ]);
      console.log(`Odoo: descripción corregida en ${p.name}`);
    }

    return { id: p.id, nombre: p.name, precio: p.list_price, nuevo: false };
  }

  const datos = {
    name: nombre,
    type: 'service',
    list_price: precio,
    sale_ok: true,
    purchase_ok: false,
    description_sale: descripcionRebobinado(hp, polos),
  };

  // Ojo: en Odoo 19 ya no existe uom_po_id, solo uom_id.
  const uom = await obtenerUomServicio();
  if (uom) datos.uom_id = uom;

  let nuevoId;
  try {
    nuevoId = await odooEjecutar('product.product', 'create', [datos]);
  } catch (err) {
    // Si la unidad de medida da problema, creamos el producto sin ella.
    // Vale más una cotización con la unidad rara que ninguna cotización.
    console.error('No se pudo crear con la unidad de medida:', err.message);
    delete datos.uom_id;
    nuevoId = await odooEjecutar('product.product', 'create', [datos]);
  }

  console.log(`Odoo: producto de servicio CREADO -> ${nombre} ($${precio})`);
  await enviarTelegram(
    `🆕 Se dio de alta un servicio nuevo en Odoo:\n\n${nombre}\n$${precio}\n\nRevísalo por si hay que ajustarle el precio.`
  );

  return { id: nuevoId, nombre, precio, nuevo: true };
}

// Busca en el catálogo por una o varias palabras
async function buscarEnCatalogo(palabras, limite = 6) {
  const lista = Array.isArray(palabras) ? palabras : [palabras];

  const condiciones = [];
  lista.forEach((_, i) => { if (i > 0) condiciones.push('|'); });
  lista.forEach((w) => condiciones.push(['name', 'ilike', w]));

  const dominio = ['&', '&', ['sale_ok', '=', true], ['list_price', '>', 1], ...condiciones];

  const r = await odooEjecutar('product.product', 'search_read', [[...dominio]], {
    fields: ['id', 'name', 'list_price'],
    limit: limite,
  });
  return r.map((p) => ({ producto_id: p.id, nombre: p.name, precio: p.list_price }));
}

// Pintura y limpieza, que siempre acompañan al rebobinado
async function buscarComplementos() {
  const [pintura, limpieza] = await Promise.all([
    buscarEnCatalogo('PINTURA'),
    buscarEnCatalogo(['LIMPIEZA', 'LAVADO']),
  ]);
  return { pintura, limpieza };
}

// Piezas que muchas veces le faltan al motor cuando llega al taller
async function buscarPiezasFaltantes(estado) {
  const faltantes = {};
  const pendientesDePreguntar = [];

  const revisar = async (clave, etiqueta, palabras) => {
    if (estado[clave] === false) {
      faltantes[etiqueta] = await buscarEnCatalogo(palabras);
    } else if (estado[clave] !== true) {
      pendientesDePreguntar.push(etiqueta);
    }
  };

  await revisar('tiene_guarda', 'guarda', ['GUARDA', 'DEFLECTORA', 'TAPA DEFLECTORA']);
  await revisar('tiene_ventilador', 'ventilador', ['VELETA', 'VENTILADOR']);
  await revisar('tiene_caja_conexiones', 'caja de conexiones', ['CAJA DE CONEXION', 'CAJA CONEXION']);

  return { faltantes, pendientesDePreguntar };
}

async function cotizarRebobinado(input) {
  await odooAutenticar();

  let hp = Number(input?.hp);
  const kw = Number(input?.kw);
  if ((!isFinite(hp) || hp <= 0) && isFinite(kw) && kw > 0) {
    hp = kw / 0.746; // 1 HP = 0.746 kW
  }

  if (!isFinite(hp) || hp <= 0) {
    return { error: 'Falta la capacidad del motor. Pregúntale al cliente cuántos HP o kW tiene.' };
  }

  const rpm = Number(input?.rpm);
  const polos = polosDesdeRPM(rpm);
  if (!polos) {
    return { error: 'Faltan las rpm del motor. Sin ellas no se puede saber el número de polos ni cotizar.' };
  }
  if (polos === 8) {
    return {
      error: 'MOTOR_LENTO',
      nota: 'Los motores de 8 polos o más no están en la tabla. Usa avisar_a_humano para que un asesor lo cotice.',
    };
  }

  if (hp > HP_MAXIMO_REBOBINADO) {
    return {
      error: 'MOTOR_MUY_GRANDE',
      nota: `La tabla de rebobinado llega hasta ${HP_MAXIMO_REBOBINADO} HP. NO inventes precio. Usa avisar_a_humano.`,
    };
  }

  // Se cotiza con la capacidad de la tabla inmediatamente superior, para
  // que la cotización nunca quede corta.
  const fila = TABLA_EMBOBINADO
    .filter((f) => f.hp >= hp - 0.001)
    .sort((a, b) => a.hp - b.hp)[0];

  if (!fila) return { error: 'No encontré esa capacidad en la tabla.' };

  // El precio de la tabla se separa en material y mano de obra, para que
  // solo el material se mueva cuando cambia el cobre.
  const manoDeObra = fila.precioBase - fila.kg * COBRE_BASE_TABLA;
  const costoAlambre = fila.kg * COSTO_KILO_COBRE;
  const precio = Math.round(costoAlambre + manoDeObra);

  console.log(
    `Rebobinado ${hp} HP ${rpm} rpm -> tabla ${fila.hp} HP ${polos}P, ` +
      `${fila.kg} kg, cobre $${COSTO_KILO_COBRE} -> $${precio}`
  );

  const servicio = await obtenerServicioRebobinado(fila.hp, polos, precio);
  const complementos = await buscarComplementos();
  const { faltantes, pendientesDePreguntar } = await buscarPiezasFaltantes(input || {});

  // El paquete completo, como se cotiza en el taller
  const paqueteRodamientos = await obtenerPaqueteRodamientos(fila.hp);
  const tornilleria = await obtenerServicioTornilleria(fila.hp);

  const avisos = [
    'Este precio ya incluye alambre, barniz y mano de obra.',
    'Arma la cotización con las líneas de "paquete_completo", más pintura y limpieza de complementos_disponibles.',
    'RODAMIENTOS: si la PLACA del motor dice qué rodamientos lleva, desglósalos con buscar_producto ' +
      'y usa cotizar_cambio_rodamientos para la mano de obra, en lugar del paquete. ' +
      'Si NO se sabe qué rodamientos lleva, usa el paquete "CAMBIO DE RODAMIENTOS DE MOTOR" tal cual.',
  ];

  if (Object.keys(faltantes).length > 0) {
    avisos.push(
      `Al motor le faltan piezas (${Object.keys(faltantes).join(', ')}). ` +
        'Están en piezas_faltantes con su precio: agrégalas también a la cotización.'
    );
  }

  if (pendientesDePreguntar.length > 0) {
    avisos.push(
      `TODAVÍA NO SABES si el motor trae ${pendientesDePreguntar.join(', ')}. ` +
        'Pregúntaselo al cliente en un solo mensaje antes de cerrar la cotización, ' +
        'porque si le faltan son piezas extra que hay que cobrar.'
    );
  }

  if (!input?.voltaje) {
    avisos.push('Falta el voltaje: pídeselo, se necesita para el trabajo.');
  }

  avisos.push('Aclárale que el precio final se confirma al revisar el motor en el taller.');

  return {
    capacidad_solicitada: `${hp} HP`,
    capacidad_cotizada: `${fila.hp} HP, ${polos} polos (${rpm} rpm)`,
    voltaje: input?.voltaje || 'no lo dijo el cliente',
    kilos_de_alambre: fila.kg,
    costo_kilo_cobre: COSTO_KILO_COBRE,
    servicio_rebobinado: {
      producto_id: servicio.id,
      nombre: servicio.nombre,
      precio,
    },
    paquete_completo: [
      { concepto: 'Rebobinado', producto_id: servicio.id, nombre: servicio.nombre, precio },
      paqueteRodamientos
        ? { concepto: 'Cambio de rodamientos', ...paqueteRodamientos }
        : null,
      tornilleria ? { concepto: 'Tornillería', ...tornilleria } : null,
    ].filter(Boolean),
    complementos_disponibles: complementos,
    piezas_faltantes: faltantes,
    nota: avisos.join(' '),
  };
}

// ===== CATÁLOGO DE CONTRATO (COCA-COLA / EMBOTELLADORA) =====
//
// Son servicios ya dados de alta en Odoo con claves MX. El nombre sigue
// este patrón:  MX206644Ser embobinado motor 10 HP cambiar STD
// STD es el precio normal y EXT es el de urgencia (20% arriba).

const CONCEPTOS_MX = {
  embobinado: { busca: 'embobinado motor', etiqueta: 'Embobinado', base: true },
  rodamientos: { busca: 'rodamientos motor', etiqueta: 'Cambio de rodamientos', base: true },
  estructura: { busca: 'estructura motor', etiqueta: 'Limpieza y pintura', base: true },
  tapas: { busca: 'tapas motor', etiqueta: 'Ajuste de tapas', base: true },
  guarda: { busca: 'guar vent motor', etiqueta: 'Guarda de ventilador' },
  caja: { busca: 'caja conex motor', etiqueta: 'Caja de conexiones' },
  ventilador: { busca: 'ventilador motor', etiqueta: 'Ventilador' },
  eje: { busca: 'eje rotor motor', etiqueta: 'Reparación de flecha' },
  bornera: { busca: 'bornera motor', etiqueta: 'Bornera' },
  balanceo: { busca: 'balancear', etiqueta: 'Balanceo de rotor' },
};

// El catálogo se lee una vez y se guarda en memoria
let catalogoMX = null;

async function cargarCatalogoMX() {
  if (catalogoMX) return catalogoMX;

  const productos = await odooEjecutar(
    'product.product',
    'search_read',
    [[['name', 'ilike', 'MX20'], ['name', 'ilike', 'motor']]],
    { fields: ['id', 'name', 'list_price'], limit: 3000 }
  );

  catalogoMX = productos
    .map((p) => {
      const nombre = String(p.name);
      const hp = nombre.match(/motor\s+([\d.]+)\s*HP/i);
      const sufijo = /\bEXT\b/i.test(nombre) ? 'EXT' : /\bSTD\b/i.test(nombre) ? 'STD' : null;
      return {
        id: p.id,
        nombre,
        precio: Number(p.list_price) || 0,
        hp: hp ? parseFloat(hp[1]) : null,
        sufijo,
      };
    })
    .filter((p) => p.hp !== null && p.sufijo !== null && p.precio > 0);

  console.log(`Catálogo MX cargado: ${catalogoMX.length} servicios`);
  return catalogoMX;
}

// Busca el servicio del concepto pedido, en la capacidad más cercana
// hacia arriba, para que la cotización no quede corta.
function buscarServicioMX(catalogo, concepto, hp, sufijo) {
  const { busca } = CONCEPTOS_MX[concepto];

  const candidatos = catalogo.filter(
    (p) =>
      p.sufijo === sufijo &&
      p.nombre.toLowerCase().includes(busca.toLowerCase()) &&
      // "rotor motor" también aparece en "eje rotor motor", hay que separarlos
      (concepto !== 'balanceo' || /balancear/i.test(p.nombre)) &&
      (concepto !== 'eje' || /eje rotor/i.test(p.nombre)) &&
      (concepto !== 'ventilador' || !/guar vent/i.test(p.nombre))
  );

  if (candidatos.length === 0) return null;

  const arriba = candidatos.filter((p) => p.hp >= hp - 0.001).sort((a, b) => a.hp - b.hp);
  if (arriba.length > 0) return arriba[0];

  // Si el motor es más grande que todo el catálogo, el mayor que haya
  return candidatos.sort((a, b) => b.hp - a.hp)[0];
}

async function cotizarContratoMX(input) {
  await odooAutenticar();

  const hp = Number(input?.hp);
  if (!isFinite(hp) || hp <= 0) {
    return { error: 'Falta la capacidad del motor en HP.' };
  }

  if (input?.urgente !== true && input?.urgente !== false) {
    return {
      error: 'FALTA_URGENCIA',
      nota: 'Antes de cotizar tienes que preguntarle al cliente si el trabajo es URGENTE. Urgente se cotiza EXT y normal se cotiza STD, y el precio cambia.',
    };
  }

  const sufijo = input.urgente ? 'EXT' : 'STD';
  const catalogo = await cargarCatalogoMX();

  if (catalogo.length === 0) {
    return { error: 'No pude leer el catálogo de contrato en Odoo.' };
  }

  // Lo que siempre lleva un motor
  const conceptosBase = ['embobinado', 'rodamientos', 'estructura', 'tapas'];

  // Lo que se agrega según lo que le falte al motor
  const opcionales = [];
  if (input.tiene_guarda === false) opcionales.push('guarda');
  if (input.tiene_caja_conexiones === false) opcionales.push('caja');
  if (input.tiene_ventilador === false) opcionales.push('ventilador');
  if (input.flecha_danada === true) opcionales.push('eje');
  if (input.requiere_balanceo === true) opcionales.push('balanceo');
  if (input.requiere_bornera === true) opcionales.push('bornera');

  const lineas = [];
  const noEncontrados = [];

  for (const concepto of [...conceptosBase, ...opcionales]) {
    const servicio = buscarServicioMX(catalogo, concepto, hp, sufijo);
    if (servicio) {
      lineas.push({
        concepto: CONCEPTOS_MX[concepto].etiqueta,
        producto_id: servicio.id,
        nombre: servicio.nombre,
        precio: servicio.precio,
        capacidad_catalogo: `${servicio.hp} HP`,
      });
    } else {
      noEncontrados.push(CONCEPTOS_MX[concepto].etiqueta);
    }
  }

  const total = lineas.reduce((s, l) => s + l.precio, 0);

  console.log(
    `Contrato MX: ${hp} HP ${sufijo} -> ${lineas.length} servicios, total ${total}`
  );

  const pendientes = [];
  if (input.tiene_guarda === undefined) pendientes.push('guarda');
  if (input.tiene_caja_conexiones === undefined) pendientes.push('caja de conexiones');
  if (input.tiene_ventilador === undefined) pendientes.push('ventilador');
  if (input.flecha_danada === undefined) pendientes.push('estado de la flecha');

  return {
    cliente: 'Contrato (precios MX)',
    capacidad: `${hp} HP`,
    tipo: input.urgente ? 'EXT (urgencia)' : 'STD (normal)',
    lineas,
    total_sin_iva: total,
    servicios_no_encontrados: noEncontrados.length > 0 ? noEncontrados : undefined,
    pendientes_de_preguntar: pendientes.length > 0 ? pendientes : undefined,
    nota:
      pendientes.length > 0
        ? `Todavía te falta preguntarle por: ${pendientes.join(', ')}. Hazlo en un solo mensaje y vuelve a llamar la herramienta con esos datos.`
        : 'Ya tienes el paquete completo. Preséntaselo desglosado y ofrécele la cotización formal.',
  };
}

// ===== PAQUETE DE CAMBIO DE RODAMIENTOS =====
//
// Mientras el motor no esté abierto no se sabe qué rodamiento lleva, así que
// se cotiza como paquete: suministro y colocación en una sola línea, sin
// comprometerse a un número de pieza. Es como se cotiza en el taller.
//
// Los precios marcados "real" salieron de cotizaciones pasadas.
const TABLA_CAMBIO_RODAMIENTOS = [
  { hastaHP: 1, precio: 800, origen: 'real' },
  { hastaHP: 2, precio: 1100, origen: 'real' },
  { hastaHP: 5, precio: 1200, origen: 'real' },
  { hastaHP: 7.5, precio: 1300, origen: 'real' },
  { hastaHP: 10, precio: 1800, origen: 'real' },
  { hastaHP: 15, precio: 2200, origen: 'interpolado' },
  { hastaHP: 20, precio: 2800, origen: 'interpolado' },
  { hastaHP: 25, precio: 3000, origen: 'interpolado' },
  { hastaHP: 30, precio: 3500, origen: 'real' },
  { hastaHP: 40, precio: 3800, origen: 'interpolado' },
  { hastaHP: 50, precio: 4000, origen: 'real' },
  { hastaHP: 75, precio: 6000, origen: 'interpolado' },
  { hastaHP: 100, precio: 9000, origen: 'interpolado' },
  { hastaHP: 125, precio: 12800, origen: 'real' },
];

// La tornillería va en casi todas las cotizaciones del taller
const TABLA_TORNILLERIA = [
  { hastaHP: 10, precio: 300 },
  { hastaHP: 50, precio: 450 },
  { hastaHP: 125, precio: 900 },
];

const NOMBRE_TORNILLERIA = 'CAMBIO DE TORNILLERIA';

// Busca o crea el servicio de cambio de rodamientos de esa capacidad
async function obtenerPaqueteRodamientos(hp) {
  const fila = TABLA_CAMBIO_RODAMIENTOS.find((f) => hp <= f.hastaHP);
  if (!fila) return null;

  const nombre = `CAMBIO DE RODAMIENTOS DE MOTOR ${fila.hastaHP} HP`;
  const descripcion =
    'Suministro y colocación de rodamientos en lado acoplamiento y lado ' +
    'opuesto. Incluye desmontaje de tapas, extracción de los rodamientos ' +
    'dañados, limpieza de alojamientos y flecha, engrasado y pruebas de giro. ' +
    'El rodamiento definitivo se confirma al abrir el motor.';

  return obtenerOCrearServicio(nombre, fila.precio, descripcion);
}

async function obtenerServicioTornilleria(hp) {
  const fila = TABLA_TORNILLERIA.find((f) => hp <= f.hastaHP) || TABLA_TORNILLERIA[TABLA_TORNILLERIA.length - 1];
  const descripcion =
    'Cambio de toda la tornillería dañada del motor: tornillos, tuercas y ' +
    'arandelas de presión. Incluye extracción de tornillos capados.';

  return obtenerOCrearServicio(NOMBRE_TORNILLERIA, fila.precio, descripcion);
}

// Función común: busca el servicio por nombre y si no existe lo crea
async function obtenerOCrearServicio(nombre, precio, descripcion) {
  const existentes = await odooEjecutar(
    'product.product',
    'search_read',
    [[['name', '=', nombre]]],
    { fields: ['id', 'name', 'list_price'], limit: 1 }
  );

  if (existentes.length > 0) {
    return {
      producto_id: existentes[0].id,
      nombre: existentes[0].name,
      precio: existentes[0].list_price,
      nuevo: false,
    };
  }

  const datos = {
    name: nombre,
    type: 'service',
    list_price: precio,
    sale_ok: true,
    purchase_ok: false,
    description_sale: descripcion,
  };

  const uom = await obtenerUomServicio();
  if (uom) datos.uom_id = uom;

  let nuevoId;
  try {
    nuevoId = await odooEjecutar('product.product', 'create', [datos]);
  } catch (err) {
    console.error('No se pudo crear con unidad de medida:', err.message);
    delete datos.uom_id;
    nuevoId = await odooEjecutar('product.product', 'create', [datos]);
  }

  console.log(`Odoo: servicio creado -> ${nombre} ($${precio})`);
  await enviarTelegram(`🆕 Servicio nuevo en Odoo:\n\n${nombre}\n$${precio}`);

  return { producto_id: nuevoId, nombre, precio, nuevo: true };
}

// ===== SERVICIO DE CAMBIO DE RODAMIENTOS =====

// El servicio de cambio se cobra como un porcentaje del valor de los
// rodamientos. Cambia este número si ajustas la regla.
const PORCENTAJE_CAMBIO_RODAMIENTOS = 0.20;

const NOMBRE_SERVICIO_CAMBIO = 'SERVICIO DE CAMBIO DE RODAMIENTOS L.A. Y L.O.';

// Busca (o crea) el producto de servicio del cambio de rodamientos.
// El precio va por línea, porque depende de los rodamientos de cada motor.
let servicioCambioId = null;

async function obtenerServicioCambio() {
  if (servicioCambioId) return servicioCambioId;

  const existentes = await odooEjecutar(
    'product.product',
    'search_read',
    [[['name', '=', NOMBRE_SERVICIO_CAMBIO]]],
    { fields: ['id'], limit: 1 }
  );

  if (existentes.length > 0) {
    servicioCambioId = existentes[0].id;
    return servicioCambioId;
  }

  const datos = {
    name: NOMBRE_SERVICIO_CAMBIO,
    type: 'service',
    list_price: 0,
    sale_ok: true,
    purchase_ok: false,
    description_sale:
      'Desmontaje de tapas, extracción de los rodamientos dañados, limpieza de ' +
      'alojamientos y flecha, montaje de rodamientos nuevos en lado acoplamiento ' +
      'y lado opuesto, engrasado y pruebas de giro.',
  };

  const uom = await obtenerUomServicio();
  if (uom) datos.uom_id = uom;

  try {
    servicioCambioId = await odooEjecutar('product.product', 'create', [datos]);
  } catch (err) {
    console.error('No se pudo crear con unidad de medida:', err.message);
    delete datos.uom_id;
    servicioCambioId = await odooEjecutar('product.product', 'create', [datos]);
  }

  console.log(`Odoo: servicio de cambio de rodamientos creado -> id ${servicioCambioId}`);
  await enviarTelegram(
    `🆕 Se dio de alta el servicio en Odoo:\n\n${NOMBRE_SERVICIO_CAMBIO}\n\nEl precio se calcula por cotización, según los rodamientos.`
  );

  return servicioCambioId;
}

// Calcula el precio del servicio de cambio a partir del valor de los rodamientos
async function cotizarCambioRodamientos(input) {
  await odooAutenticar();

  const total = Number(input?.precio_rodamientos);
  if (!isFinite(total) || total <= 0) {
    return { error: 'Necesito el precio total de los dos rodamientos para calcular el servicio.' };
  }

  const precio = Math.round(total * PORCENTAJE_CAMBIO_RODAMIENTOS * 100) / 100;
  const id = await obtenerServicioCambio();

  console.log(`Servicio de cambio: ${total} x ${PORCENTAJE_CAMBIO_RODAMIENTOS} = ${precio}`);

  return {
    producto_id: id,
    nombre: NOMBRE_SERVICIO_CAMBIO,
    precio_unitario: precio,
    base: `${(PORCENTAJE_CAMBIO_RODAMIENTOS * 100).toFixed(0)}% de $${total} de rodamientos`,
    nota:
      'Al agregar este servicio a crear_cotizacion, manda también el precio_unitario ' +
      'que te di aquí, porque el producto no trae precio fijo.',
  };
}

// ===== CLIENTES Y COTIZACIONES EN ODOO =====

// Busca al cliente en Odoo por su número de WhatsApp. Si no lo encuentra,
// lo da de alta como contacto nuevo.
async function buscarOCrearCliente(numeroWhatsApp, nombreCliente) {
  const referencia = `WA-${numeroWhatsApp}`;
  const soloDigitos = String(numeroWhatsApp).replace(/\D/g, '');
  const ultimos10 = soloDigitos.slice(-10);

  // 1) ¿Ya lo creó el bot antes? (lo marcamos con la referencia WA-numero)
  const porReferencia = await odooEjecutar(
    'res.partner',
    'search_read',
    [[['ref', '=', referencia]]],
    { fields: ['id', 'name'], limit: 1 }
  );
  if (porReferencia.length > 0) {
    console.log(`Odoo: cliente encontrado por referencia -> ${porReferencia[0].name}`);
    return porReferencia[0].id;
  }

  // 2) ¿Existe ya como cliente tuyo, con ese teléfono registrado?
  // Ojo: en Odoo 19 ya no existe el campo "mobile", todo va en "phone".
  const porTelefono = await odooEjecutar(
    'res.partner',
    'search_read',
    [[['phone', 'ilike', ultimos10]]],
    { fields: ['id', 'name'], limit: 1 }
  );
  if (porTelefono.length > 0) {
    console.log(`Odoo: cliente encontrado por teléfono -> ${porTelefono[0].name}`);
    return porTelefono[0].id;
  }

  // 3) No existe: lo damos de alta
  const nuevoId = await odooEjecutar('res.partner', 'create', [
    {
      name: nombreCliente || `Cliente WhatsApp ${ultimos10}`,
      phone: `+${soloDigitos}`,
      ref: referencia,
      comment: 'Contacto creado automáticamente por el bot de WhatsApp de CAAF.',
    },
  ]);
  console.log(`Odoo: cliente NUEVO creado -> id ${nuevoId} (${nombreCliente})`);
  return nuevoId;
}

// Todas las cotizaciones del bot se asignan a un equipo de ventas aparte,
// para poder filtrarlas y medirlas por separado en Odoo.
const NOMBRE_EQUIPO_BOT = 'Bot WhatsApp';
let equipoBotId = null;

async function obtenerEquipoBot() {
  if (equipoBotId) return equipoBotId;

  try {
    const equipos = await odooEjecutar(
      'crm.team',
      'search_read',
      [[['name', '=', NOMBRE_EQUIPO_BOT]]],
      { fields: ['id'], limit: 1 }
    );

    if (equipos.length > 0) {
      equipoBotId = equipos[0].id;
    } else {
      equipoBotId = await odooEjecutar('crm.team', 'create', [{ name: NOMBRE_EQUIPO_BOT }]);
      console.log(`Odoo: equipo de ventas "${NOMBRE_EQUIPO_BOT}" creado -> id ${equipoBotId}`);
    }
  } catch (err) {
    // Si algo falla con el equipo, la cotización se crea igual, sin equipo.
    console.error('No se pudo obtener el equipo de ventas del bot:', err.message);
    return null;
  }

  return equipoBotId;
}

// Crea un presupuesto real en Odoo y le manda el PDF al cliente por WhatsApp.
async function crearCotizacionOdoo(numeroCliente, nombreCliente, input) {
  await odooAutenticar();

  const productos = Array.isArray(input?.productos) ? input.productos : [];
  if (productos.length === 0) {
    return { error: 'No se recibió ningún producto para cotizar.' };
  }

  // Candado: los ids tienen que ser números reales de Odoo. Si Claude manda
  // un id vacío o inventado, Odoo truena con "Invalid falsy real id".
  const idsInvalidos = productos.filter(
    (p) => !Number.isInteger(Number(p.product_id)) || Number(p.product_id) <= 0
  );

  if (idsInvalidos.length > 0) {
    console.log('Cotización BLOQUEADA, ids inválidos:', JSON.stringify(idsInvalidos));
    return {
      error: 'ID_DE_PRODUCTO_INVALIDO',
      nota:
        'Uno o más productos no traen un product_id válido de Odoo. NO puedes inventar el id: ' +
        'tiene que ser el número que viene en el campo "id" de lo que regresa buscar_producto, ' +
        'estimar_rodamientos o cotizar_rebobinado. Vuelve a buscar el producto para obtener su id ' +
        'y llama otra vez a crear_cotizacion. NO uses avisar_a_humano por esto.',
    };
  }

  // Candado de seguridad: nunca cotizar algo con precio de $0 o $1. Casi
  // siempre significa que el precio no se ha capturado bien en Odoo.
  const idsProductos = productos.map((p) => Number(p.product_id));
  const datosProductos = await odooEjecutar('product.product', 'read', [
    idsProductos,
    ['name', 'list_price'],
  ]);
  const sinPrecio = datosProductos.filter(
    (p) => Number(p.list_price) <= 1 && p.id !== servicioCambioId
  );

  if (sinPrecio.length > 0) {
    const nombres = sinPrecio.map((p) => p.name).join(', ');
    console.log(`Cotización BLOQUEADA, precio no configurado: ${nombres}`);
    return {
      error: 'PRECIO_NO_CONFIGURADO',
      productos_afectados: sinPrecio.map((p) => p.name),
      nota: 'Estos productos no tienen un precio válido en el catálogo. NO cotices y NO inventes ninguna cifra. Dile al cliente que un asesor le confirma el precio en un momento, y usa avisar_a_humano.',
    };
  }

  const partnerId = await buscarOCrearCliente(
    numeroCliente,
    input.nombre_cliente || nombreCliente
  );

  // Armamos las líneas del presupuesto. Odoo pone el precio solo,
  // según la tarifa configurada.
  // El servicio de cambio de rodamientos no trae precio fijo: se calcula
  // según los rodamientos del motor, así que su precio viene en la línea.
  const idServicioCambio = servicioCambioId;

  const lineas = productos.map((p) => {
    const linea = {
      product_id: Number(p.product_id),
      product_uom_qty: Number(p.cantidad) > 0 ? Number(p.cantidad) : 1,
    };

    const precio = Number(p.precio_unitario);
    if (isFinite(precio) && precio > 0 && Number(p.product_id) === idServicioCambio) {
      linea.price_unit = precio;
    }

    return [0, 0, linea];
  });

  const equipoId = await obtenerEquipoBot();

  const datosOrden = {
    partner_id: partnerId,
    origin: `Bot WhatsApp — ${numeroCliente}`,
    order_line: lineas,
  };
  if (equipoId) datosOrden.team_id = equipoId;

  // La Referencia del cliente es para SU número de orden de compra.
  // Es el documento que justifica el trabajo y contra el que después se
  // descuenta el material consumido.
  if (input?.orden_compra) {
    datosOrden.client_order_ref = String(input.orden_compra).slice(0, 100);
  }

  // El área y las notas del equipo van juntas en las notas del pedido.
  const notas = [];
  if (input?.area) notas.push(`Área / solicita: ${input.area}`);
  if (input?.notas) notas.push(String(input.notas));
  if (notas.length > 0) datosOrden.note = notas.join('\n');

  // Si algún campo extra no existiera en esta versión de Odoo, creamos el
  // presupuesto de todos modos con lo indispensable.
  let ordenId;
  try {
    ordenId = await odooEjecutar('sale.order', 'create', [datosOrden]);
  } catch (err) {
    console.error('No se pudo crear con todos los campos, reintentando simple:', err.message);
    const minimo = { partner_id: partnerId, order_line: lineas };
    if (input?.orden_compra) {
      minimo.client_order_ref = String(input.orden_compra).slice(0, 100);
    }
    if (notas.length > 0) minimo.note = notas.join('\n');
    ordenId = await odooEjecutar('sale.order', 'create', [minimo]);
  }

  const [orden] = await odooEjecutar('sale.order', 'read', [
    [ordenId],
    ['name', 'amount_total', 'access_token'],
  ]);

  // El access_token es lo que deja que el cliente vea el PDF sin
  // tener usuario en Odoo. Si viene vacío, generamos uno.
  let token = orden.access_token;
  if (!token) {
    token = crypto.randomBytes(16).toString('hex');
    await odooEjecutar('sale.order', 'write', [[ordenId], { access_token: token }]);
  }

  const linkPortal = `${ODOO_URL}/my/orders/${ordenId}?access_token=${token}`;
  const linkPdf = `${linkPortal}&report_type=pdf&download=true`;

  console.log(`Odoo: cotización creada -> ${orden.name} (total ${orden.amount_total})`);

  // Intentamos mandarle el PDF adjunto. Si WhatsApp no lo puede jalar,
  // le mandamos el link para que la vea en el navegador.
  const pdfEnviado = await enviarDocumentoWhatsApp(
    numeroCliente,
    linkPdf,
    `Cotizacion-${orden.name}.pdf`,
    `Cotización ${orden.name} — CAAF Oil Services Implements`
  );

  if (!pdfEnviado) {
    await enviarMensajeWhatsApp(
      numeroCliente,
      `Aquí puedes ver y descargar tu cotización ${orden.name}:\n${linkPortal}`
    );
  }

  // Si el cliente pidió que se la mandaran por correo
  let correo = null;
  if (input?.correo) {
    correo = await enviarCotizacionPorCorreo({
      ordenId,
      folio: orden.name,
      linkPdf,
      correo: input.correo,
      nombreCliente: input.nombre_cliente || nombreCliente,
      partnerId,
    });
  }

  return {
    folio: orden.name,
    total: orden.amount_total,
    pdf_enviado: pdfEnviado,
    correo: correo || undefined,
    nota: pdfEnviado
      ? 'El PDF de la cotización YA se le mandó al cliente por WhatsApp. No repitas el link, solo confirma el folio y el total.'
      : 'No se pudo mandar el PDF, pero ya se le mandó el link al cliente. Solo confirma el folio y el total.',
  };
}

// ===== FOTOS QUE MANDA EL CLIENTE =====

const TIPOS_DE_IMAGEN = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const TAMANO_MAXIMO_IMAGEN = 4 * 1024 * 1024; // 4 MB

// Baja una foto que mandó el cliente por WhatsApp y la deja lista para
// que Claude la pueda ver.
async function descargarImagenWhatsApp(idMedia) {
  try {
    // Paso 1: Meta nos da una URL temporal para el archivo
    const infoResp = await fetch(`https://graph.facebook.com/v21.0/${idMedia}`, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    });
    const info = await infoResp.json();

    if (!info.url) {
      console.error('No pude obtener la URL de la imagen:', JSON.stringify(info));
      return null;
    }

    // Paso 2: descargamos el archivo (también requiere el token)
    const archivoResp = await fetch(info.url, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    });
    const buffer = Buffer.from(await archivoResp.arrayBuffer());

    console.log(`Imagen descargada: ${(buffer.length / 1024).toFixed(0)} KB, ${info.mime_type}`);

    if (buffer.length > TAMANO_MAXIMO_IMAGEN) {
      return { error: 'DEMASIADO_GRANDE' };
    }

    let tipo = String(info.mime_type || 'image/jpeg').split(';')[0].trim();
    if (!TIPOS_DE_IMAGEN.includes(tipo)) tipo = 'image/jpeg';

    return { base64: buffer.toString('base64'), tipo };
  } catch (err) {
    console.error('Falló la descarga de la imagen:', err);
    return null;
  }
}

// ===== AVISOS Y ATENCIÓN HUMANA POR TELEGRAM =====

// Relaciona cada mensaje que mandamos a Telegram con el número de WhatsApp
// del cliente, para saber a quién contestarle cuando respondas ese mensaje.
const MAX_MENSAJES_TELEGRAM = 2000;

// Todo esto vive en el disco, así que sobrevive a los reinicios.
const mensajesTelegram = {
  get: (id) => datos.telegram[String(id)],
  has: (id) => datos.telegram[String(id)] !== undefined,
};

// Clientes que en este momento atiende una persona. Mientras esté aquí,
// el bot NO contesta y solo te reenvía lo que escriba el cliente.
const modoHumano = {
  get: (numero) => datos.modoHumano[numero] !== undefined,
  set: (numero) => {
    datos.modoHumano[numero] = Date.now();
    guardarDatos();
  },
  delete: (numero) => {
    delete datos.modoHumano[numero];
    guardarDatos();
  },
};

function recordarMensajeTelegram(idMensaje, numeroCliente) {
  datos.telegram[String(idMensaje)] = numeroCliente;

  const ids = Object.keys(datos.telegram);
  while (ids.length > MAX_MENSAJES_TELEGRAM) {
    delete datos.telegram[ids.shift()];
  }

  guardarDatos();
}

// Manda un mensaje a Telegram. Regresa el id del mensaje, o null si falló.
async function enviarTelegram(texto, chatId = TELEGRAM_CHAT_ID) {
  if (!TELEGRAM_TOKEN) {
    console.error('Telegram no configurado: falta TELEGRAM_TOKEN');
    return null;
  }
  if (!chatId) {
    console.error('Telegram no configurado: falta TELEGRAM_CHAT_ID');
    return null;
  }

  try {
    const respuesta = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: texto }),
      }
    );
    const datos = await respuesta.json();

    if (!datos.ok) {
      console.error('Error de Telegram:', datos.description);
      return null;
    }
    return datos.result.message_id;
  } catch (err) {
    console.error('Falló el envío a Telegram:', err);
    return null;
  }
}

// Manda un aviso a Telegram y lo deja ligado al cliente, para que puedas
// responderle nada más contestando ese mensaje.
async function avisarPorTelegram(numeroCliente, texto) {
  const idMensaje = await enviarTelegram(texto);
  if (idMensaje) recordarMensajeTelegram(idMensaje, numeroCliente);
  return idMensaje;
}

// Lo que se ejecuta cuando Claude decide que hay que llamar a una persona.
async function avisarAHumano(numeroCliente, nombreCliente, input) {
  const motivo = input?.motivo || 'No especificado';
  const resumen = input?.resumen || '(sin resumen)';

  const texto =
    `🔔 UN CLIENTE NECESITA AYUDA\n\n` +
    `Cliente: ${nombreCliente}\n` +
    `Número: ${numeroCliente}\n` +
    `Motivo: ${motivo}\n\n` +
    `${resumen}\n\n` +
    `———\n` +
    `Responde a ESTE mensaje y le llega directo al cliente por WhatsApp.\n` +
    `El bot queda en pausa con él. Para devolverle el control, responde /bot`;

  const idMensaje = await avisarPorTelegram(numeroCliente, texto);

  // Aunque falle el aviso, dejamos al cliente en manos humanas: es peor
  // que el bot siga solo con un tema que ya se le salió de las manos.
  modoHumano.set(numeroCliente);
  console.log(`Modo humano ACTIVADO para ${numeroCliente} (motivo: ${motivo})`);

  return {
    avisado: idMensaje !== null,
    nota:
      idMensaje !== null
        ? 'Ya se le avisó a un asesor. Dile al cliente que en un momento lo atiende una persona, y despídete amablemente. No sigas atendiendo el tema.'
        : 'No se pudo avisar al asesor. Pídele al cliente que llame directo al taller.',
  };
}

// ===== ORDEN DE COMPRA QUE LLEGA DESPUÉS =====

// En empresas grandes el motor llega primero y la OC sale días después.
// Esto permite anotarla en un pedido que ya existe.
async function registrarOrdenCompra(folio, numeroOC) {
  await odooAutenticar();

  const limpio = String(folio || '').trim().toUpperCase();
  if (!limpio) return { error: 'Falta el folio de la cotización.' };
  if (!numeroOC) return { error: 'Falta el número de orden de compra.' };

  const ordenes = await odooEjecutar(
    'sale.order',
    'search_read',
    [[['name', '=', limpio]]],
    { fields: ['id', 'name', 'partner_id', 'client_order_ref', 'amount_total', 'state'], limit: 1 }
  );

  if (ordenes.length === 0) {
    return { error: `No encontré la cotización ${limpio} en Odoo.` };
  }

  const orden = ordenes[0];
  const anterior = orden.client_order_ref;

  await odooEjecutar('sale.order', 'write', [
    [orden.id],
    { client_order_ref: String(numeroOC).slice(0, 100) },
  ]);

  console.log(`OC ${numeroOC} anotada en ${orden.name}`);

  return {
    folio: orden.name,
    cliente: orden.partner_id ? orden.partner_id[1] : '',
    total: orden.amount_total,
    orden_compra: String(numeroOC),
    reemplazo: anterior || null,
  };
}

// ===== ENVÍO DE COTIZACIONES POR CORREO =====

// Descarga el PDF del portal de Odoo y lo manda por correo como adjunto,
// usando el mismo servidor de salida que ya usas en Odoo.
async function enviarCotizacionPorCorreo(datos) {
  const { ordenId, folio, linkPdf, correo, nombreCliente, partnerId } = datos;

  if (!correo || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) {
    return { enviado: false, error: 'El correo no parece válido.' };
  }

  try {
    // 1. Bajamos el PDF del portal
    const resp = await fetch(linkPdf);
    if (!resp.ok) throw new Error(`El portal respondió ${resp.status}`);

    const buffer = Buffer.from(await resp.arrayBuffer());
    console.log(`PDF de ${folio} descargado: ${(buffer.length / 1024).toFixed(0)} KB`);

    // 2. Lo subimos a Odoo como adjunto de la cotización
    const adjuntoId = await odooEjecutar('ir.attachment', 'create', [
      {
        name: `Cotizacion-${folio}.pdf`,
        datas: buffer.toString('base64'),
        mimetype: 'application/pdf',
        res_model: 'sale.order',
        res_id: ordenId,
      },
    ]);

    // 3. Armamos y mandamos el correo
    const cuerpo =
      `<p>Buen día${nombreCliente ? ' ' + nombreCliente : ''},</p>` +
      `<p>Adjunto encontrará la cotización <strong>${folio}</strong> solicitada.</p>` +
      `<p>Quedamos atentos a cualquier duda o aclaración.</p>` +
      `<p>Saludos cordiales,<br/>` +
      `<strong>CAAF Oil Services Implements</strong><br/>` +
      `Villahermosa, Tabasco<br/>` +
      `Tel. 9931492915</p>`;

    const correoId = await odooEjecutar('mail.mail', 'create', [
      {
        subject: `Cotización ${folio} - CAAF Oil Services`,
        body_html: cuerpo,
        email_to: correo,
        attachment_ids: [[6, 0, [adjuntoId]]],
        auto_delete: false,
      },
    ]);

    await odooEjecutar('mail.mail', 'send', [[correoId]]);

    console.log(`Cotización ${folio} enviada por correo a ${correo}`);

    // 4. Si el contacto no tenía correo, se lo guardamos para la próxima
    if (partnerId) {
      try {
        const [contacto] = await odooEjecutar('res.partner', 'read', [[partnerId], ['email']]);
        if (!contacto.email) {
          await odooEjecutar('res.partner', 'write', [[partnerId], { email: correo }]);
          console.log(`Correo guardado en el contacto ${partnerId}`);
        }
      } catch (err) {
        console.error('No se pudo guardar el correo en el contacto:', err.message);
      }
    }

    return { enviado: true, correo };
  } catch (err) {
    console.error('Falló el envío por correo:', err.message);
    return { enviado: false, error: err.message };
  }
}

// ===== MEMORIA DE CONVERSACIÓN =====
const MAX_MENSAJES_GUARDADOS = 20;

function obtenerHistorial(numeroCliente) {
  if (!datos.conversaciones[numeroCliente]) {
    datos.conversaciones[numeroCliente] = { mensajes: [], actualizado: Date.now() };
  }
  return datos.conversaciones[numeroCliente].mensajes;
}

function agregarAlHistorial(numeroCliente, role, content) {
  const conv = datos.conversaciones[numeroCliente] || { mensajes: [], actualizado: 0 };

  conv.mensajes.push({ role, content });
  while (conv.mensajes.length > MAX_MENSAJES_GUARDADOS) {
    conv.mensajes.shift();
  }
  conv.actualizado = Date.now();

  datos.conversaciones[numeroCliente] = conv;
  guardarDatos();
}

// Página de salud
app.get('/', (req, res) => {
  res.send('Servidor de CAAF OIL Services funcionando correctamente');
});

// Webhook de Telegram: aquí llega lo que TÚ escribes en Telegram
app.post('/telegram', async (req, res) => {
  res.sendStatus(200);

  try {
    const mensaje = req.body?.message;
    if (!mensaje) return;

    const chatId = mensaje.chat?.id;
    const texto = (mensaje.text || '').trim();
    console.log(`Telegram: chat id ${chatId} | texto: ${texto}`);

    // Comando para conocer tu chat id la primera vez
    if (texto === '/start' || texto === '/id') {
      await enviarTelegram(
        `Tu chat id es: ${chatId}\n\n` +
          `Guárdalo en Render como la variable TELEGRAM_CHAT_ID.`,
        chatId
      );
      return;
    }

    // ¿Estás respondiendo a un aviso de un cliente?
    const idRespondido = mensaje.reply_to_message?.message_id;
    const numeroCliente = idRespondido
      ? mensajesTelegram.get(String(idRespondido))
      : null;

    // /oc S00360 4500123456  -> anota la orden de compra del cliente
    if (/^\/oc\b/i.test(texto)) {
      const partes = texto.split(/\s+/);
      if (partes.length < 3) {
        await enviarTelegram(
          'Para anotar una orden de compra:\n\n/oc FOLIO NUMERO\n\nEjemplo:\n/oc S00360 4500123456',
          chatId
        );
        return;
      }

      const resultado = await registrarOrdenCompra(partes[1], partes.slice(2).join(' '));

      if (resultado.error) {
        await enviarTelegram(`❌ ${resultado.error}`, chatId);
      } else {
        await enviarTelegram(
          `✅ OC anotada en ${resultado.folio}\n\n` +
            `Cliente: ${resultado.cliente}\n` +
            `OC: ${resultado.orden_compra}\n` +
            `Total: $${Number(resultado.total).toLocaleString('es-MX')}` +
            (resultado.reemplazo ? `\n\n(Reemplazó a: ${resultado.reemplazo})` : ''),
          chatId
        );
      }
      return;
    }

    if (!numeroCliente) {
      // /bot 5219933753729 -> devuelve el control del bot a ese cliente
      const partes = texto.split(/\s+/);
      if (partes[0] === '/bot' && partes[1]) {
        const numero = partes[1].replace(/\D/g, '');
        modoHumano.delete(numero);
        await enviarTelegram(`✅ El bot vuelve a atender a ${numero}`, chatId);
        return;
      }

      await enviarTelegram(
        'Para contestarle a un cliente, responde directamente al mensaje de aviso que te mandé.\n\n' +
          'Comandos:\n' +
          '/bot NUMERO — le devuelve el control al bot\n' +
          '/oc FOLIO NUMERO — anota la orden de compra del cliente',
        chatId
      );
      return;
    }

    // Devolverle el control al bot con este cliente
    if (texto === '/bot') {
      modoHumano.delete(numeroCliente);
      console.log(`Modo humano DESACTIVADO para ${numeroCliente}`);
      await enviarTelegram(`✅ El bot vuelve a atender a ${numeroCliente}`, chatId);
      return;
    }

    if (!texto) {
      await enviarTelegram('Por ahora solo puedo reenviar texto al cliente.', chatId);
      return;
    }

    // Le mandamos tu respuesta al cliente y la guardamos en el historial,
    // para que el bot sepa qué se habló si retoma la conversación.
    await enviarMensajeWhatsApp(numeroCliente, texto);
    agregarAlHistorial(numeroCliente, 'assistant', texto);
    modoHumano.set(numeroCliente);

    await enviarTelegram(`✅ Enviado a ${numeroCliente}`, chatId);
  } catch (error) {
    console.error('Error procesando mensaje de Telegram:', error);
  }
});

// 1) Verificación del webhook
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verificado correctamente por Meta.');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// 2) Recepción de mensajes entrantes
app.post('/webhook', async (req, res) => {
  console.log('Mensaje recibido:', JSON.stringify(req.body, null, 2));
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message) return;

    const numeroCliente = message.from;
    const nombreCliente = value.contacts?.[0]?.profile?.name || 'Cliente';

    // CANDADO 1: WhatsApp a veces entrega el mismo mensaje dos veces.
    // Si ya lo atendimos, lo ignoramos.
    if (message.id) {
      if (datos.procesados[message.id]) {
        console.log(`Mensaje repetido ${message.id}, se ignora`);
        return;
      }
      datos.procesados[message.id] = Date.now();
      guardarDatos();
    }

    // CANDADO 2: si ya estamos atendiendo un mensaje de este cliente,
    // esperamos a terminar antes de agarrar el siguiente. Si no, se
    // pisan entre ellos y el bot contesta dos veces cosas distintas.
    if (atendiendo.has(numeroCliente)) {
      console.log(`Ya se está atendiendo a ${numeroCliente}, se encola`);
      await atendiendo.get(numeroCliente).catch(() => {});
    }

    let terminar;
    atendiendo.set(numeroCliente, new Promise((r) => { terminar = r; }));

    try {
      await procesarMensaje({ message, value, numeroCliente, nombreCliente });
    } finally {
      terminar();
      atendiendo.delete(numeroCliente);
    }
  } catch (error) {
    console.error('Error procesando el mensaje:', error);
  }
});

// Clientes que se están atendiendo en este momento
const atendiendo = new Map();

async function procesarMensaje({ message, value, numeroCliente, nombreCliente }) {
  try {

    // Armamos lo que le vamos a pasar a Claude. Puede ser texto suelto,
    // o una foto acompañada de texto.
    let contenidoCliente = null;
    let resumenTexto = '';

    if (message.type === 'text') {
      contenidoCliente = message.text.body;
      resumenTexto = message.text.body;

    } else if (message.type === 'image') {
      const pieDeFoto = message.image?.caption || '';
      const imagen = await descargarImagenWhatsApp(message.image?.id);

      if (!imagen) {
        await enviarMensajeWhatsApp(
          numeroCliente,
          'No pude abrir la foto 😕 ¿Me la puedes volver a mandar?'
        );
        return;
      }

      if (imagen.error === 'DEMASIADO_GRANDE') {
        await enviarMensajeWhatsApp(
          numeroCliente,
          'La foto pesa demasiado y no la puedo abrir. Mándamela con menos calidad, o escríbeme los datos de la placa.'
        );
        return;
      }

      contenidoCliente = [
        {
          type: 'image',
          source: { type: 'base64', media_type: imagen.tipo, data: imagen.base64 },
        },
        {
          type: 'text',
          text: pieDeFoto || 'Te mando esta foto.',
        },
      ];
      resumenTexto = pieDeFoto ? `[FOTO] ${pieDeFoto}` : '[FOTO sin texto]';

    } else {
      await enviarMensajeWhatsApp(
        numeroCliente,
        'Por ahora puedo leer texto y fotos. Si me mandas la foto de la placa del motor, con eso te cotizo.'
      );
      return;
    }

    console.log(`Mensaje de ${nombreCliente} (${numeroCliente}): ${resumenTexto}`);

    agregarAlHistorial(numeroCliente, 'user', contenidoCliente);

    // Si una persona ya está atendiendo a este cliente, el bot se calla
    // y solo te reenvía el mensaje a Telegram.
    if (modoHumano.get(numeroCliente)) {
      console.log(`Modo humano activo con ${numeroCliente}, reenviando a Telegram`);
      await avisarPorTelegram(
        numeroCliente,
        `💬 ${nombreCliente} (${numeroCliente}) escribió:\n\n` +
          `${resumenTexto}\n\n` +
          `———\n` +
          `Responde a este mensaje para contestarle. /bot para devolverle el control al bot.`
      );
      return;
    }

    const respuestaClaude = await preguntarleAClaude(numeroCliente, nombreCliente);

    agregarAlHistorial(numeroCliente, 'assistant', respuestaClaude);

    await enviarMensajeWhatsApp(numeroCliente, respuestaClaude);

  } catch (error) {
    console.error('Error atendiendo el mensaje:', error);
  }
}

// Herramientas que Claude puede usar
const herramientas = [
  {
    name: 'buscar_producto',
    description: `Busca productos en el catálogo real de Odoo de CAAF Oil Services.
Regresa id, nombre, referencia interna, precio de venta y existencia disponible.

MUY IMPORTANTE sobre el parámetro "query": manda ÚNICAMENTE el código,
modelo o número de parte de la pieza, tal como aparecería en una etiqueta.
NO incluyas palabras como "rodamiento", "balero", "motor", "precio",
"tienes" o "necesito", porque en el catálogo los productos están dados de
alta solo con su código.

Ejemplos correctos: "6205-2RS-C3", "61809", "6205", "61824-2Z-Y".
Ejemplos INCORRECTOS: "rodamiento 6205", "tienes el balero 6205",
"precio de rodamiento 6205-2RS-C3 TIMKEN".

Si el cliente no da un código sino una descripción (ej. "motor de 10 HP"),
manda las palabras clave técnicas solas, sin muletillas.`,
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Código o modelo de la pieza, sin palabras genéricas. Ej: "6205-2RS-C3"',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'crear_cotizacion',
    description: `Crea una cotización formal (presupuesto) en Odoo con el membrete de
CAAF y le manda el PDF al cliente por WhatsApp automáticamente.

ÚSALA SOLO cuando se cumplan TODAS estas condiciones:
1. Ya buscaste el producto con buscar_producto y sabes exactamente cuál es.
2. El cliente ya te dijo cuántas piezas quiere.
3. El cliente ya confirmó que sí quiere la cotización formal.

NUNCA la uses solo para "ver el precio" ni de forma preventiva: cada llamada
crea un documento real en el sistema de la empresa.

El "product_id" es el campo "id" que te regresó buscar_producto. Es un número
entero de Odoo, como 14169. NUNCA lo inventes ni uses el código del producto
(6307-2RSR-L038-C3 NO es un id). Si no lo tienes, vuelve a buscar el producto
para obtenerlo.`,
    input_schema: {
      type: 'object',
      properties: {
        productos: {
          type: 'array',
          description: 'Los productos a cotizar, con su id de Odoo y la cantidad',
          items: {
            type: 'object',
            properties: {
              product_id: {
                type: 'integer',
                description: 'El campo "id" que regresó buscar_producto',
              },
              cantidad: {
                type: 'number',
                description: 'Cuántas piezas pidió el cliente',
              },
              precio_unitario: {
                type: 'number',
                description: 'Solo para el SERVICIO DE CAMBIO DE RODAMIENTOS: el precio que te dio la herramienta cotizar_cambio_rodamientos. Para los demás productos NO lo mandes, el precio sale del catálogo.',
              },
            },
            required: ['product_id', 'cantidad'],
          },
        },
        nombre_cliente: {
          type: 'string',
          description: 'Nombre o razón social, si el cliente lo dio en la conversación',
        },
        correo: {
          type: 'string',
          description: 'Correo al que hay que mandar la cotización, SOLO si el cliente lo pidió y te lo dio. Si no lo pidió, no lo mandes.',
        },
        area: {
          type: 'string',
          description: 'Área, planta o departamento de donde viene el equipo, y el nombre de quien lo solicita. OBLIGATORIO en clientes grandes como Coca-Cola, donde todas las plantas facturan a la misma razón social. Ej: "Planta Villahermosa - Mantenimiento - Juan Pérez"',
        },
        orden_compra: {
          type: 'string',
          description: 'Número de orden de compra (OC) del cliente, si ya lo tiene. Es el documento con el que autoriza el trabajo. Si todavía no lo tiene, no lo mandes: se puede agregar después.',
        },
        notas: {
          type: 'string',
          description: 'Datos del equipo que convenga dejar por escrito: marca, modelo, serie, número de inventario, o lo que el cliente haya especificado.',
        },
      },
      required: ['productos'],
    },
  },
  {
    name: 'estimar_rodamientos',
    description: `Estima qué rodamientos lleva un motor eléctrico cuando el cliente
NO tiene la placa o la placa no dice el número de rodamiento. Regresa los dos
rodamientos (L.A. y L.O.) con su precio real del catálogo.

ÚSALA cuando el cliente quiera cotizar cambio de rodamientos de un motor pero
no sepa qué números lleva.

Necesitas los HP del motor. Las rpm son muy importantes también: a 3600 rpm el
rodamiento tiene que llevar juego C3 o C4. Si el cliente no te dice las rpm,
pregúntaselas antes de estimar; si no las sabe, dile que revise la placa o que
un asesor lo confirme.

Solo funciona hasta 50 HP. Arriba de eso no hay datos y hay que pasarlo con
un asesor.

Lo que regresa es una ESTIMACIÓN: el rodamiento definitivo se sabe al abrir
el motor. Siempre díselo así al cliente.`,
    input_schema: {
      type: 'object',
      properties: {
        hp: {
          type: 'number',
          description: 'Potencia del motor en HP (caballos). Ej: 10, 7.5, 25',
        },
        rpm: {
          type: 'number',
          description: 'Velocidad del motor en rpm (1800, 3600, 1200...). Si no la sabes, no la mandes.',
        },
      },
      required: ['hp'],
    },
  },
  {
    name: 'cotizar_rebobinado',
    description: `Cotiza el rebobinado (embobinado) de un motor eléctrico usando el
catálogo de precios del taller. Regresa el precio del servicio ya listo para
cotizar, con su producto de Odoo.

NECESITAS TRES DATOS antes de llamarla: la capacidad (HP o kW), las rpm y el
voltaje. Pídeselos al cliente en un solo mensaje, no de uno en uno.

Las rpm son obligatorias porque de ahí sale el número de polos, y el precio
cambia según eso. El voltaje no cambia el precio pero se necesita para el
trabajo, así que también hay que pedirlo.

Funciona de 1/2 HP hasta 100 HP. Arriba de eso, pásalo con un asesor.

Al rebobinado SIEMPRE hay que sumarle pintura y limpieza mecánica. La
herramienta te regresa las opciones que hay en catálogo para que las agregues.

También hay que saber si el motor llega COMPLETO: con su guarda (tapa
deflectora), su ventilador o veleta, y su caja de conexiones. Lo que le falte
hay que cotizarlo aparte, porque se tiene que comprar o fabricar.`,
    input_schema: {
      type: 'object',
      properties: {
        hp: { type: 'number', description: 'Capacidad del motor en HP. Ej: 10, 7.5, 25' },
        kw: { type: 'number', description: 'Capacidad en kW, si el cliente la dio así en vez de HP' },
        rpm: { type: 'number', description: 'Velocidad de placa del motor. Ej: 1750, 3550, 1180' },
        voltaje: { type: 'string', description: 'Voltaje del motor, tal como lo dijo el cliente. Ej: "220/440", "440"' },
        tiene_guarda: {
          type: 'boolean',
          description: 'true si el motor trae su guarda (tapa deflectora), false si le falta. No lo mandes si el cliente aún no te lo ha dicho.',
        },
        tiene_ventilador: {
          type: 'boolean',
          description: 'true si el motor trae su ventilador o veleta, false si le falta. No lo mandes si aún no lo sabes.',
        },
        tiene_caja_conexiones: {
          type: 'boolean',
          description: 'true si el motor trae su caja de conexiones, false si le falta. No lo mandes si aún no lo sabes.',
        },
      },
      required: ['rpm'],
    },
  },
  {
    name: 'cotizar_cambio_rodamientos',
    description: `Calcula el precio del SERVICIO de cambio de rodamientos (la mano de
obra de desmontar y montar), que se cobra como un porcentaje del valor de los
rodamientos.

ÚSALA siempre que cotices rodamientos para un motor, ya sea que los hayas
sacado de la placa o estimado por HP.

Mándale la SUMA del precio de los dos rodamientos (L.A. + L.O.), ya
multiplicada por las cantidades. Te regresa el producto de servicio y el
precio que le corresponde.

Ese precio lo tienes que pasar como "precio_unitario" cuando agregues este
servicio a crear_cotizacion.`,
    input_schema: {
      type: 'object',
      properties: {
        precio_rodamientos: {
          type: 'number',
          description: 'Suma del precio de los dos rodamientos. Ej: si el L.A. cuesta 1500 y el L.O. 700, manda 2200',
        },
      },
      required: ['precio_rodamientos'],
    },
  },
  {
    name: 'cotizar_contrato',
    description: `Cotiza un motor para clientes CON CONTRATO (Coca-Cola, FEMSA,
Embotelladora Mexicana de Bebidas Refrescantes), usando su lista de precios
propia. NO uses cotizar_rebobinado con estos clientes.

Antes de llamarla necesitas dos cosas:
  1. La capacidad del motor en HP.
  2. Si el trabajo es URGENTE o no. Urgente se cotiza EXT, normal se cotiza
     STD, y hay 20% de diferencia. Pregúntaselo siempre.

El paquete base que arma incluye: embobinado, cambio de rodamientos, limpieza
y pintura de estructura, y ajuste de tapas.

Además pregúntale si el motor trae guarda, caja de conexiones y ventilador, y
si la flecha necesita reparación. Lo que falte o esté dañado se agrega.`,
    input_schema: {
      type: 'object',
      properties: {
        hp: { type: 'number', description: 'Capacidad del motor en HP' },
        urgente: {
          type: 'boolean',
          description: 'true si el cliente lo necesita urgente (precio EXT), false si es normal (STD). Pregúntaselo, no lo supongas.',
        },
        tiene_guarda: { type: 'boolean', description: 'false si le falta la guarda' },
        tiene_caja_conexiones: { type: 'boolean', description: 'false si le falta la caja de conexiones' },
        tiene_ventilador: { type: 'boolean', description: 'false si le falta el ventilador' },
        flecha_danada: { type: 'boolean', description: 'true si la flecha necesita reparación' },
        requiere_balanceo: { type: 'boolean', description: 'true si se pidió balanceo de rotor' },
        requiere_bornera: { type: 'boolean', description: 'true si hay que cambiar la bornera' },
      },
      required: ['hp'],
    },
  },
  {
    name: 'registrar_orden_compra',
    description: `Anota el número de orden de compra (OC) del cliente en una cotización
que ya existe en Odoo.

ÚSALA cuando el cliente te diga que ya salió su OC y te dé el número,
mencionando a qué cotización corresponde. Es muy común: primero mandan el
equipo porque urge, y la OC sale días después.

Si el cliente te da el número pero no dice de cuál cotización, pregúntaselo
antes. El folio se ve así: S00360.`,
    input_schema: {
      type: 'object',
      properties: {
        folio: {
          type: 'string',
          description: 'Folio de la cotización en Odoo, como S00360',
        },
        orden_compra: {
          type: 'string',
          description: 'Número de orden de compra que dio el cliente',
        },
      },
      required: ['folio', 'orden_compra'],
    },
  },
  {
    name: 'avisar_a_humano',
    description: `Avisa a un asesor de CAAF para que tome la conversación. A partir de
ese momento el cliente lo atiende una persona y tú dejas de responderle.

ÚSALA cuando:
- El cliente pide expresamente hablar con una persona.
- Hay un reclamo, una queja o el cliente está molesto.
- Piden un descuento o un precio especial que tú no puedes autorizar.
- Se trata de un servicio (rebobinado, reparación, mantenimiento) que
  necesita revisión técnica o visita.
- Preguntan por una garantía, una devolución o un pedido que ya hicieron.
- El cliente insiste con algo que ya no supiste resolver.

NO la uses para consultas normales de precio o existencia: para eso están
buscar_producto y crear_cotizacion.

Solo llámala UNA vez por conversación.`,
    input_schema: {
      type: 'object',
      properties: {
        motivo: {
          type: 'string',
          description: 'En pocas palabras, por qué necesita a una persona. Ej: "Reclamo por pieza defectuosa", "Pide descuento por volumen"',
        },
        resumen: {
          type: 'string',
          description: 'Resumen de lo que necesita el cliente y lo que ya se habló, para que el asesor entre al tema sin leer todo el chat',
        },
      },
      required: ['motivo', 'resumen'],
    },
  },
];

// Función que le manda el historial completo del cliente a Claude y regresa
// la respuesta final, resolviendo por el camino cualquier consulta a Odoo
// que Claude pida hacer.
async function preguntarleAClaude(numeroCliente, nombreCliente) {
  const systemPrompt = `Eres el asistente de ventas de CAAF Oil Services Implements,
un taller de motores eléctricos en Villahermosa, Tabasco. Respondes por WhatsApp
a clientes que preguntan por productos, cotizaciones, o servicios de rebobinado
y reparación de motores eléctricos. Sé amable, breve y directo, como se habla
por WhatsApp (mensajes cortos, sin formato markdown). Estás hablando con
${nombreCliente}.

IMPORTANTE: Ya tienes el historial completo de esta conversación. NO repitas
preguntas que el cliente ya respondió.

=== CONSULTAR EL CATÁLOGO ===
Usa "buscar_producto" siempre que el cliente mencione una pieza específica,
antes de dar cualquier precio. Manda SOLO el código, sin palabras como
"rodamiento" o "precio".

Cuando le escribas un código al cliente, cópialo EXACTAMENTE como viene en
el catálogo, con sus guiones y todo (por ejemplo "6206-2RSR-L038-C3", no
"6206-2RSRL38C3"). Si lo cambias, después nadie lo encuentra en el sistema.

Si la búsqueda regresa muchas variantes del mismo código, NO las listes todas.
Menciona 2 o 3 y pregúntale cuál necesita exactamente.

Nunca inventes precios ni existencias. Si no encuentras nada, dile que no lo
tienes registrado y que un asesor lo puede cotizar de forma especial.

Ojo con la existencia: si el producto aparece con 0 piezas a la mano, no digas
que está disponible. Di que lo manejas pero que habría que pedirlo y confirmar
tiempo de entrega.

=== COTIZAR FORMALMENTE ===
Cuando el cliente ya sepa qué pieza quiere y cuántas, ofrécele mandarle la
cotización formal en PDF. Si te dice que sí, usa "crear_cotizacion".

Antes de llamarla, asegúrate de tener el producto exacto (con su id) y la
cantidad. Si te falta alguno, pregúntaselo en un solo mensaje.

Cada cotización es un documento real en el sistema de la empresa, así que no
la generes "por si acaso" ni nada más para mostrar un precio. Para eso basta
con decirle el precio en el chat.

Después de crearla, el PDF ya le llegó solo al cliente por WhatsApp. Tú nada
más confírmale el folio y el total, y dile que ahí viene el desglose completo.

=== ENVÍO POR CORREO ===
Si el cliente pide que se la mandes por correo, pídeselo y pásalo en el campo
"correo" de crear_cotizacion. Le llega el PDF adjunto desde el correo de CAAF.

Con los clientes de Coca-Cola pregúntale SIEMPRE su correo, porque cada persona
tiene el suyo y no se puede suponer. Pídeselo junto con su nombre y área.

Si el envío falla, dile que hubo un problema con el correo pero que ya tiene el
PDF por WhatsApp, y avisa con avisar_a_humano.

=== FOTOS DE PLACAS ===
El cliente te puede mandar la foto de la placa de datos del motor. Léela con
cuidado y saca lo que necesites: capacidad (HP o kW), rpm, voltaje, armazón
(frame), número de polos, marca y modelo. Muchas placas también traen los
números de rodamiento, casi siempre marcados como "BEARING", "ROD.", "D.E." y
"O.D.E.", o simplemente dos números tipo 6312 / 6212.

Cuando leas una placa:
- Confírmale al cliente los datos que alcanzaste a leer, para que te corrija si
  algo salió borroso.
- Si la placa trae los rodamientos, úsalos directo con buscar_producto. NO
  estimes, ya tienes el dato bueno.
- Si no los trae, ahí sí usa estimar_rodamientos con los HP y las rpm.
- Si te piden rebobinado, ya tienes capacidad, rpm y voltaje: cotiza sin volver
  a preguntar lo que ya viste en la foto.

Si la foto salió borrosa o no se alcanza a leer algo, dile qué dato falta y
pídele otra foto más cerca, o que te lo escriba.

El cliente también te puede mandar la foto de un rodamiento o de una pieza. Lee
el número que traiga grabado y búscalo en el catálogo.

=== MOTORES SIN PLACA ===
Es muy común que el cliente traiga un motor sin placa, o con la placa borrada,
y no sepa qué rodamientos lleva. Para eso usa "estimar_rodamientos".

Necesitas dos datos: los HP y las rpm. Pídeselos en un solo mensaje. Si no sabe
las rpm, dile que las busque en la placa o que un asesor se lo confirma, porque
a 3600 rpm el rodamiento tiene que ser distinto.

Cuando le des el resultado, sé claro en que es un ESTIMADO: el número exacto se
sabe hasta que se abre el motor. Explícale que se cotiza así para que no le
falte, y que si al abrirlo sale uno más económico se le ajusta.

Recuérdale que además de los dos rodamientos va el servicio de cambio L.A. y
L.O., y que ese se lo cotiza un asesor.

Arriba de 50 HP no estimes nada: pásalo con un asesor usando avisar_a_humano.

=== REBOBINADO DE MOTORES ===
Cuando el cliente pregunte por rebobinar o embobinar un motor, usa
"cotizar_rebobinado".

Antes de llamarla necesitas TRES datos, y los pides en UN SOLO mensaje:
capacidad (HP o kW), rpm y voltaje. Algo como: "Para cotizarte el rebobinado
necesito tres datos de la placa: capacidad en HP, las rpm y el voltaje."

Las rpm son indispensables, sin ellas no se puede cotizar. Si el cliente no
las tiene, dile que las busque en la placa del motor.

Un rebobinado se cotiza con estas cuatro líneas:
  1. El servicio de rebobinado
  2. Pintura y limpieza mecánica (de "complementos_disponibles")
  3. El paquete de cambio de rodamientos
  4. La tornillería

Las tres primeras y la tornillería te las regresa cotizar_rebobinado ya listas
en "paquete_completo". Solo agrégalas todas a la cotización.

Sobre los rodamientos hay DOS formas de cotizar, y depende de un solo dato:

CASO 1 — La placa dice qué rodamientos lleva.
Cuando el cliente manda foto de la placa y ahí vienen impresos (como "BEARING",
"ROD.", "D.E./O.D.E." o dos números tipo 6312 / 6212), ya no estás adivinando:
el fabricante te lo está diciendo. Entonces SÍ los desglosas.
  - Búscalos con buscar_producto.
  - Suma los dos y llama a cotizar_cambio_rodamientos con esa suma, para el
    servicio de mano de obra.
  - En este caso NO uses el paquete "CAMBIO DE RODAMIENTOS DE MOTOR", porque
    estarías cobrando dos veces la colocación.

CASO 2 — No hay placa, o la placa no dice los rodamientos.
Aquí nadie sabe qué lleva hasta que se abre el motor. NO pongas números de
pieza: te comprometes con algo que puede no ser. Usa el paquete "CAMBIO DE
RODAMIENTOS DE MOTOR" de paquete_completo, que ya incluye suministro y
colocación de los dos.

Si el cliente solo pregunta cuáles rodamientos lleva, sin cotizar el trabajo,
puedes orientarlo con estimar_rodamientos aclarando que es un estimado. Y si
lo que quiere es COMPRAR rodamientos sueltos, usa buscar_producto normalmente.

Después de darle el precio, pregúntale si el motor viene completo, en una sola
pregunta: "¿El motor trae su guarda, su ventilador y su caja de conexiones?"
Lo que le falte hay que cotizarlo aparte, porque se compra o se fabrica. Cuando
te conteste, vuelve a llamar a cotizar_rebobinado con esos datos y te regresa
las piezas con precio para agregarlas.

Aclárale al cliente que el precio final se confirma cuando el motor llegue al
taller y se revise, porque puede haber daños que no se ven desde afuera.

Arriba de 100 HP no cotices: usa avisar_a_humano.

=== CUÁNDO LLAMAR A UNA PERSONA ===
Usa "avisar_a_humano" cuando el cliente pida hablar con alguien, se queje,
esté molesto, pida un descuento, pregunte por una garantía o una devolución,
o cuando se trate de un servicio de rebobinado o reparación que necesita
revisión técnica.

También úsala si ya diste dos vueltas al mismo tema y no lograste resolverle.
Mejor pasarlo con una persona que dejarlo dando vueltas.

Después de llamarla, dile al cliente que en un momento lo atiende un asesor
y despídete amablemente. Ya no sigas atendiendo ese tema.

=== COTIZACIONES ESPECIALES ===
Si el cliente pide cotización de un servicio (rebobinado, reparación) o de algo
que no está en catálogo, NO uses crear_cotizacion. Pide los datos que falten
(qué motor, marca, HP, cantidad) en una sola pregunta y dile que un asesor se
la prepara.

=== CLIENTES DE CONTRATO (COCA-COLA) ===
Coca-Cola, FEMSA y Embotelladora Mexicana de Bebidas Refrescantes tienen su
propia lista de precios. Para ellos usa "cotizar_contrato", NUNCA
cotizar_rebobinado ni los precios de público.

En cuanto identifiques que el cliente es de Coca-Cola, pídele en un solo
mensaje: su nombre, el ÁREA O PLANTA, su correo, la capacidad del motor y si el
trabajo es urgente.

El área es obligatoria y no la puedes saltar. Todas las plantas de KOF facturan
a la misma razón social, así que sin el área nadie sabe de dónde salió el motor
ni a quién corresponde el cargo. Al crear la cotización, mándala en el campo
"area" junto con el nombre de quien la pide, por ejemplo:
"Planta Villahermosa - Mantenimiento - Juan Pérez".

Si el cliente te da marca, modelo, serie o número de inventario del motor,
pásalos en el campo "notas" para que queden en la cotización.

=== ORDEN DE COMPRA DEL CLIENTE ===
Cuando el cliente ya autorizó el trabajo, pregúntale si tiene número de orden
de compra (OC) y pásalo en el campo "orden_compra".

Ese número es importante: es el documento con el que la empresa autoriza el
gasto, y contra él se justifica después el material que se consume en el
taller. En empresas grandes casi siempre lo tienen.

Si todavía no lo tienen, no insistas ni detengas la cotización. Es muy común
que primero manden el equipo porque urge y la OC salga días después. Dile que
cuando se la den nos la comparta para anexarla al pedido.

Cuando después te escriban con el número de OC, usa "registrar_orden_compra"
con el folio de la cotización. Si no te dicen de cuál cotización es,
pregúntaselo antes de registrarla.

Los clientes que normalmente sí manejan OC son Coca-Cola, Ajemex y el Ingenio
Presidente Benito Juárez. A los demás ni les preguntes, casi nunca la tienen.

La urgencia es clave: urgente se cotiza EXT y normal se cotiza STD, con 20% de
diferencia. Nunca la supongas, siempre pregúntala.

El paquete base ya incluye embobinado, cambio de rodamientos, limpieza y
pintura, y ajuste de tapas. Aparte pregúntale, también en un solo mensaje, si
el motor trae guarda, caja de conexiones y ventilador, y si la flecha necesita
reparación. Lo que falte se agrega a la cotización.`;

  let historial = [...obtenerHistorial(numeroCliente)];

  // Puede que Claude necesite varias rondas (pide buscar, le damos el
  // resultado, decide si busca otra cosa o ya responde). Limitamos a
  // 5 rondas por seguridad, para no quedar en un loop infinito.
  for (let ronda = 0; ronda < 5; ronda++) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        system: systemPrompt,
        tools: herramientas,
        messages: historial,
      }),
    });

    let data = await response.json();

    // A veces la API está saturada un momento. Antes de rendirnos, reintentamos.
    if (data.error && /overloaded|rate_limit|api_error/i.test(data.error.type || '')) {
      console.error('API de Claude saturada, reintentando en 3s:', data.error.type);
      await new Promise((r) => setTimeout(r, 3000));

      const reintento = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 500,
          system: systemPrompt,
          tools: herramientas,
          messages: historial,
        }),
      });
      data = await reintento.json();
    }

    if (data.error) {
      console.error('Error de la API de Claude:', JSON.stringify(data.error));
      return 'Disculpa, tuvimos un problema técnico. En breve un asesor te contactará.';
    }

    // Claude puede pedir VARIAS herramientas en una sola respuesta
    // (por ejemplo buscar los dos rodamientos a la vez). Hay que contestarle
    // TODAS, si no la API rechaza la siguiente petición.
    const bloquesHerramienta = (data.content || []).filter((b) => b.type === 'tool_use');

    if (bloquesHerramienta.length > 0 && data.stop_reason === 'tool_use') {
      const resultados = [];

      for (const bloque of bloquesHerramienta) {
        console.log(
          `Claude pidió la herramienta "${bloque.name}":`,
          JSON.stringify(bloque.input)
        );

        let resultadoHerramienta;
        try {
          if (bloque.name === 'buscar_producto') {
            resultadoHerramienta = await buscarProductoOdoo(bloque.input.query);
          } else if (bloque.name === 'crear_cotizacion') {
            resultadoHerramienta = await crearCotizacionOdoo(
              numeroCliente,
              nombreCliente,
              bloque.input
            );
          } else if (bloque.name === 'estimar_rodamientos') {
            resultadoHerramienta = await estimarRodamientos(bloque.input);
          } else if (bloque.name === 'cotizar_rebobinado') {
            resultadoHerramienta = await cotizarRebobinado(bloque.input);
          } else if (bloque.name === 'registrar_orden_compra') {
            resultadoHerramienta = await registrarOrdenCompra(
              bloque.input.folio,
              bloque.input.orden_compra
            );
          } else if (bloque.name === 'cotizar_contrato') {
            resultadoHerramienta = await cotizarContratoMX(bloque.input);
          } else if (bloque.name === 'cotizar_cambio_rodamientos') {
            resultadoHerramienta = await cotizarCambioRodamientos(bloque.input);
          } else if (bloque.name === 'avisar_a_humano') {
            resultadoHerramienta = await avisarAHumano(
              numeroCliente,
              nombreCliente,
              bloque.input
            );
          } else {
            resultadoHerramienta = { error: `Herramienta desconocida: ${bloque.name}` };
          }
        } catch (err) {
          console.error(`Error en la herramienta "${bloque.name}":`, err);
          odooUid = null; // forzamos re-login por si la sesión se cayó
          resultadoHerramienta = {
            error: 'No se pudo completar la operación en el sistema en este momento.',
          };
        }

        resultados.push({
          type: 'tool_result',
          tool_use_id: bloque.id,
          content: JSON.stringify(resultadoHerramienta),
        });
      }

      // Agregamos al historial: lo que Claude respondió (pidiendo las
      // herramientas) y TODOS los resultados juntos, para que en la
      // siguiente ronda ya tenga esos datos y pueda responder.
      historial.push({ role: 'assistant', content: data.content });
      historial.push({ role: 'user', content: resultados });

      continue; // volvemos a preguntarle a Claude, ahora con los resultados
    }

    // Si no pidió herramienta, ya tenemos la respuesta final en texto
    const bloqueTexto = data.content?.find((b) => b.type === 'text');
    return bloqueTexto?.text || 'Disculpa, no entendí tu mensaje, ¿puedes reformularlo?';
  }

  return 'Disculpa, tuve un problema consultando el catálogo. En breve un asesor te contactará.';
}

// Función que manda un mensaje de texto por la API de WhatsApp
async function enviarMensajeWhatsApp(numeroDestino, texto) {
  const url = `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_ID}/messages`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: numeroDestino,
      type: 'text',
      text: { body: texto },
    }),
  });

  const data = await response.json();

  if (data.error) {
    console.error('Error enviando mensaje de WhatsApp:', data.error);
  } else {
    console.log('Mensaje enviado correctamente a', numeroDestino);
  }
}

// Función que manda un archivo (el PDF de la cotización) por WhatsApp.
// Regresa true si se envió bien, false si falló.
async function enviarDocumentoWhatsApp(numeroDestino, urlDocumento, nombreArchivo, textoPie) {
  const url = `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_ID}/messages`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: numeroDestino,
        type: 'document',
        document: {
          link: urlDocumento,
          filename: nombreArchivo,
          caption: textoPie,
        },
      }),
    });

    const data = await response.json();

    if (data.error) {
      console.error('Error enviando el PDF por WhatsApp:', data.error);
      return false;
    }

    console.log('PDF enviado correctamente a', numeroDestino);
    return true;
  } catch (err) {
    console.error('Falló el envío del PDF:', err);
    return false;
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});