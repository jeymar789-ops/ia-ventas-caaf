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
        ['sale_ok', '=', true],
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
  const porTelefono = await odooEjecutar(
    'res.partner',
    'search_read',
    [['|', ['phone', 'ilike', ultimos10], ['mobile', 'ilike', ultimos10]]],
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

  const ordenId = await odooEjecutar('sale.order', 'create', [datosOrden]);

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