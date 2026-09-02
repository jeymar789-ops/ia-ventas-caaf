const express = require('express');
const xmlrpc = require('xmlrpc');
const app = express();
app.use(express.json());

// Este token lo inventas TÚ (cualquier palabra/número). Debe ser
// EXACTAMENTE el mismo que pongas en Meta, en "Token de verificación"
const VERIFY_TOKEN = 'caaf-oil-verify-2026';

// Variables de entorno (configuradas en Render)
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;

const ODOO_URL = process.env.ODOO_URL; // ej: https://caaf-oil-services.odoo.com
const ODOO_DB = process.env.ODOO_DB; // ej: caaf-oil-services
const ODOO_USERNAME = process.env.ODOO_USERNAME;
const ODOO_API_KEY = process.env.ODOO_API_KEY;

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

// Busca productos en Odoo por nombre/palabra clave, y regresa nombre,
// precio de venta y existencia disponible.
async function buscarProductoOdoo(query) {
  await odooAutenticar();
  const productos = await odooEjecutar(
    'product.product',
    'search_read',
    [[['name', 'ilike', query]]],
    { fields: ['name', 'list_price', 'qty_available', 'default_code'], limit: 8 }
  );
  return productos;
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
    description: 'Busca productos en el catálogo real de Odoo por nombre o palabra clave (ej. "motor 10 HP", "rodamiento 6205"). Regresa nombre, precio de venta y existencia disponible de cada producto encontrado.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Palabra o frase para buscar en el nombre del producto',
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
Nunca inventes precios ni existencias — si buscar_producto no encuentra
nada, dile al cliente que no tienes ese producto en el catálogo y que un
asesor lo puede ayudar a cotizarlo especialmente.

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