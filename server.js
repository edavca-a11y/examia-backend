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
  const { file, mediaType, userId } = req.body;
  if (!file || !mediaType) return res.status(400).json({ error: 'Falta archivo' });

  const allowed = ['image/jpeg','image/jpg','image/png','image/webp','application/pdf'];
  if (!allowed.includes(mediaType)) return res.status(400).json({ error: 'Tipo no soportado' });

  // Verificar límite plan gratuito
  if (userId) {
    try {
      const { createClient } = require('@supabase/supabase-js');
      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const { data: profile } = await sb.from('profiles').select('plan, analisis_mes, mes_reset').eq('id', userId).single();
      if (profile && profile.plan === 'gratis') {
        const hoy = new Date();
        const mesReset = profile.mes_reset ? new Date(profile.mes_reset) : null;
        let analisisMes = profile.analisis_mes || 0;
        if (!mesReset || hoy.getMonth() !== mesReset.getMonth() || hoy.getFullYear() !== mesReset.getFullYear()) {
          analisisMes = 0;
          await sb.from('profiles').update({ analisis_mes: 0, mes_reset: hoy.toISOString().split('T')[0] }).eq('id', userId);
        }
        if (analisisMes >= 5) return res.status(403).json({ error: 'limite_alcanzado', mensaje: 'Alcanzaste el límite de 5 análisis gratuitos este mes.' });
        await sb.from('profiles').update({ analisis_mes: analisisMes + 1 }).eq('id', userId);
      }
    } catch(e) { console.error('Error verificando límite:', e.message); }
  }

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

// ── PLANES ────────────────────────────────────────────────────────────────────
const PLANES = {
  individual: { nombre: 'Plan Individual ExamIA', precio: 3990, moneda: 'CLP' },
  familiar:   { nombre: 'Plan Familiar ExamIA',   precio: 6990, moneda: 'CLP' }
};

// Crear preferencia de pago con Checkout Pro
app.post('/crear-suscripcion', async (req, res) => {
  const { plan, userId, userEmail } = req.body;
  if (!plan || !userId || !userEmail) return res.status(400).json({ error: 'Faltan datos' });
  if (!PLANES[plan]) return res.status(400).json({ error: 'Plan no válido' });

  try {
    const planInfo = PLANES[plan];
    const backUrl = process.env.FRONTEND_URL !== '*' ? process.env.FRONTEND_URL : 'https://comfy-otter-023493.netlify.app';

    const response = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`
      },
      body: JSON.stringify({
        items: [{
          title: planInfo.nombre,
          quantity: 1,
          unit_price: planInfo.precio,
          currency_id: 'CLP'
        }],
        payer: { email: userEmail },
        back_urls: {
          success: `${backUrl}?pago=exitoso&plan=${plan}&user=${userId}`,
          failure: `${backUrl}?pago=fallido`,
          pending: `${backUrl}?pago=pendiente`
        },
        auto_return: 'approved',
        external_reference: `${userId}|${plan}`,
        notification_url: 'https://examia-backend.onrender.com/webhook-mp'
      })
    });

    const data = await response.json();
    console.log('MP preference response:', JSON.stringify(data).substring(0, 200));

    if (data.init_point) {
      res.json({ init_point: data.init_point, id: data.id });
    } else {
      console.error('MP error:', JSON.stringify(data));
      res.status(500).json({ error: 'No se pudo crear el pago', detalle: data.message || 'Error desconocido' });
    }
  } catch(err) {
    console.error('Error MP:', err.message);
    res.status(500).json({ error: 'Error al conectar con Mercado Pago' });
  }
});

// Webhook de Mercado Pago
app.post('/webhook-mp', async (req, res) => {
  const { type, data } = req.body;
  console.log('Webhook MP:', type, data?.id);

  if (type === 'payment' && data?.id) {
    try {
      const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${data.id}`, {
        headers: { 'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}` }
      });
      const payment = await mpRes.json();
      console.log('Payment status:', payment.status, 'ref:', payment.external_reference);

      if (payment.status === 'approved' && payment.external_reference) {
        const [userId, plan] = payment.external_reference.split('|');
        const { createClient } = require('@supabase/supabase-js');
        const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
        await sb.from('profiles').update({ plan }).eq('id', userId);
        await sb.from('suscripciones').upsert({
          user_id: userId, plan, estado: 'activo',
          mp_preapproval_id: String(data.id),
          fecha_inicio: new Date().toISOString()
        }, { onConflict: 'user_id' });
        console.log(`Plan ${plan} activado para usuario ${userId}`);
      }
    } catch(err) {
      console.error('Webhook error:', err.message);
    }
  }
  res.sendStatus(200);
});

// Verificar plan del usuario
app.get('/plan/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const { createClient } = require('@supabase/supabase-js');
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data } = await sb.from('profiles').select('plan, analisis_mes, mes_reset').eq('id', userId).single();
    res.json(data || { plan: 'gratis', analisis_mes: 0 });
  } catch(err) {
    res.json({ plan: 'gratis', analisis_mes: 0 });
  }
});

app.get('/health', (req, res) => res.json({ status:'ok', service:'ExamIA Backend' }));
app.listen(PORT, () => console.log(`ExamIA backend corriendo en puerto ${PORT}`));
