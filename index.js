const express = require('express');
const app = express();
app.use(express.json());

// Este token lo inventas TÚ (cualquier palabra/número). Debe ser
// EXACTAMENTE el mismo que pongas en Meta, en "Token de verificación".
const VERIFY_TOKEN = 'caaf-oil-verify-2026';

// Página de salud, para confirmar que el servidor está vivo
app.get('/', (req, res) => {
  res.send('Servidor de CAAF OIL Services funcionando correctamente ✅');
});

// 1) Verificación del webhook (Meta hace un GET una sola vez, al conectar)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verificado correctamente por Meta.');
    res.status(200).send(challenge);
  } else {
    console.log('Verificación de webhook fallida (token no coincide).');
    res.sendStatus(403);
  }
});

// 2) Recepción de mensajes entrantes (Meta hace un POST cada vez que
//    llega un mensaje nuevo al número conectado)
app.post('/webhook', (req, res) => {
  console.log('Mensaje recibido:', JSON.stringify(req.body, null, 2));

  // TODO (próximos pasos):
  // - Extraer el número y el texto del mensaje del cliente
  // - Mandárselo a Claude para que entienda qué necesita y responda
  // - Si aplica, consultar/crear cosas en Odoo (stock, cotización)
  // - Responder al cliente usando la API de WhatsApp

  res.sendStatus(200); // Siempre responder 200 rápido, o Meta reintenta
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});