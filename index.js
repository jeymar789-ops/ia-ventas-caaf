const express = require('express');
const xmlrpc = require('xmlrpc');
const crypto = require('crypto');
const app = express();
app.use(express.json());

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

  let elegibles = delCodigo.filter((p) =>
    necesitaJuego ? tieneJuego(p.name) : !tieneJuego(p.name)
  );
  // Si no hay del tipo que buscamos, usamos cualquiera del código
  if (elegibles.length === 0) elegibles = delCodigo;

  // La más cara, que es como estiman en el taller
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
  { hp: 0.5, polos: 2, kg: 2.0, precioBase: 1800 },
  { hp: 0.5, polos: 4, kg: 2.0, precioBase: 1800 },
  { hp: 0.5, polos: 6, kg: 1.5, precioBase: 1500 },
  { hp: 1, polos: 2, kg: 2.5, precioBase: 2200 },
  { hp: 1, polos: 4, kg: 2.5, precioBase: 2200 },
  { hp: 1, polos: 6, kg: 2.0, precioBase: 1800 },
  { hp: 2, polos: 2, kg: 3.5, precioBase: 2800 },
  { hp: 2, polos: 4, kg: 3.5, precioBase: 2800 },
  { hp: 2, polos: 6, kg: 3.0, precioBase: 2800 },
  { hp: 3, polos: 2, kg: 3.5, precioBase: 3500 },
  { hp: 3, polos: 4, kg: 3.5, precioBase: 3500 },
  { hp: 3, polos: 6, kg: 3.5, precioBase: 3500 },
  { hp: 5, polos: 2, kg: 6.0, precioBase: 5750 },
  { hp: 5, polos: 4, kg: 6.0, precioBase: 5200 },
  { hp: 5, polos: 6, kg: 6.0, precioBase: 5000 },
  { hp: 7.5, polos: 2, kg: 8.0, precioBase: 7800 },
  { hp: 7.5, polos: 4, kg: 8.0, precioBase: 7500 },
  { hp: 7.5, polos: 6, kg: 7.5, precioBase: 7500 },
  { hp: 10, polos: 2, kg: 8.5, precioBase: 8200 },
  { hp: 10, polos: 4, kg: 8.5, precioBase: 8200 },
  { hp: 10, polos: 6, kg: 8.0, precioBase: 8000 },
  { hp: 15, polos: 2, kg: 15.0, precioBase: 14500 },
  { hp: 15, polos: 4, kg: 15.0, precioBase: 14500 },
  { hp: 15, polos: 6, kg: 15.0, precioBase: 14500 },
  { hp: 20, polos: 2, kg: 18.0, precioBase: 16500 },
  { hp: 20, polos: 4, kg: 18.0, precioBase: 16500 },
  { hp: 20, polos: 6, kg: 18.0, precioBase: 16500 },
  { hp: 25, polos: 2, kg: 22.0, precioBase: 22000 },
  { hp: 25, polos: 4, kg: 22.0, precioBase: 22000 },
  { hp: 25, polos: 6, kg: 22.0, precioBase: 22000 },
  { hp: 30, polos: 2, kg: 25.0, precioBase: 24000 },
  { hp: 30, polos: 4, kg: 25.0, precioBase: 24000 },
  { hp: 30, polos: 6, kg: 25.0, precioBase: 24000 },
  { hp: 40, polos: 2, kg: 30.0, precioBase: 28500 },
  { hp: 40, polos: 4, kg: 30.0, precioBase: 28500 },
  { hp: 40, polos: 6, kg: 30.0, precioBase: 28500 },
  { hp: 50, polos: 2, kg: 45.0, precioBase: 34000 },
  { hp: 50, polos: 4, kg: 45.0, precioBase: 34000 },
  { hp: 50, polos: 6, kg: 45.0, precioBase: 34000 },
  { hp: 75, polos: 2, kg: 55.0, precioBase: 45000 },
  { hp: 75, polos: 4, kg: 55.0, precioBase: 45000 },
  { hp: 75, polos: 6, kg: 55.0, precioBase: 45000 },
  { hp: 100, polos: 2, kg: 55.0, precioBase: 55000 },
  { hp: 100, polos: 4, kg: 55.0, precioBase: 55000 },
  { hp: 100, polos: 6, kg: 55.0, precioBase: 55000 },
];

const HP_MAXIMO_REBOBINADO = 100;

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

  const uom = await obtenerUomServicio();
  if (uom) {
    datos.uom_id = uom;
    datos.uom_po_id = uom;
  }

  const nuevoId = await odooEjecutar('product.product', 'create', [datos]);

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
    .filter((f) => f.polos === polos && f.hp >= hp - 0.001)
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

  const avisos = [
    'Este precio ya incluye alambre, barniz y mano de obra.',
    'Al rebobinado SIEMPRE súmale PINTURA y LIMPIEZA MECÁNICA, de complementos_disponibles.',
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
    complementos_disponibles: complementos,
    piezas_faltantes: faltantes,
    nota: avisos.join(' '),
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

  // Candado de seguridad: nunca cotizar algo con precio de $0 o $1. Casi
  // siempre significa que el precio no se ha capturado bien en Odoo.
  const idsProductos = productos.map((p) => Number(p.product_id));
  const datosProductos = await odooEjecutar('product.product', 'read', [
    idsProductos,
    ['name', 'list_price'],
  ]);
  const sinPrecio = datosProductos.filter((p) => Number(p.list_price) <= 1);

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
  const lineas = productos.map((p) => [
    0,
    0,
    {
      product_id: Number(p.product_id),
      product_uom_qty: Number(p.cantidad) > 0 ? Number(p.cantidad) : 1,
    },
  ]);

  const equipoId = await obtenerEquipoBot();

  const datosOrden = {
    partner_id: partnerId,
    origin: `Bot WhatsApp — ${numeroCliente}`,
    order_line: lineas,
  };
  if (equipoId) datosOrden.team_id = equipoId;

  // Si algún campo extra (equipo u origen) no existiera en esta versión de
  // Odoo, creamos el presupuesto de todos modos con lo indispensable.
  let ordenId;
  try {
    ordenId = await odooEjecutar('sale.order', 'create', [datosOrden]);
  } catch (err) {
    console.error('No se pudo crear con equipo/origen, reintentando simple:', err.message);
    ordenId = await odooEjecutar('sale.order', 'create', [
      { partner_id: partnerId, order_line: lineas },
    ]);
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

  return {
    folio: orden.name,
    total: orden.amount_total,
    pdf_enviado: pdfEnviado,
    nota: pdfEnviado
      ? 'El PDF de la cotización YA se le mandó al cliente por WhatsApp. No repitas el link, solo confirma el folio y el total.'
      : 'No se pudo mandar el PDF, pero ya se le mandó el link al cliente. Solo confirma el folio y el total.',
  };
}

// ===== AVISOS Y ATENCIÓN HUMANA POR TELEGRAM =====

// Relaciona cada mensaje que mandamos a Telegram con el número de WhatsApp
// del cliente, para saber a quién contestarle cuando respondas ese mensaje.
const mensajesTelegram = new Map();
const MAX_MENSAJES_TELEGRAM = 500;

// Clientes que en este momento atiende una persona. Mientras esté aquí,
// el bot NO contesta y solo te reenvía lo que escriba el cliente.
const modoHumano = new Map();

function recordarMensajeTelegram(idMensaje, numeroCliente) {
  mensajesTelegram.set(String(idMensaje), numeroCliente);
  while (mensajesTelegram.size > MAX_MENSAJES_TELEGRAM) {
    const masViejo = mensajesTelegram.keys().next().value;
    mensajesTelegram.delete(masViejo);
  }
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
  modoHumano.set(numeroCliente, true);
  console.log(`Modo humano ACTIVADO para ${numeroCliente} (motivo: ${motivo})`);

  return {
    avisado: idMensaje !== null,
    nota:
      idMensaje !== null
        ? 'Ya se le avisó a un asesor. Dile al cliente que en un momento lo atiende una persona, y despídete amablemente. No sigas atendiendo el tema.'
        : 'No se pudo avisar al asesor. Pídele al cliente que llame directo al taller.',
  };
}

// ===== MEMORIA DE CONVERSACIÓN =====
const conversaciones = new Map();
const MAX_MENSAJES_GUARDADOS = 20;

function obtenerHistorial(numeroCliente) {
  if (!conversaciones.has(numeroCliente)) {
    conversaciones.set(numeroCliente, []);
  }
  return conversaciones.get(numeroCliente);
}

function agregarAlHistorial(numeroCliente, role, content) {
  const historial = obtenerHistorial(numeroCliente);
  historial.push({ role, content });
  while (historial.length > MAX_MENSAJES_GUARDADOS) {
    historial.shift();
  }
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
          'Para devolverle el control al bot: /bot NUMERO',
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
    modoHumano.set(numeroCliente, true);

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

    if (message.type !== 'text') {
      await enviarMensajeWhatsApp(
        message.from,
        'Por ahora solo puedo leer mensajes de texto. ¿Puedes escribirme lo que necesitas?'
      );
      return;
    }

    const numeroCliente = message.from;
    const textoCliente = message.text.body;
    const nombreCliente = value.contacts?.[0]?.profile?.name || 'Cliente';

    console.log(`Mensaje de ${nombreCliente} (${numeroCliente}): ${textoCliente}`);

    agregarAlHistorial(numeroCliente, 'user', textoCliente);

    // Si una persona ya está atendiendo a este cliente, el bot se calla
    // y solo te reenvía el mensaje a Telegram.
    if (modoHumano.get(numeroCliente)) {
      console.log(`Modo humano activo con ${numeroCliente}, reenviando a Telegram`);
      await avisarPorTelegram(
        numeroCliente,
        `💬 ${nombreCliente} (${numeroCliente}) escribió:\n\n` +
          `${textoCliente}\n\n` +
          `———\n` +
          `Responde a este mensaje para contestarle. /bot para devolverle el control al bot.`
      );
      return;
    }

    const respuestaClaude = await preguntarleAClaude(numeroCliente, nombreCliente);

    agregarAlHistorial(numeroCliente, 'assistant', respuestaClaude);

    await enviarMensajeWhatsApp(numeroCliente, respuestaClaude);

  } catch (error) {
    console.error('Error procesando el mensaje:', error);
  }
});

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

El "product_id" es el campo "id" que te regresó buscar_producto. Si no
tienes ese id, primero busca el producto, no lo inventes.`,
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
            },
            required: ['product_id', 'cantidad'],
          },
        },
        nombre_cliente: {
          type: 'string',
          description: 'Nombre o razón social, si el cliente lo dio en la conversación',
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

Después de crearla, el PDF ya le llegó solo al cliente. Tú nada más confírmale
el folio y el total, y dile que ahí viene el desglose completo.

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

Al rebobinado súmale siempre pintura y limpieza mecánica: la herramienta te
regresa las opciones del catálogo en "complementos_disponibles".

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

Si el cliente menciona que representa a una empresa con precio especial
(por ejemplo Coca-Cola / Embotelladora Mexicana de Bebidas Refrescantes),
pídele su nombre y para qué área es, antes de cotizar.`;

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

    const data = await response.json();

    if (data.error) {
      console.error('Error de la API de Claude:', data.error);
      return 'Disculpa, tuvimos un problema técnico. En breve un asesor te contactará.';
    }

    // Si Claude pidió usar alguna herramienta...
    const bloqueHerramienta = data.content?.find((b) => b.type === 'tool_use');

    if (bloqueHerramienta && data.stop_reason === 'tool_use') {
      console.log(
        `Claude pidió la herramienta "${bloqueHerramienta.name}":`,
        JSON.stringify(bloqueHerramienta.input)
      );

      let resultadoHerramienta;
      try {
        if (bloqueHerramienta.name === 'buscar_producto') {
          resultadoHerramienta = await buscarProductoOdoo(bloqueHerramienta.input.query);
        } else if (bloqueHerramienta.name === 'crear_cotizacion') {
          resultadoHerramienta = await crearCotizacionOdoo(
            numeroCliente,
            nombreCliente,
            bloqueHerramienta.input
          );
        } else if (bloqueHerramienta.name === 'estimar_rodamientos') {
          resultadoHerramienta = await estimarRodamientos(bloqueHerramienta.input);
        } else if (bloqueHerramienta.name === 'cotizar_rebobinado') {
          resultadoHerramienta = await cotizarRebobinado(bloqueHerramienta.input);
        } else if (bloqueHerramienta.name === 'avisar_a_humano') {
          resultadoHerramienta = await avisarAHumano(
            numeroCliente,
            nombreCliente,
            bloqueHerramienta.input
          );
        } else {
          resultadoHerramienta = { error: `Herramienta desconocida: ${bloqueHerramienta.name}` };
        }
      } catch (err) {
        console.error('Error en la operación con Odoo:', err);
        odooUid = null; // forzamos re-login por si la sesión se cayó
        resultadoHerramienta = {
          error: 'No se pudo completar la operación en el sistema en este momento.',
        };
      }

      // Agregamos al historial: lo que Claude respondió (pidiendo la
      // herramienta) y el resultado, para que en la siguiente ronda
      // Claude ya tenga esos datos y pueda responder.
      historial.push({ role: 'assistant', content: data.content });
      historial.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: bloqueHerramienta.id,
            content: JSON.stringify(resultadoHerramienta),
          },
        ],
      });

      continue; // volvemos a preguntarle a Claude, ahora con el resultado
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