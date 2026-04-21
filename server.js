require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(cors({ origin: process.env.FRONTEND_URL || '*', methods: ['GET', 'POST'] }));
app.use(express.json({ limit: '15mb' }));

const SYSTEM_PROMPT = `Eres ExamIA, un asistente educativo que explica exámenes médicos en lenguaje simple para pacientes chilenos.

REGLAS ESTRICTAS:
1. NUNCA diagnostiques enfermedades ni condiciones médicas
2. NUNCA recomiendes medicamentos, dosis ni tratamientos
3. NUNCA uses frases como "tienes X enfermedad" o "padeces de X"
4. Usa lenguaje simple, cercano, en español chileno
5. Cada explicación debe enseñar algo de biología de forma interesante y fácil

FORMATO DE RESPUESTA — responde con DOS bloques separados por |||VISUAL|||:

BLOQUE 1 — JSON estructurado para mostrar por secciones (solo JSON, sin markdown):
{
  "resumen": "2-3 oraciones simples sobre el estado general del examen. Tono tranquilo y claro.",
  "secciones": [
    {
      "titulo": "Nombre del grupo (ej: Azúcar en sangre, Riñones, Glóbulos rojos)",
      "icono": "gota|corazon|rinon|hueso|celula|tiroides|defensa|orina|coagulacion",
      "estado": "ok|alerta|fuera",
      "valores": [
        {
          "nombre": "Nombre del valor",
          "valor": "número + unidad",
          "referencia": "rango normal",
          "estado": "ok|alerta|fuera",
          "explicacion": "1 oración: qué mide este valor en palabras simples"
        }
      ],
      "didactica": "1-2 oraciones curiosas sobre qué hace este sistema en el cuerpo. Ej: 'Los glóbulos rojos son como camiones que llevan oxígeno a cada célula de tu cuerpo.'"
    }
  ],
  "preguntas": [
    "Pregunta 1 para el médico",
    "Pregunta 2 para el médico",
    "Pregunta 3 para el médico"
  ]
}

|||VISUAL|||

BLOQUE 2 — JSON para infografía (solo JSON, sin markdown):
{"scenario":"cardiovascular|metabolico|renal|oseo|hematologico","detected_scenarios":["principal","secundario_si_aplica"]}

Reglas scenario: cardiovascular=colesterol/triglicéridos/corazón, metabolico=glucosa/insulina/HbA1c, renal=creatinina/urea/TFG, oseo=fracturas/densitometría, hematologico=hemograma/hemoglobina/anemia.

IMPORTANTE: Solo JSON válido en ambos bloques. Sin texto adicional, sin markdown, sin explicaciones fuera del JSON.`;

app.post('/analyze', async (req, res) => {
  const { file, mediaType } = req.body;
  if (!file || !mediaType) return res.status(400).json({ error: 'Falta el archivo o el tipo de medio' });

  const allowed = ['image/jpeg','image/jpg','image/png','image/webp','application/pdf'];
  if (!allowed.includes(mediaType)) return res.status(400).json({ error: 'Tipo de archivo no soportado' });

  try {
    const content = mediaType === 'application/pdf'
      ? [{ type:'document', source:{ type:'base64', media_type:'application/pdf', data:file } }, { type:'text', text:'Analiza este examen médico.' }]
      : [{ type:'image', source:{ type:'base64', media_type:mediaType, data:file } }, { type:'text', text:'Analiza este examen médico.' }];

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{ role:'user', content }]
    });

    const fullText = response.content[0].text;
    const parts = fullText.split('|||VISUAL|||');

    let interpretation = null;
    let visual = null;

    // Parsear bloque 1 — JSON de secciones
    try {
      const raw1 = parts[0].trim().replace(/```json|```/g,'').trim();
      // Buscar el JSON aunque haya texto antes o después
      const jsonStart = raw1.indexOf('{');
      const jsonEnd = raw1.lastIndexOf('}');
      if(jsonStart !== -1 && jsonEnd !== -1) {
        interpretation = JSON.parse(raw1.slice(jsonStart, jsonEnd+1));
      } else {
        throw new Error('No JSON found');
      }
    } catch(e) {
      console.error('Error parseando interpretación:', e.message);
      interpretation = { resumen: parts[0].trim(), secciones: [], preguntas: [] };
    }

    // Parsear bloque 2 — JSON visual
    if (parts[1]) {
      try {
        const raw2 = parts[1].trim().replace(/```json|```/g,'').trim();
        const jsonStart = raw2.indexOf('{');
        const jsonEnd = raw2.lastIndexOf('}');
        if(jsonStart !== -1 && jsonEnd !== -1) {
          visual = JSON.parse(raw2.slice(jsonStart, jsonEnd+1));
        }
      } catch(e) {
        visual = { scenario:'hematologico', detected_scenarios:['hematologico'] };
      }
    }

    res.json({ interpretation, visual, success: true });

  } catch(err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: 'No se pudo procesar el examen. Intenta de nuevo.' });
  }
});

app.get('/health', (req, res) => res.json({ status:'ok', service:'ExamIA Backend' }));
app.listen(PORT, () => console.log(`ExamIA backend corriendo en puerto ${PORT}`));
