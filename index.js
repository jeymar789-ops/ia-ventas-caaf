const express = require('express');
const app = express();
app.use(express.json());

// Este token lo inventas TÚ (cualquier palabra/número). Debe ser
// EXACTAMENTE el mismo que pongas en Meta, en "Token de verificación"
const VERIFY_TOKEN = 'caaf-oil-verify-2026';

// Variables de entorno (configuradas en Render)
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;

// Página de salud, para confirmar que el servidor está vivo
app.get('/', (req, res) => {
  res.send('Servidor de CAAF OIL Services funcionando correctamente');
});

// 1) Verificación del webhook (Meta hace un GET una sola vez, al guardar la config)
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

// 2) Recepción de mensajes entrantes (Meta hace un POST cada vez que
//    llega un mensaje nuevo al número conectado)
app.post('/webhook', async (req, res) => {
  console.log('Mensaje recibido:', JSON.stringify(req.body, null, 2));

  // Respondemos 200 de inmediato, para que Meta no reintente el envío.
  // El procesamiento real lo hacemos después, sin bloquear la respuesta.
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    // Si no hay mensaje (por ejemplo, es una notificación de "leído"
    // o de estado), no hacemos nada más.
    if (!message) return;

    // Por ahora solo manejamos mensajes de texto.
    if (message.type !== 'text') {
      console.log('Mensaje no es de texto, tipo:', message.type);
      await enviarMensajeWhatsApp(
        message.from,
        'Por ahora solo puedo leer mensajes de texto. ¿Puedes escribirme lo que necesitas?'
      );
      return;
    }

    const numeroCliente = message.from; // ej. "5219933753729"
    const textoCliente = message.text.body; // lo que escribió
    const nombreCliente = value.contacts?.[0]?.profile?.name || 'Cliente';

    console.log(`Mensaje de ${nombreCliente} (${numeroCliente}): ${textoCliente}`);

    // 3) Le pedimos a Claude que genere la respuesta
    const respuestaClaude = await preguntarleAClaude(textoCliente, nombreCliente);

    // 4) Respondemos al cliente por WhatsApp
    await enviarMensajeWhatsApp(numeroCliente, respuestaClaude);

  } catch (error) {
    console.error('Error procesando el mensaje:', error);
  }
});

// Función que le manda el mensaje del cliente a Claude y regresa la respuesta
async function preguntarleAClaude(textoCliente, nombreCliente) {
  const systemPrompt = `Eres el asistente de ventas de CAAF Oil Services Implements,
un taller de motores eléctricos en Villahermosa, Tabasco. Respondes por WhatsApp
a clientes que preguntan por productos, cotizaciones, o servicios de rebobinado
y reparación de motores eléctricos. Sé amable, breve y directo, como se habla
por WhatsApp (mensajes cortos, sin formato markdown). Si el cliente pide una
cotización, pide los datos que falten (qué pieza/motor, marca, HP, cantidad).
Si el cliente menciona que representa a una empresa con precio especial
(por ejemplo Coca-Cola / Embotelladora Mexicana de Bebidas Refrescantes),
pídele su nombre y para qué área es, antes de cotizar con el precio especial.`;

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
      messages: [
        { role: 'user', content: `${nombreCliente} escribe: ${textoCliente}` }
      ],
    }),
  });

  const data = await response.json();

  if (data.error) {
    console.error('Error de la API de Claude:', data.error);
    return 'Disculpa, tuvimos un problema técnico. En breve un asesor te contactará.';
  }

  const textoRespuesta = data.content?.[0]?.text || 'Disculpa, no entendí tu mensaje, ¿puedes reformularlo?';
  return textoRespuesta;
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