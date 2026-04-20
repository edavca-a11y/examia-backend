require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');

const app = express();
const PORT = process.env.PORT || 3000;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST']
}));
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// ─── PROMPT PRINCIPAL ─────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Eres ExamIA, un asistente educativo especializado en explicar resultados de exámenes médicos en lenguaje simple y claro para pacientes chilenos.

REGLAS ESTRICTAS:
1. NUNCA diagnostiques enfermedades ni condiciones médicas
2. NUNCA recomiendes medicamentos, dosis ni tratamientos
3. NUNCA uses frases como "tienes X enfermedad" o "padeces de X"
4. SIEMPRE usa lenguaje accesible, sin jerga médica innecesaria
5. Cuando un valor está fuera de rango, explica QUÉ mide ese valor y QUÉ significa estar fuera del rango
6. SIEMPRE termina con 2-3 preguntas concretas que el paciente puede hacerle a su médico
7. Responde SIEMPRE en español chileno, tono cercano pero profesional
8. Si el documento no parece ser un examen médico, indícalo amablemente

ESTRUCTURA DE RESPUESTA — responde con DOS secciones separadas por |||VISUAL|||:

SECCIÓN 1 — Explicación en texto:
## Resumen general
[2-3 líneas con la visión general del examen en lenguaje muy simple]

## Tus valores en detalle
[Para cada valor: nombre común, qué mide, si está normal/sobre/bajo rango, qué significa en palabras simples]

## Lo que podrías preguntarle a tu médico
[2-3 preguntas específicas basadas en ESTE examen]

|||VISUAL|||

SECCIÓN 2 — Solo JSON, sin markdown:
{"scenario":"cardiovascular|metabolico|renal|oseo|hematologico","detected_scenarios":["principal","secundario_si_aplica"]}

Reglas scenario: cardiovascular=colesterol/triglicéridos/corazón, metabolico=glucosa/insulina/HbA1c, renal=creatinina/urea/TFG, oseo=fracturas/densitometría/radiografías, hematologico=hemograma/hemoglobina/anemia. detected_scenarios lista todos los sistemas afectados.

IMPORTANTE: Esta herramienta es informativa y educativa. No reemplaza la consulta médica.`;

// ─── ENDPOINT WEB: ANALIZAR EXAMEN ────────────────────────────────────────────
app.post('/analyze', async (req, res) => {
  const { file, mediaType, fileName } = req.body;

  if (!file || !mediaType) {
    return res.status(400).json({ error: 'Falta el archivo o el tipo de medio' });
  }

  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf'];
  if (!allowedTypes.includes(mediaType)) {
    return res.status(400).json({ error: 'Tipo de archivo no soportado' });
  }

  try {
    let messageContent;

    if (mediaType === 'application/pdf') {
      messageContent = [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: file }
        },
        {
          type: 'text',
          text: 'Por favor analiza este examen médico y explícalo siguiendo las instrucciones del sistema.'
        }
      ];
    } else {
      messageContent = [
        {
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: file }
        },
        {
          type: 'text',
          text: 'Por favor analiza este examen médico y explícalo siguiendo las instrucciones del sistema.'
        }
      ];
    }

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: messageContent }]
    });

    const fullText = response.content[0].text;
    const [interpretationRaw, visualRaw] = fullText.split('|||VISUAL|||');
    const interpretation = interpretationRaw.trim();

    let visual = null;
    if(visualRaw) {
      try {
        const jsonStr = visualRaw.trim().replace(/```json|```/g, '').trim();
        visual = JSON.parse(jsonStr);
      } catch(e) {
        visual = { scenario: 'cardiovascular', detected_scenarios: ['cardiovascular'] };
      }
    }

    // NO guardamos el examen — solo retornamos la interpretación
    res.json({ interpretation, visual, success: true });

  } catch (err) {
    console.error('Error al analizar:', err.message);
    res.status(500).json({ error: 'No se pudo procesar el examen. Intenta de nuevo.' });
  }
});

// ─── WEBHOOK WHATSAPP (TWILIO) ─────────────────────────────────────────────────
app.post('/whatsapp', async (req, res) => {
  const { Body, NumMedia, MediaUrl0, MediaContentType0, From } = req.body;

  const twiml = new twilio.twiml.MessagingResponse();

  // Saludo inicial
  if (Body && Body.trim().toLowerCase() === 'hola' && !NumMedia) {
    twiml.message(`¡Hola! 👋 Soy *ExamIA*, tu asistente para entender exámenes médicos.

Envíame una *foto clara de tu examen* (hemograma, bioquímica, hormonas, etc.) y te lo explico en lenguaje simple en segundos.

📌 *Importante*: Soy una herramienta educativa. Mi explicación no reemplaza a tu médico.`);
    res.type('text/xml').send(twiml.toString());
    return;
  }

  // Recibió imagen
  if (NumMedia && parseInt(NumMedia) > 0 && MediaUrl0) {
    const contentType = MediaContentType0 || 'image/jpeg';

    if (!contentType.startsWith('image/')) {
      twiml.message('Solo puedo analizar imágenes por ahora. Toma una foto de tu examen y envíala 📸');
      res.type('text/xml').send(twiml.toString());
      return;
    }

    // Confirmación inmediata
    twiml.message('📄 Recibí tu examen. Analizando... dame unos segundos ⏳');
    res.type('text/xml').send(twiml.toString());

    // Procesar en background y responder
    processWhatsAppImage(From, MediaUrl0, contentType);
    return;
  }

  // Mensaje de texto genérico
  twiml.message('Para analizar tu examen, envíame una *foto clara* del documento. Si necesitas ayuda, escribe *hola*.');
  res.type('text/xml').send(twiml.toString());
});

async function processWhatsAppImage(to, mediaUrl, contentType) {
  try {
    // Descargar imagen desde Twilio
    const imgRes = await fetch(mediaUrl, {
      headers: {
        Authorization: 'Basic ' + Buffer.from(
          `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
        ).toString('base64')
      }
    });
    const buffer = await imgRes.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1200,
      system: SYSTEM_PROMPT + '\n\nIMPORTANTE: Respuesta para WhatsApp — usa formato de texto plano sin markdown. Usa emojis con moderación para separar secciones.',
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: contentType, data: base64 } },
          { type: 'text', text: 'Analiza este examen médico.' }
        ]
      }]
    });

    const interpretation = response.content[0].text;

    // Dividir respuesta larga en mensajes de máx 1600 chars (límite WhatsApp)
    const chunks = splitMessage(interpretation, 1550);

    for (let i = 0; i < chunks.length; i++) {
      await twilioClient.messages.create({
        from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
        to: to,
        body: i === chunks.length - 1
          ? chunks[i] + '\n\n_ExamIA · Solo informativo · Consulta siempre con tu médico_'
          : chunks[i]
      });
      if (i < chunks.length - 1) await sleep(500);
    }

  } catch (err) {
    console.error('Error procesando WhatsApp:', err.message);
    await twilioClient.messages.create({
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
      to: to,
      body: 'Lo siento, hubo un problema al analizar tu examen. ¿Puedes intentar con una foto más clara? 🙏'
    });
  }
}

function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = start + maxLen;
    if (end < text.length) {
      const lastNewline = text.lastIndexOf('\n', end);
      if (lastNewline > start) end = lastNewline;
    }
    chunks.push(text.slice(start, end).trim());
    start = end + 1;
  }
  return chunks.filter(c => c.length > 0);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'ExamIA Backend' }));

app.listen(PORT, () => console.log(`ExamIA backend corriendo en puerto ${PORT}`));
