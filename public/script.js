document.addEventListener('DOMContentLoaded', () => {
    // --- Referencias a elementos del DOM ---
    const avatarContainer = document.getElementById('avatar-container');
    const chatContainer = document.getElementById('chat-container');
    const chatLog = document.getElementById('chat-log');
    const chatInput = document.getElementById('chat-input');
    const sendBtn = document.getElementById('send-btn');
    const micBtn = document.getElementById('mic-btn');
    const shareScreenBtn = document.getElementById('share-screen-btn'); // Compartir pantalla
    const videoElement = document.getElementById('avatar-video');
    const statusDiv = document.getElementById('status');
    const SERVER_URL = 'http://localhost:3000';
    
    // --- 2. VARIABLES DE ESTADO ---
    let rtcPeerConnection;
    let streamId;
    let sessionId;
    let conversationHistory = [];
    // Variables compartir pantalla
    let screenStream = null;
    let screenVideoElement = document.createElement('video');
    let canvasElement = document.createElement('canvas');
    
    // --- 3. DEFINICIÓN DE FUNCIONES PRINCIPALES ---
    const updateStatus = (message) => {
        statusDiv.textContent = message;
    };
    
    const connectToDID = () => {
        if (rtcPeerConnection && rtcPeerConnection.connectionState === 'connected') {
            return Promise.resolve();
        }
        updateStatus('Conectando...');
    
        // Envolvemos toda la lógica en una Promesa para controlar el resultado
        return new Promise(async (resolve, reject) => {
            try {
                // Timeout para evitar que se quede esperando indefinidamente
                const connectionTimeout = setTimeout(() => {
                    reject(new Error('Tiempo de espera para la conexión agotado.'));
                }, 15000); // 15 segundos
    
                const sessionResponse = await fetch(`${SERVER_URL}/api/d-id/create-stream`, { method: 'POST' });
                const sessionData = await sessionResponse.json();
                if (!sessionResponse.ok) {
                    throw new Error(sessionData.message || sessionData.description || 'Error al crear el stream desde el servidor.');
                }
                
                streamId = sessionData.id;
                sessionId = sessionData.session_id;
                
                rtcPeerConnection = new RTCPeerConnection({ iceServers: sessionData.ice_servers });
    
                // CLAVE: Escuchamos el cambio de estado de la conexión
                rtcPeerConnection.onconnectionstatechange = () => {
                    if (rtcPeerConnection.connectionState === 'connected') {
                        clearTimeout(connectionTimeout); // Anulamos el timeout
                        updateStatus('Conectado');
                        resolve(); // ¡La promesa se resuelve con éxito!
                    } else if (['failed', 'closed', 'disconnected'].includes(rtcPeerConnection.connectionState)) {
                        clearTimeout(connectionTimeout);
    
                        reject(new Error(`La conexión falló o se cerró. Estado: ${rtcPeerConnection.connectionState}`));
                    }
                };
                
                rtcPeerConnection.ontrack = (event) => {
                    if (videoElement.srcObject !== event.streams[0]) {
                        videoElement.srcObject = event.streams[0];
                        videoElement.play().catch(e => console.error("Error al intentar reproducir vídeo:", e));
                    }
                };
                
                await rtcPeerConnection.setRemoteDescription(sessionData.offer);
                const answer = await rtcPeerConnection.createAnswer();
                await rtcPeerConnection.setLocalDescription(answer);
                
                await fetch(`${SERVER_URL}/api/d-id/start-stream`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ stream_id: streamId, session_id: sessionId, answer }),
                });
    
            } catch (error) {
                console.error('Fallo crítico en la conexión con D-ID:', error);
                updateStatus(`Error: ${error.message}`);
                reject(error); // La promesa falla
            }
        });
    };
    
    const talkToDID = async (text, type = 'text') => {
        // 1. Comprobamos si la conexión está activa
        if (!rtcPeerConnection || rtcPeerConnection.connectionState !== 'connected') {
            console.log('Conexión perdida. Intentando reconectar...');
            updateStatus('Reconectando...');
            try {
                // 2. Llamamos a connectToDID y esperamos a que la promesa se resuelva (o falle)
                await connectToDID();
            } catch (error) {
                console.error('La reconexión falló:', error.message);
                updateStatus('Error de conexión.');
                return; // Abortamos la función si la reconexión no tuvo éxito
            }
        }
    
        // 3. Si la conexión está bien (o la reconexión fue exitosa), hablamos
        videoElement.muted = false;
        await fetch(`${SERVER_URL}/api/d-id/talk-stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stream_id: streamId, session_id: sessionId, text, type }),
        });
    };
    
    const appendMessage = (text, classNames) => {
        const messageDiv = document.createElement('div');
        messageDiv.classList.add('message');
        classNames.split(' ').forEach(cls => {
            if (cls) messageDiv.classList.add(cls);
        });
        messageDiv.innerText = text;
        chatLog.appendChild(messageDiv);
        chatLog.scrollTop = chatLog.scrollHeight;
        return messageDiv;
    };
    
    const sendMessage = async () => {
        const userMessageText = chatInput.value.trim();
        if (userMessageText === '') return;
    
        appendMessage(userMessageText, 'user-message');
        chatInput.value = '';
        conversationHistory.push({ role: 'user', parts: [{ text: userMessageText }] });
        const botMessageElement = appendMessage('', 'bot-message thinking');
    
        // --- LÓGICA DE CAPTURA DE PANTALLA ---
        let image_parts = [];
        if (screenStream && screenStream.active) {
            try {
                // Dibuja el frame actual del vídeo de la pantalla en un canvas
                const track = screenVideoElement.srcObject.getVideoTracks()[0];
                const settings = track.getSettings();
                canvasElement.width = settings.width;
                canvasElement.height = settings.height;
                const context = canvasElement.getContext('2d');
                context.drawImage(screenVideoElement, 0, 0, settings.width, settings.height);
                
                // Convierte el canvas a una imagen en base64
                const base64Image = canvasElement.toDataURL('image/jpeg', 0.7); // 70% de calidad
    
                // Prepara la parte de la imagen para la API
                image_parts.push({
                    inline_data: {
                        mime_type: 'image/jpeg',
                        data: base64Image.split(',')[1] // Quitamos el prefijo 'data:image/jpeg;base64,'
                    }
                });
    
            } catch (error) {
                console.error('Error capturando el frame:', error);
                // Opcional: informar al usuario en el chat.
            }
        }
        // --- FIN LÓGICA DE CAPTURA ---
    
        try {
            // Unimos el texto del usuario con las partes de la imagen
            const messagePayload = {
                role: 'user',
                parts: [{ text: userMessageText }, ...image_parts]
            };
    
            const response = await fetch(`${SERVER_URL}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // Enviamos el historial y el nuevo mensaje (que puede contener imagen)
                body: JSON.stringify({
                    history: conversationHistory.slice(0, -1),
                    message: messagePayload
                }),
            });
    
            if (!response.ok || !response.body) {
                throw new Error('La respuesta del servidor no es válida.');
            }
    
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let completeResponse = '';
            botMessageElement.classList.remove('thinking');
    
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
    
                const chunkText = decoder.decode(value);
                completeResponse += chunkText;
                botMessageElement.innerText = completeResponse;
                chatLog.scrollTop = chatLog.scrollHeight;
            }
    
            if (completeResponse) {
                conversationHistory.push({ role: 'model', parts: [{ text: completeResponse }] });
                await talkToDID(completeResponse);

                // Si el modo conversación está activo, reactivamos el micro (Hasta pulsar botón micro)
                if (conversationMode && !isListening) {
                    console.log('Modo conversación: Reactivando escucha tras respuesta.');
                    recognition.start();
                }
            }
    
        } catch (error) {
            botMessageElement.classList.remove('thinking');
            console.error('Error al obtener respuesta de Gemini (stream):', error);
            botMessageElement.innerText = 'Lo siento, hubo un error al procesar la respuesta.';
            // Eliminamos el mensaje del usuario del historial si hubo un error
            conversationHistory.pop();
        }
    };
    
    // --- 4. EVENT LISTENERS E INICIALIZACIÓN ---

    // Lógica para compartir pantalla
    const handleScreenShare = async () => {
        if (screenStream && screenStream.active) {
            // Si ya se está compartiendo, detenemos
            screenStream.getTracks().forEach(track => track.stop());
            screenStream = null;
            screenVideoElement.srcObject = null;
            shareScreenBtn.classList.remove('active');
            shareScreenBtn.title = 'Compartir Pantalla';
            appendMessage('Has dejado de compartir la pantalla.', 'bot-message');

        } else {
            // Si no, iniciamos
            try {
                screenStream = await navigator.mediaDevices.getDisplayMedia({
                    video: { cursor: "always" },
                    audio: false
                });
                screenVideoElement.srcObject = screenStream;
                screenVideoElement.play(); // Es necesario para que los frames se actualicen
                shareScreenBtn.classList.add('active');
                shareScreenBtn.title = 'Dejar de Compartir';
                appendMessage('¡Estás compartiendo tu pantalla! Ahora puedes hacerme preguntas sobre lo que ves.', 'bot-message');

                // Escuchar cuando el usuario detiene la compartición desde el navegador
                screenStream.getVideoTracks()[0].addEventListener('ended', () => {
                    shareScreenBtn.classList.remove('active');
                    shareScreenBtn.title = 'Compartir Pantalla';
                    screenStream = null;
                    appendMessage('Has dejado de compartir la pantalla.', 'bot-message');
                });

            } catch (err) {
                console.error("Error al compartir pantalla:", err);
                appendMessage('No se pudo iniciar la compartición de pantalla.', 'bot-message');
            }
        }
    };

    shareScreenBtn.addEventListener('click', handleScreenShare);
    
    // El clic en el avatar oculta/muestra el chat
    avatarContainer.addEventListener('click', () => {
        chatContainer.classList.toggle('visible');
        if (chatContainer.classList.contains('visible')) {
            chatInput.focus();
        }
    });
    
    sendBtn.addEventListener('click', sendMessage);
    chatInput.addEventListener('keypress', (e) => e.key === 'Enter' && sendMessage());
    
    // Lógica del micrófono (Speech Recognition)
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    let recognition;
    let isListening = false; // Estado para saber si el micro está activo en general
    let silenceTimer; // Temporizador para detectar el fin de la frase
    let conversationMode = false; // ¡NUEVO! Estado para mantener la conversación activa

    if (SpeechRecognition) {
        recognition = new SpeechRecognition();
        recognition.lang = 'es-ES';
        recognition.continuous = true; // Es importante para que no se pare solo
        recognition.interimResults = true;

        micBtn.addEventListener('click', () => {
            if (conversationMode) {
                // Si el modo conversación está activo, lo paramos
                conversationMode = false;
                recognition.stop();
                updateStatus('Haz clic para iniciar'); // Opcional: actualiza el estado
                appendMessage('Modo conversación desactivado.', 'bot-message');
            } else {
                // Si no, lo iniciamos
                conversationMode = true;
                recognition.start();
                appendMessage('Modo conversación activado. Habla cuando quieras.', 'bot-message');
            }
        });

        recognition.onstart = () => {
            isListening = true;
            micBtn.classList.add('is-listening');
            chatInput.placeholder = 'Escuchando...';
            updateStatus('Escuchando...');
        };

        recognition.onend = () => {
            isListening = false;
            micBtn.classList.remove('is-listening');
            chatInput.placeholder = 'Escribe tu mensaje...';

            // ¡CLAVE! Si el modo conversación sigue activo, reiniciamos el reconocimiento.
            // Esto puede pasar si hay un silencio largo o un error de red.
            if (conversationMode) {
                console.log("Re-iniciando reconocimiento por fin inesperado...");
                recognition.start();
            } else {
                updateStatus('Haz clic para iniciar');
            }
        };

        recognition.onresult = (event) => {
            clearTimeout(silenceTimer); // Reseteamos el temporizador con cada nuevo resultado

            let final_transcript = '';
            for (let i = event.resultIndex; i < event.results.length; ++i) {
                if (event.results[i].isFinal) {
                    final_transcript += event.results[i][0].transcript;
                }
            }

            // Solo actuamos si hay un texto final reconocido
            if (final_transcript.trim()) {
                chatInput.value = final_transcript.trim();

                // CLAVE: iniciamos un temporizador. Si no hay más voz en 1.5 segundos, enviamos.
                silenceTimer = setTimeout(() => {
                    if (chatInput.value.trim() !== '') {
                        sendMessage(); // ¡Se envía el mensaje automáticamente!
                    }
                }, 1500); // 1.5 segundos de silencio para enviar
            }
        };

        recognition.onerror = (e) => {
            console.error('Error de reconocimiento de voz:', e.error);
            // Si el error no es 'no-speech', podríamos querer parar el modo conversación.
            if (e.error !== 'no-speech') {
                conversationMode = false;
            }
        };

    } else {
        micBtn.style.display = 'none';
    }
    /*
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
        const recognition = new SpeechRecognition();
        recognition.lang = 'es-ES';
        recognition.interimResults = false;
        micBtn.addEventListener('click', () => {
            micBtn.classList.add('is-listening');
            recognition.start();
        });
        recognition.onresult = (event) => chatInput.value = event.results[0][0].transcript;
        recognition.onend = () => {
            micBtn.classList.remove('is-listening');
            sendMessage();
        };
        recognition.onerror = (e) => {
            console.error('Error de voz:', e.error);
            micBtn.classList.remove('is-listening');
        };
    } else {
        micBtn.style.display = 'none';
    }*/
    
    // Cerrar la conexión al salir de la página
    window.addEventListener('beforeunload', () => {
        if (streamId && sessionId) {
            const data = JSON.stringify({ stream_id: streamId, session_id: sessionId });
            navigator.sendBeacon(`${SERVER_URL}/api/d-id/close-stream`, new Blob([data], { type: 'application/json' }));
        }
    });
    // Inicia la aplicación al cargar la página
    const initializeApp = () => {
        avatarContainer.classList.add('expanded'); // Expande el avatar
        connectToDID();                         // Inicia la conexión
    };

    initializeApp();

});