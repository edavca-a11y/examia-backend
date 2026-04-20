require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(cors({ origin: process.env.FRONTEND_URL || '*', methods: ['GET', 'POST'] }));
app.use(express.json({ limit: '15mb' }));

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
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file } },
        { type: 'text', text: 'Por favor analiza este examen médico y explícalo siguiendo las instrucciones del sistema.' }
      ];
    } else {
      messageContent = [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: file } },
        { type: 'text', text: 'Por favor analiza este examen médico y explícalo siguiendo las instrucciones del sistema.' }
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
    if (visualRaw) {
      try {
        const jsonStr = visualRaw.trim().replace(/```json|```/g, '').trim();
        visual = JSON.parse(jsonStr);
      } catch (e) {
        visual = { scenario: 'cardiovascular', detected_scenarios: ['cardiovascular'] };
      }
    }

    res.json({ interpretation, visual, success: true });

  } catch (err) {
    console.error('Error al analizar:', err.message);
    res.status(500).json({ error: 'No se pudo procesar el examen. Intenta de nuevo.' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'ExamIA Backend' }));

app.listen(PORT, () => console.log(`ExamIA backend corriendo en puerto ${PORT}`));
