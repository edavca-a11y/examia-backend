require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(cors({ origin: process.env.FRONTEND_URL || '*', methods: ['GET', 'POST'] }));
app.use(express.json({ limit: '15mb' }));

const SYSTEM_PROMPT = `Eres ExamIA. Analizas exámenes médicos y respondes ÚNICAMENTE con dos bloques JSON separados por la cadena |||VISUAL|||

BLOQUE 1 - Interpretación (JSON válido):
{
  "resumen": "string con 2-3 oraciones simples sobre el estado general",
  "secciones": [
    {
      "titulo": "string",
      "icono": "gota|corazon|rinon|hueso|celula|tiroides|defensa|orina|coagulacion",
      "estado": "ok|alerta|fuera",
      "valores": [
        {
          "nombre": "string",
          "valor": "string",
          "referencia": "string",
          "estado": "ok|alerta|fuera",
          "explicacion": "string corto"
        }
      ],
      "didactica": "string con curiosidad biologica simple"
    }
  ],
  "preguntas": ["string","string","string"]
}

|||VISUAL|||

BLOQUE 2 - Visual (JSON válido):
{"scenario":"hematologico","detected_scenarios":["hematologico"]}

REGLAS ABSOLUTAS:
- Responde SOLO con los dos bloques JSON. Nada mas. Sin texto antes ni despues.
- El separador exacto entre bloques es: |||VISUAL|||
- scenario debe ser uno de: cardiovascular, metabolico, renal, oseo, hematologico
- NUNCA diagnostiques ni recomiendes medicamentos
- Usa español chileno simple
- Máximo 8 secciones en total
- Máximo 4 valores por sección — agrupa los menos importantes
- "resumen" máximo 2 oraciones cortas
- "didactica" máximo 1 oración corta
- "explicacion" de cada valor: máximo 8 palabras
- "preguntas" exactamente 3 preguntas cortas
- icono para tiroides: "tiroides"
- icono para inflamacion/VHS: "defensa"
- icono para orina: "orina"
- icono para coagulacion: "coagulacion"`;

app.post('/analyze', async (req, res) => {
  const { file, mediaType } = req.body;
  if (!file || !mediaType) return res.status(400).json({ error: 'Falta archivo' });

  const allowed = ['image/jpeg','image/jpg','image/png','image/webp','application/pdf'];
  if (!allowed.includes(mediaType)) return res.status(400).json({ error: 'Tipo no soportado' });

  try {
    const content = mediaType === 'application/pdf'
      ? [{ type:'document', source:{ type:'base64', media_type:'application/pdf', data:file }}, { type:'text', text:'Analiza este examen médico.' }]
      : [{ type:'image', source:{ type:'base64', media_type:mediaType, data:file }}, { type:'text', text:'Analiza este examen médico.' }];

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [{ role:'user', content }]
    });

    const fullText = response.content[0].text.trim();
    console.log('RAW RESPONSE:', fullText.substring(0, 200));

    const separatorIndex = fullText.indexOf('|||VISUAL|||');
    
    let interpretation = null;
    let visual = null;

    if (separatorIndex !== -1) {
      const block1 = fullText.substring(0, separatorIndex).trim();
      const block2 = fullText.substring(separatorIndex + 12).trim();

      try {
        const j1 = block1.replace(/```json|```/g,'').trim();
        interpretation = JSON.parse(j1);
      } catch(e) {
        console.error('Error parseando bloque 1:', e.message);
        const start = block1.indexOf('{');
        const end = block1.lastIndexOf('}');
        if (start !== -1 && end !== -1) {
          try { interpretation = JSON.parse(block1.slice(start, end+1)); } catch(e2) {}
        }
      }

      try {
        const j2 = block2.replace(/```json|```/g,'').trim();
        visual = JSON.parse(j2);
      } catch(e) {
        const start = block2.indexOf('{');
        const end = block2.lastIndexOf('}');
        if (start !== -1 && end !== -1) {
          try { visual = JSON.parse(block2.slice(start, end+1)); } catch(e2) {}
        }
        if (!visual) visual = { scenario:'hematologico', detected_scenarios:['hematologico'] };
      }
    } else {
      console.error('No se encontró separador |||VISUAL||| en la respuesta');
      const start = fullText.indexOf('{');
      const end = fullText.lastIndexOf('}');
      if (start !== -1 && end !== -1) {
        try { interpretation = JSON.parse(fullText.slice(start, end+1)); } catch(e) {}
      }
      visual = { scenario:'hematologico', detected_scenarios:['hematologico'] };
    }

    if (!interpretation) {
      interpretation = { resumen: 'No se pudo procesar el examen correctamente.', secciones: [], preguntas: [] };
    }

    res.json({ interpretation, visual, success: true });

  } catch(err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: 'No se pudo procesar el examen.' });
  }
});

app.get('/health', (req, res) => res.json({ status:'ok', service:'ExamIA Backend' }));
app.listen(PORT, () => console.log(`ExamIA backend corriendo en puerto ${PORT}`));
