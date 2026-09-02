const express = require('express');
const xmlrpc = require('xmlrpc');
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
    fields: ['name', 'list_price', 'qty_available', 'default_code'],
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

// Definición de la herramienta que Claude puede usar para buscar productos
const herramientas = [
  {
    name: 'buscar_producto',
    description: `Busca productos en el catálogo real de Odoo de CAAF Oil Services.
Regresa nombre, referencia interna, precio de venta y existencia disponible.

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
];

// Función que le manda el historial completo del cliente a Claude y regresa
// la respuesta final, resolviendo por el camino cualquier búsqueda en Odoo
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

Tienes acceso a la herramienta "buscar_producto" para consultar el catálogo
REAL de Odoo (nombre, precio, existencia). ÚSALA siempre que el cliente
mencione un producto o pieza específica, antes de dar cualquier precio.

Al usar buscar_producto, manda SOLO el código de la pieza, sin palabras como
"rodamiento" o "precio". Si el cliente escribe "tienes rodamiento 6205-2RS-C3
TIMKEN", tú buscas "6205-2RS-C3 TIMKEN".

Si la búsqueda regresa varias variantes del mismo código (por ejemplo 6205-2RS,
6205-2Z-C3, 6205-C), NO las listes todas. Menciona 2 o 3 y pregúntale al cliente
cuál necesita exactamente, o pídele el código completo.

Nunca inventes precios ni existencias. Si buscar_producto no encuentra nada,
dile al cliente que no lo tienes registrado en catálogo y que un asesor lo
puede cotizar de forma especial.

Ojo con la existencia: si el producto aparece con 0 piezas a la mano, no digas
que está disponible. Di que lo manejas pero que hay que confirmar tiempo de
entrega, porque habría que pedirlo.

Si el cliente pide una cotización, pide solo los datos que falten (qué
pieza/motor, marca, HP, cantidad) en una sola pregunta, no una por mensaje.
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

    // Si Claude pidió usar la herramienta de buscar_producto...
    const bloqueHerramienta = data.content?.find((b) => b.type === 'tool_use');

    if (bloqueHerramienta && data.stop_reason === 'tool_use') {
      console.log('Claude pidió buscar en Odoo:', bloqueHerramienta.input.query);

      let resultadoBusqueda;
      try {
        resultadoBusqueda = await buscarProductoOdoo(bloqueHerramienta.input.query);
      } catch (err) {
        console.error('Error consultando Odoo:', err);
        odooUid = null; // forzamos re-login por si la sesión se cayó
        resultadoBusqueda = { error: 'No se pudo consultar el catálogo en este momento.' };
      }

      // Agregamos al historial: lo que Claude respondió (pidiendo la
      // herramienta) y el resultado de la búsqueda, para que en la
      // siguiente ronda Claude ya tenga esos datos y pueda responder.
      historial.push({ role: 'assistant', content: data.content });
      historial.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: bloqueHerramienta.id,
            content: JSON.stringify(resultadoBusqueda),
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});