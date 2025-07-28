import express from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import cors from 'cors';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { AbortController } from 'node-abort-controller'; // Importar AbortController para controla el tiempo que espera al servidor D-ID

dotenv.config();

// --- CONFIGURACIÓN INICIAL ---
const app = express();
const port = 3000;
app.use(cors());

// Reemplazamos esta linea con las siguientes, para aumentar límite
//app.use(express.json());
 //Aumentamos el límite de express para aceptar datos
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// --- SERVIR ARCHIVOS ESTÁTICOS ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'public')));

// --- CONFIGURACIÓN DE APIS ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }); //gemini-1.5-pro-latest
const DID_API_URL = 'https://api.d-id.com';

// --- LÓGICA DE AUTENTICACIÓN (BASADO EN GITHUB DEMO - SIN CODIFICAR) Repositorio de ejemplo de D-ID---
// Leemos la clave directamente del .env y la usamos en texto plano.
const apiKey = process.env.DID_API_KEY;

// --- FUNCIÓN AUXILIAR PARA CONVERTIR ARCHIVO A FORMATO GEMINI ---
function fileToGenerativePart(path, mimeType) {
  return {
    inlineData: {
      data: Buffer.from(fs.readFileSync(path)).toString("base64"),
      mimeType
    },
  };
}

// Pre-cargamos el PDF una sola vez al iniciar el servidor
// Así no tendrá que ir siempre al disco cada vez que genere una respuesta
// Mejoramos así un poco la velocidad de respuesta y experiencia con el usuario
const pdfPath = path.join(__dirname, 'knowledge', 'guia_app.pdf');
const knowledgeBase = fileToGenerativePart(pdfPath, "application/pdf");
console.log('Base de conocimiento (PDF) cargada en memoria.');


// Función para mejorar el tiempo de espera al servidor D-ID
async function fetchWithTimeout(url, options, timeout = 30000) { // Timeout de 30 segundos
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        return response;
    } finally {
        clearTimeout(timeoutId);
    }
}

// --- RUTAS DE LA API ---

// 1. CHAT CON GEMINI
app.post('/api/chat', async (req, res) => {
    try {
        // Ahora recibimos un historial y un objeto de mensaje que puede contener imágenes
        const { history, message } = req.body;

        const system_prompt = `
            **Rol y Personalidad:** Tu nombre es Alex y eres un agente de soporte de la aplicación GrantsWin. Tu tono debe ser siempre amable, directo y muy breve.

            **Tarea Principal:** Tu tarea es responder a las preguntas de los usuarios sobre el funcionamiento de la aplicación GrantsWin.
            
            **Capacidades:**
            1.  **Conocimiento Base:** Puedes responder preguntas basándote en el contenido del documento PDF que conoces.
            2.  **Guía Visual:** Si el usuario te envía una imagen de la pantalla, tu tarea principal es analizar esa imagen y guiarle. Describe brevemente el botón o elemento en el que debe hacer clic. Sé muy específico. Por ejemplo: "Para encontrar convocatorias, haz clic en el botón verde que dice 'I want calls'".
        
            **Reglas Cruciales:**
            -   Nunca menciones que estás basándote en un documento PDF o en una imagen. Actúa como si lo supieras todo de forma natural.
            -   Si no puedes identificar la acción en la imagen, pide amablemente que te muestre otra parte de la aplicación.
            -   Si te preguntan sobre ti (quién eres, etc.), simplemente responde "Soy Alex, un agente de soporte de GrantsWin." y vuelve a centrarte en cómo puedes ayudar con la aplicación.
            `;

        const final_prompt = [system_prompt, knowledgeBase, ...message.parts];

        // Configura las cabeceras para una respuesta de streaming
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Transfer-Encoding', 'chunked');

        // Inicia el chat y genera el contenido como un stream
        const chat = geminiModel.startChat({ history: history || [] });
        const result = await chat.sendMessageStream(final_prompt);

        // Envía cada trozo de texto al cliente en cuanto se recibe
        for await (const chunk of result.stream) {
            res.write(chunk.text());
        }

        // Finaliza la respuesta cuando el stream se completa
        res.end();

    } catch (error) {
        console.error('Error en el chat con Gemini (stream):', error);
        res.end('Error: No se pudo procesar la respuesta.');
    }
});

// 2. RUTAS DE D-ID
app.post('/api/d-id/create-stream', async (req, res) => {
    try {
        const response = await fetchWithTimeout(`${DID_API_URL}/talks/streams`, {
            method: 'POST',
            // Usamos la clave en texto plano directamente
            headers: { 'Authorization': `Basic ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ source_url: "https://create-images-results.d-id.com/DefaultPresenters/Gordon_m/v2_with_background_image.jpg",
                config: {
                    stitch: true,
                }
             }),
        });
        const data = await response.json();
        if (!response.ok) {
            console.error('Respuesta de error de D-ID:', data);
            throw new Error(data.description || data.message || 'Error desconocido de D-ID');
        }
        res.status(200).json(data);
    } catch (error) {
        console.error("Error en /api/d-id/create-stream:", error);
        res.status(500).json({ error: error.message });
    }
});

// (El resto de las rutas de D-ID usarán la misma variable 'apiKey')
app.post('/api/d-id/talk-stream', async (req, res) => {
    const { stream_id, session_id, text, type } = req.body;
    try {
        // Preparamos el objeto base para el 'script'
        const scriptObject = {
            type: type || 'text',
            input: text,
        };

        // **Añadimos el proveedor SOLO si el tipo es 'text'**
        if (scriptObject.type === 'text') {
            scriptObject.provider = {
                type: 'microsoft',
                voice_id: 'es-ES-ArnauNeural'
            };
        }

        const response = await fetchWithTimeout(`${DID_API_URL}/talks/streams/${stream_id}`, {
            method: 'POST',
            headers: { 'Authorization': `Basic ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                script: scriptObject, // Usamos nuestro objeto dinámico
                config: {
                  fluent: 'true',
                  pad_audio: '0.0'
                },
                session_id: session_id
              }),
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.description || 'Error al enviar texto al stream');
        res.status(200).json(data);
    } catch (error) {
        console.error("Error en /api/d-id/talk-stream:", error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/d-id/start-stream', async (req, res) => {
    const { stream_id, session_id, answer } = req.body;
    try {
        const response = await fetchWithTimeout(`${DID_API_URL}/talks/streams/${stream_id}/sdp`, {
            method: 'POST',
            headers: { 'Authorization': `Basic ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ answer: answer, session_id: session_id }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.description || 'Error al iniciar stream');
        res.status(200).json(data);
    } catch (error) {
        console.error("Error en /api/d-id/start-stream:", error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/d-id/close-stream', async (req, res) => {
    const { stream_id, session_id } = req.body;
    try {
        await fetchWithTimeout(`${DID_API_URL}/talks/streams/${stream_id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Basic ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: session_id }),
        });
        res.status(200).json({ message: 'Stream cerrado' });
    } catch (error) {
        console.error("Error en /api/d-id/close-stream:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- INICIAR SERVIDOR ---
app.listen(port, () => {
    console.log(`Servidor escuchando en http://localhost:${port}`);
});